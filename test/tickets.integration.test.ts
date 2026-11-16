/**
 * Tickets (spec 15.2) against a real Postgres (TEST_DATABASE_URL): the holder's own tickets with their QR text and door
 * code (404 for anyone else), reissue (the old QR and code die, limits, replay), guest-list tickets, void, the attendee
 * list, the read allowance, that no token or code is ever logged, and the route handlers' headers.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type TestActor, cleanup, fillRate, makeUser, op, openDoorInput } from "./helpers";

// The route handlers read the session through this module; the data layer never does.
let sessionUser: (TestActor & { name: string; email: string }) | null = null;
vi.mock("@/lib/auth/session", async () => {
  const rbac = await import("@/lib/auth/rbac");
  const requireUser = async () => {
    if (!sessionUser) throw new rbac.UnauthorizedError();
    return sessionUser;
  };
  return {
    requireUser,
    requireRole: async (role: string) => {
      const u = await requireUser();
      if (role !== "user" && u.role !== role) throw new rbac.ForbiddenError();
      return u;
    },
  };
});

const url = process.env.TEST_DATABASE_URL;
const P = "tk";

describe.skipIf(!url)("tickets (Postgres)", () => {
  let sql: postgres.Sql;
  let org: TestActor;
  let org2: TestActor;
  let admin: TestActor;
  let EV: typeof import("@/lib/events");
  let TT: typeof import("@/lib/ticket-types");
  let RG: typeof import("@/lib/registrations");
  let TK: typeof import("@/lib/tickets");
  let AD: typeof import("@/lib/admin");
  let TOK: typeof import("@/lib/tickets/token");
  let n = 0;

  const newUser = (name = `u${++n}`) => makeUser(sql, P, name, "user");
  const reg = (typeId: string, quantity = 1) => ({ ticketTypeId: typeId, quantity, clientOpId: crypto.randomUUID() });
  const mk = async (capacity = 10, o: Record<string, unknown> = {}, who?: TestActor) => {
    who ??= await makeUser(sql, P, `own${++n}`, "organizer");
    const e = (await EV.createEvent(who, openDoorInput(o))).event;
    const { ticketType } = await TT.createTicketType(who, e.id, { name: "General", capacity, clientOpId: crypto.randomUUID() });
    const pub = await EV.updateEvent(who, e.id, { version: 1, status: "published" });
    return { id: e.id, typeId: ticketType.id, version: pub.version, owner: who };
  };
  const issued = async (typeId: string) => (await sql`select issued from ticket_type where id = ${typeId}`)[0].issued as number;
  const row = async (id: string) => (await sql`select * from ticket where id = ${id}`)[0];
  const reads = async (id: string) => (await sql`select count(*)::int as n from rate_event where user_id = ${id} and kind = 'api_read'`)[0].n as number;
  const writes = async (id: string) => (await sql`select count(*)::int as n from rate_event where user_id = ${id} and kind = 'api_write'`)[0].n as number;
  /** What the door (15.3) decides from a scanned QR: the MAC, then the database. */
  const doorAccepts = async (qrText: string, eventId: string) => {
    const v = TOK.verifyTicketToken(qrText);
    if (!v) return false;
    const r = await sql`select 1 from ticket where id = ${v.ticketId} and event_id = ${eventId} and status = 'valid' and qr_epoch = ${v.epoch}`;
    return r.length === 1;
  };
  /** The same for a typed code: the keyed digest, per event. */
  const doorAcceptsCode = async (typed: string, eventId: string) => {
    const code = TOK.normalizeDoorCode(typed);
    if (!code) return false;
    const r = await sql`select 1 from ticket where event_id = ${eventId} and door_code_digest = ${TOK.doorCodeDigest(code)} and status = 'valid'`;
    return r.length === 1;
  };
  /** A registered attendee with one ticket. */
  const holder = async (e: { id: string; typeId: string }, quantity = 1) => {
    const u = await newUser();
    const r = await RG.registerForEvent(u, e.id, reg(e.typeId, quantity));
    return { u, r, t: r.tickets[0].id };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DB_POOL_MAX = "20";
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    sql = postgres(url!, { max: 6, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup(sql, P);
    org = await makeUser(sql, P, "org", "organizer");
    org2 = await makeUser(sql, P, "org2", "organizer");
    admin = await makeUser(sql, P, "admin", "admin");
    EV = await import("@/lib/events");
    TT = await import("@/lib/ticket-types");
    RG = await import("@/lib/registrations");
    TK = await import("@/lib/tickets");
    AD = await import("@/lib/admin");
    TOK = await import("@/lib/tickets/token");
  });

  afterAll(async () => {
    await cleanup(sql, P);
    await sql.end();
  });

  afterEach(() => {
    sessionUser = null;
    vi.restoreAllMocks();
  });

  describe("the holder's own tickets", () => {
    it("shows the QR text and door code for the holder: the QR verifies, the code finds the ticket by its keyed digest", async () => {
      const e = await mk();
      const { u, t } = await holder(e, 2);
      const mine = await TK.getMyTicket(u, t);
      expect(mine.qrText).toMatch(/^ET1:[0-9A-HJKMNP-TV-Z]{56}$/);
      expect(mine.doorCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
      expect(TOK.verifyTicketToken(mine.qrText!)).toEqual({ ticketId: t, epoch: 1 });
      expect(await doorAccepts(mine.qrText!, e.id)).toBe(true);
      expect(await doorAcceptsCode(mine.doorCode!.toLowerCase().replace("-", " "), e.id)).toBe(true);
      expect(Buffer.from((await row(t)).door_code_digest).equals(TOK.doorCodeDigest(TOK.normalizeDoorCode(mine.doorCode)!))).toBe(true);
      // Stable across reads: the attendee sees the same QR any time.
      expect((await TK.getMyTicket(u, t)).qrText).toBe(mine.qrText);
      expect(mine).toMatchObject({ id: t, status: "valid", ticketTypeName: "General", event: { id: e.id, status: "published" }, registrationStatus: "active" });
      // The QR is for THIS event only: another event's door doesn't take it.
      const other = await mk();
      expect(await doorAccepts(mine.qrText!, other.id)).toBe(false);
      expect(await doorAcceptsCode(mine.doorCode!, other.id)).toBe(false);
    });

    it("anyone but the holder gets 404 (another attendee, the organiser, another organiser), an admin 403, a missing or malformed id 404 or 400", async () => {
      const e = await mk();
      const { t } = await holder(e);
      const stranger = await newUser();
      for (const who of [stranger, e.owner, org2]) await expect(TK.getMyTicket(who, t), who.id).rejects.toMatchObject({ status: 404 });
      await expect(TK.getMyTicket(admin, t)).rejects.toMatchObject({ status: 403 });
      await expect(TK.getMyTicket(null, t)).rejects.toMatchObject({ name: "UnauthorizedError" });
      await expect(TK.getMyTicket(stranger, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
      await expect(TK.getMyTicket(stranger, "nope")).rejects.toMatchObject({ name: "ZodError" });
      await expect(TK.getMyTicket(stranger, `${t}\0`)).rejects.toMatchObject({ name: "ZodError" });
      // A guest-list ticket has no holder: nobody can read it through this door, the organiser included.
      const g = await TK.addGuests(e.owner, e.id, { ticketTypeId: e.typeId, guests: [{ name: "Guest" }], clientOpId: crypto.randomUUID() });
      await expect(TK.getMyTicket(e.owner, g.tickets[0].id)).rejects.toMatchObject({ status: 404 });
    });

    it("the list has only my tickets and never a QR text or a door code", async () => {
      const e = await mk();
      const { u } = await holder(e, 3);
      const { u: other } = await holder(e);
      const list = await TK.listMyTickets(u);
      expect(list.tickets).toHaveLength(3);
      expect(list.tickets.map((t) => t.holderName.split(",")[0]).every((x) => x === (list.tickets[0].holderName.split(",")[0]))).toBe(true);
      const json = JSON.stringify(list);
      expect(json).not.toContain("ET1:");
      expect(json).not.toMatch(/qrText|doorCode|door_code|doorCodeDigest/);
      expect((await TK.listMyTickets(other)).tickets).toHaveLength(1);
      await expect(TK.listMyTickets(admin)).rejects.toMatchObject({ status: 403 });
      expect((await TK.listMyTickets(await newUser())).tickets).toEqual([]);
    });

    it("a cancelled ticket shows no QR text and no door code", async () => {
      const e = await mk();
      const { u, r, t } = await holder(e);
      await RG.cancelRegistration(u, r.registration.id, op());
      const mine = await TK.getMyTicket(u, t);
      expect(mine).toMatchObject({ status: "cancelled", qrText: null, doorCode: null, registrationStatus: "cancelled" });
    });

    it("reads spend api_read, refused reads included, and are 429 over the allowance", async () => {
      const e = await mk();
      const { u, t } = await holder(e);
      const before = await reads(u.id);
      await TK.getMyTicket(u, t);
      await TK.listMyTickets(u);
      await expect(TK.getMyTicket(u, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
      await expect(TK.getMyTicket(u, "nope")).rejects.toBeTruthy();
      expect(await reads(u.id)).toBe(before + 4);
      await fillRate(sql, u.id, 1200, "api_read");
      await expect(TK.getMyTicket(u, t)).rejects.toMatchObject({ status: 429 });
      await expect(TK.listMyTickets(u)).rejects.toMatchObject({ status: 429 });
      await fillRate(sql, org.id, 1200, "api_read");
      await expect(TK.listAttendees(org, e.id)).rejects.toMatchObject({ status: 429 });
    });
  });

  describe("reissue", () => {
    it("the holder gets a new QR text and door code, qr_epoch goes up, the digest is rewritten, and the old QR and code answer invalid", async () => {
      const e = await mk();
      const { u, t } = await holder(e);
      const old = await TK.getMyTicket(u, t);
      const oldDigest = Buffer.from((await row(t)).door_code_digest);
      const out = await TK.reissueMyTicket(u, t, op());
      expect(out.replayed).toBe(false);
      expect(out.ticket.qrText).not.toBe(old.qrText);
      expect(out.ticket.doorCode).not.toBe(old.doorCode);
      expect(out.ticket.qrEpoch).toBe(2);
      const after = await row(t);
      expect(after.qr_epoch).toBe(2);
      expect(Buffer.from(after.door_code_digest).equals(oldDigest)).toBe(false);
      expect(Buffer.from(after.door_code_digest).equals(TOK.doorFor(t, 2).digest)).toBe(true);
      expect(TOK.verifyTicketToken(out.ticket.qrText!)).toEqual({ ticketId: t, epoch: 2 });
      expect(await doorAccepts(out.ticket.qrText!, e.id)).toBe(true);
      expect(await doorAcceptsCode(out.ticket.doorCode!, e.id)).toBe(true);
      // The old ones still carry a valid MAC, so only the database's epoch and digest kill them.
      expect(TOK.verifyTicketToken(old.qrText!)).toEqual({ ticketId: t, epoch: 1 });
      expect(await doorAccepts(old.qrText!, e.id)).toBe(false);
      expect(await doorAcceptsCode(old.doorCode!, e.id)).toBe(false);
      expect((await TK.getMyTicket(u, t)).qrText).toBe(out.ticket.qrText);
    });

    it("a retry with the same op id returns the current ticket and burns no second reissue", async () => {
      const e = await mk();
      const { u, t } = await holder(e);
      const body = op();
      const a = await TK.reissueMyTicket(u, t, body);
      const b = await TK.reissueMyTicket(u, t, body);
      expect(b.replayed).toBe(true);
      expect(b.ticket.qrText).toBe(a.ticket.qrText);
      expect((await row(t)).qr_epoch).toBe(2);
      expect((await row(t)).reissues_today).toBe(1);
      await expect(TK.reissueMyTicket(u, crypto.randomUUID(), body)).rejects.toMatchObject({ status: 409, code: "op_id_reused" });
      // Two parallel taps with one op id: one reissue.
      const c = op();
      const both = await Promise.all([TK.reissueMyTicket(u, t, c), TK.reissueMyTicket(u, t, c)]);
      expect(both.map((x) => x.replayed).sort()).toEqual([false, true]);
      expect((await row(t)).qr_epoch).toBe(3);
    });

    it("5 reissues a day: the 6th is 409 reissue_limit_day; the next UTC day starts again", async () => {
      const e = await mk();
      const { u, t } = await holder(e);
      for (let i = 0; i < 5; i++) await TK.reissueMyTicket(u, t, op());
      expect((await row(t)).qr_epoch).toBe(6);
      await expect(TK.reissueMyTicket(u, t, op())).rejects.toMatchObject({ status: 409, code: "reissue_limit_day" });
      expect((await row(t)).qr_epoch).toBe(6);
      await sql`update ticket set reissue_day = (now() at time zone 'utc')::date - 1 where id = ${t}`;
      await TK.reissueMyTicket(u, t, op());
      expect(await row(t)).toMatchObject({ qr_epoch: 7, reissues_today: 1 });
    });

    it("the epoch is capped at 20 (the schema's check): reissue_limit, nothing changes", async () => {
      const e = await mk();
      const { u, t } = await holder(e);
      await sql`update ticket set qr_epoch = 20, door_code_digest = ${TOK.doorFor(t, 20).digest} where id = ${t}`;
      await expect(TK.reissueMyTicket(u, t, op())).rejects.toMatchObject({ status: 409, code: "reissue_limit" });
      expect((await row(t)).qr_epoch).toBe(20);
      const live = await TK.getMyTicket(u, t);
      expect(TOK.verifyTicketToken(live.qrText!)).toEqual({ ticketId: t, epoch: 20 });
      expect(await doorAccepts(live.qrText!, e.id)).toBe(true);
    });

    it("a ticket that is already checked in can be reissued and stays checked in; a cancelled one can't be reissued", async () => {
      const e = await mk();
      const a = await holder(e);
      await sql`update ticket set checked_in_at = now() where id = ${a.t}`;
      await TK.reissueMyTicket(a.u, a.t, op());
      expect((await row(a.t)).checked_in_at).not.toBeNull();
      const b = await holder(e);
      await RG.cancelRegistration(b.u, b.r.registration.id, op());
      await expect(TK.reissueMyTicket(b.u, b.t, op())).rejects.toMatchObject({ status: 409, code: "ticket_cancelled" });
    });

    it("only the holder can reissue (404 for others, 403 for an admin); refusals are charged", async () => {
      const e = await mk();
      const { u, t } = await holder(e);
      const stranger = await newUser();
      const w = await writes(stranger.id);
      await expect(TK.reissueMyTicket(stranger, t, op())).rejects.toMatchObject({ status: 404 });
      expect(await writes(stranger.id)).toBe(w + 1);
      await expect(TK.reissueMyTicket(e.owner, t, op())).rejects.toMatchObject({ status: 404 });
      await expect(TK.reissueMyTicket(admin, t, op())).rejects.toMatchObject({ status: 403 });
      await expect(TK.reissueMyTicket(u, "nope", op())).rejects.toMatchObject({ name: "ZodError" });
      await expect(TK.reissueMyTicket(u, t, {})).rejects.toMatchObject({ name: "ZodError" });
      expect((await row(t)).qr_epoch).toBe(1);
    });

    it("reissues racing a scan: the scan's epoch check and the reissue serialise on the row (never a double use)", async () => {
      const e = await mk(40);
      for (let i = 0; i < 10; i++) {
        const { u, t } = await holder(e);
        const qr = (await TK.getMyTicket(u, t)).qrText!;
        const v = TOK.verifyTicketToken(qr)!;
        const scan = sql`update ticket set checked_in_at = now() where id = ${v.ticketId} and event_id = ${e.id} and status = 'valid' and qr_epoch = ${v.epoch} and checked_in_at is null returning id`;
        const [, s] = await Promise.all([TK.reissueMyTicket(u, t, op()), scan]);
        const r = await row(t);
        // Either the scan beat the reissue (checked in, epoch 2 afterwards) or lost to it (not checked in).
        expect(s.length === 1, `round ${i}`).toBe(r.checked_in_at !== null);
        expect(r.qr_epoch).toBe(2);
      }
    });

    it("the organiser reissues an attendee's ticket without seeing the new QR, and a guest ticket with it", async () => {
      const e = await mk();
      const { u, t } = await holder(e);
      const before = await TK.getMyTicket(u, t);
      const out = await TK.reissueTicketAsOrganizer(e.owner, e.id, t, op());
      expect(out).toMatchObject({ ticketId: t, qrEpoch: 2, status: "valid", replayed: false });
      expect(JSON.stringify(out)).not.toMatch(/ET1:|qrText|doorCode/);
      expect((await TK.getMyTicket(u, t)).qrText).not.toBe(before.qrText);

      const g = (await TK.addGuests(e.owner, e.id, { ticketTypeId: e.typeId, guests: [{ name: "Pat" }], clientOpId: crypto.randomUUID() })).tickets[0];
      const regen = await TK.reissueTicketAsOrganizer(e.owner, e.id, g.id, op());
      expect(regen.qrText).toMatch(/^ET1:/);
      expect(regen.qrText).not.toBe(g.qrText);
      expect(await doorAccepts(g.qrText!, e.id)).toBe(false);
      expect(await doorAccepts(regen.qrText!, e.id)).toBe(true);

      // 404 for another organiser, and for a ticket of another event of the same organiser.
      await expect(TK.reissueTicketAsOrganizer(org2, e.id, t, op())).rejects.toMatchObject({ status: 404 });
      const other = await mk(10, {}, e.owner);
      await expect(TK.reissueTicketAsOrganizer(e.owner, other.id, t, op())).rejects.toMatchObject({ status: 404 });
      await expect(TK.reissueTicketAsOrganizer(u, e.id, t, op())).rejects.toMatchObject({ status: 403 });
      await expect(TK.reissueTicketAsOrganizer(admin, e.id, t, op())).rejects.toMatchObject({ status: 403 });
      // The same limits: 5 a day (one is already used above).
      for (let i = 0; i < 4; i++) await TK.reissueTicketAsOrganizer(e.owner, e.id, t, op());
      await expect(TK.reissueTicketAsOrganizer(e.owner, e.id, t, op())).rejects.toMatchObject({ status: 409, code: "reissue_limit_day" });
    });
  });

  describe("guest list", () => {
    it("adds guest tickets against capacity: no holder, a QR and a door code for the organiser, sold_out when full", async () => {
      const e = await mk(3);
      const out = await TK.addGuests(e.owner, e.id, { ticketTypeId: e.typeId, guests: [{ name: "Ann Lee" }, { name: "Bo Chan", label: "VIP" }], clientOpId: crypto.randomUUID() });
      expect(out.replayed).toBe(false);
      expect(out.tickets.map((t) => [t.holderName, t.guestLabel])).toEqual([["Ann Lee", null], ["Bo Chan", "VIP"]]);
      for (const t of out.tickets) {
        expect(await doorAccepts(t.qrText!, e.id)).toBe(true);
        expect(await doorAcceptsCode(t.doorCode!, e.id)).toBe(true);
        expect(await row(t.id)).toMatchObject({ holder_user_id: null, registration_id: null, source: "guest_list", qr_epoch: 1 });
      }
      expect(await issued(e.typeId)).toBe(2);
      await expect(TK.addGuests(e.owner, e.id, { ticketTypeId: e.typeId, guests: [{ name: "A" }, { name: "B" }], clientOpId: crypto.randomUUID() })).rejects.toMatchObject({
        status: 409,
        code: "sold_out",
        message: expect.stringContaining("Only 1 seat left"),
      });
      expect(await issued(e.typeId)).toBe(2);
      // They count against registrations too.
      const u = await newUser();
      await RG.registerForEvent(u, e.id, reg(e.typeId, 1));
      await expect(RG.registerForEvent(await newUser(), e.id, reg(e.typeId, 1))).rejects.toMatchObject({ code: "sold_out" });
    });

    it("a retry with the same op id returns the same tickets (same QR) and adds none", async () => {
      const e = await mk(5);
      const body = { ticketTypeId: e.typeId, guests: [{ name: "Ann" }, { name: "Bo" }], clientOpId: crypto.randomUUID() };
      const a = await TK.addGuests(e.owner, e.id, body);
      const b = await TK.addGuests(e.owner, e.id, body);
      expect(b.replayed).toBe(true);
      expect(b.tickets.map((t) => [t.id, t.qrText])).toEqual(a.tickets.map((t) => [t.id, t.qrText]));
      expect(await issued(e.typeId)).toBe(2);
      await expect(TK.addGuests(e.owner, e.id, { ...body, guests: [{ name: "Ann" }] })).rejects.toMatchObject({ status: 409, code: "op_id_reused" });
      const [both1, both2] = await Promise.all([0, 1].map(() => TK.addGuests(e.owner, e.id, { ...body, clientOpId: "11111111-1111-4111-8111-111111111111" })));
      expect(both1.replayed !== both2.replayed).toBe(true);
      expect(await issued(e.typeId)).toBe(4);
    });

    it("at most 500 guest tickets a day per event, and 20 per request", async () => {
      const e = await mk(1000);
      await sql`
        insert into ticket (event_id, ticket_type_id, holder_name, source, door_code_digest)
        select ${e.id}, ${e.typeId}, 'seed ' || i, 'guest_list', sha256((i::text || random()::text)::bytea) from generate_series(1, 498) i`;
      await sql`update ticket_type set issued = 498 where id = ${e.typeId}`;
      await expect(TK.addGuests(e.owner, e.id, { ticketTypeId: e.typeId, guests: [{ name: "a" }, { name: "b" }, { name: "c" }], clientOpId: crypto.randomUUID() })).rejects.toMatchObject({
        status: 409,
        code: "guest_limit",
      });
      expect(await issued(e.typeId)).toBe(498);
      await TK.addGuests(e.owner, e.id, { ticketTypeId: e.typeId, guests: [{ name: "a" }, { name: "b" }], clientOpId: crypto.randomUUID() });
      await expect(TK.addGuests(e.owner, e.id, { ticketTypeId: e.typeId, guests: [{ name: "z" }], clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ code: "guest_limit" });
      // Yesterday's guests don't count.
      await sql`update ticket set created_at = now() - interval '2 days' where event_id = ${e.id}`;
      await TK.addGuests(e.owner, e.id, { ticketTypeId: e.typeId, guests: [{ name: "z" }], clientOpId: crypto.randomUUID() });
      const many = Array.from({ length: 21 }, (_, i) => ({ name: `g${i}` }));
      await expect(TK.addGuests(e.owner, e.id, { ticketTypeId: e.typeId, guests: many, clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ name: "ZodError" });
    });

    it("refuses a draft, a hidden and a cancelled event; 404 for another organiser, a wrong type or a missing event; 403 for attendees and admins", async () => {
      const draft = (await EV.createEvent(org, openDoorInput())).event;
      const dt = (await TT.createTicketType(org, draft.id, { name: "General", capacity: 5, clientOpId: crypto.randomUUID() })).ticketType;
      const body = (typeId: string, o: Record<string, unknown> = {}) => ({ ticketTypeId: typeId, guests: [{ name: "G" }], clientOpId: crypto.randomUUID(), ...o });
      await expect(TK.addGuests(org, draft.id, body(dt.id))).rejects.toMatchObject({ status: 409, code: "not_open" });

      const hidden = await mk();
      await AD.hideEvent(admin, hidden.id, { hidden: true, reason: "x", clientOpId: crypto.randomUUID() });
      await expect(TK.addGuests(hidden.owner, hidden.id, body(hidden.typeId))).rejects.toMatchObject({ status: 409, code: "not_open" });

      const cancelled = await mk();
      await EV.updateEvent(cancelled.owner, cancelled.id, { version: cancelled.version, status: "cancelled" });
      await expect(TK.addGuests(cancelled.owner, cancelled.id, body(cancelled.typeId))).rejects.toMatchObject({ status: 409, code: "event_cancelled" });

      const e = await mk();
      const f = await mk();
      await expect(TK.addGuests(org2, e.id, body(e.typeId))).rejects.toMatchObject({ status: 404 });
      await expect(TK.addGuests(e.owner, e.id, body(f.typeId))).rejects.toMatchObject({ status: 404 });
      await expect(TK.addGuests(e.owner, crypto.randomUUID(), body(e.typeId))).rejects.toMatchObject({ status: 404 });
      await expect(TK.addGuests(await newUser(), e.id, body(e.typeId))).rejects.toMatchObject({ status: 403 });
      await expect(TK.addGuests(admin, e.id, body(e.typeId))).rejects.toMatchObject({ status: 403 });
      for (const bad of [{ guests: [] }, { guests: [{ name: "" }] }, { guests: [{ name: "a\0b" }] }, { guests: [{ name: "x".repeat(81) }] }, { guests: [{ name: "ok", label: "y".repeat(41) }] }, { ticketTypeId: "nope" }]) {
        await expect(TK.addGuests(e.owner, e.id, body(e.typeId, bad)), JSON.stringify(bad)).rejects.toMatchObject({ name: "ZodError" });
      }
      expect(await issued(e.typeId)).toBe(0);
    });
  });

  describe("void", () => {
    it("voids one ticket: issued drops by one, a registration with no valid ticket left is cancelled (the attendee can register again)", async () => {
      const e = await mk(5);
      const { u, r } = await holder(e, 2);
      const [t1, t2] = r.tickets.map((t) => t.id);
      const a = await TK.voidTicket(e.owner, e.id, t1, op());
      expect(a).toMatchObject({ voided: true, registrationCancelled: false, replayed: false });
      expect(await issued(e.typeId)).toBe(1);
      expect((await sql`select status from registration where id = ${r.registration.id}`)[0].status).toBe("active");
      await expect(RG.registerForEvent(u, e.id, reg(e.typeId))).rejects.toMatchObject({ code: "already_registered" });
      const b = await TK.voidTicket(e.owner, e.id, t2, op());
      expect(b.registrationCancelled).toBe(true);
      expect(await issued(e.typeId)).toBe(0);
      await RG.registerForEvent(u, e.id, reg(e.typeId));
      expect(await issued(e.typeId)).toBe(1);
      // The voided ticket reads as cancelled to its holder.
      expect((await TK.getMyTicket(u, t1)).qrText).toBeNull();
    });

    it("voiding twice: the second is 409 ticket_not_voidable and issued dropped once; the same op id replays", async () => {
      const e = await mk(5);
      const { t } = await holder(e);
      const body = op();
      await TK.voidTicket(e.owner, e.id, t, body);
      const again = await TK.voidTicket(e.owner, e.id, t, body);
      expect(again.replayed).toBe(true);
      await expect(TK.voidTicket(e.owner, e.id, t, op())).rejects.toMatchObject({ status: 409, code: "ticket_not_voidable" });
      expect(await issued(e.typeId)).toBe(0);
      // Two parallel voids with different op ids: one wins.
      const x = await holder(e);
      const res = await Promise.allSettled([TK.voidTicket(e.owner, e.id, x.t, op()), TK.voidTicket(e.owner, e.id, x.t, op())]);
      expect(res.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      expect(await issued(e.typeId)).toBe(0);
    });

    it("a checked-in ticket can't be voided (409), and nothing changes", async () => {
      const e = await mk(5);
      const { t } = await holder(e);
      await sql`update ticket set checked_in_at = now() where id = ${t}`;
      await expect(TK.voidTicket(e.owner, e.id, t, op())).rejects.toMatchObject({ status: 409, code: "ticket_not_voidable", message: expect.stringContaining("checked in") });
      expect(await issued(e.typeId)).toBe(1);
      expect((await row(t)).status).toBe("valid");
    });

    it("404 for another organiser, for a ticket of a different event, and for a missing id; 403 for attendees and admins; refusals are charged", async () => {
      const e = await mk(5);
      const f = await mk(5, {}, e.owner);
      const { t } = await holder(e);
      await expect(TK.voidTicket(org2, e.id, t, op())).rejects.toMatchObject({ status: 404 });
      await expect(TK.voidTicket(e.owner, f.id, t, op())).rejects.toMatchObject({ status: 404 });
      await expect(TK.voidTicket(e.owner, e.id, crypto.randomUUID(), op())).rejects.toMatchObject({ status: 404 });
      await expect(TK.voidTicket(e.owner, e.id, "nope", op())).rejects.toMatchObject({ name: "ZodError" });
      await expect(TK.voidTicket(e.owner, e.id, t, {})).rejects.toMatchObject({ name: "ZodError" });
      await expect(TK.voidTicket(await newUser(), e.id, t, op())).rejects.toMatchObject({ status: 403 });
      await expect(TK.voidTicket(admin, e.id, t, op())).rejects.toMatchObject({ status: 403 });
      expect(await issued(e.typeId)).toBe(1);
      const before = await writes(e.owner.id);
      await expect(TK.voidTicket(e.owner, e.id, crypto.randomUUID(), op())).rejects.toBeTruthy();
      await expect(TK.voidTicket(e.owner, e.id, "bad", op())).rejects.toBeTruthy();
      expect(await writes(e.owner.id)).toBe(before + 2);
    });
  });

  describe("attendees", () => {
    it("lists name, label, the holder's email (null for a guest), type, status and check-in, 50 a page, and never a QR or a code", async () => {
      const e = await mk(100);
      const { u } = await holder(e, 2);
      await sql`update "user" set name = 'Jane Doe', email = ${`jane-${P}@test.local`} where id = ${u.id}`;
      await TK.addGuests(e.owner, e.id, { ticketTypeId: e.typeId, guests: [{ name: "Walk In" }], clientOpId: crypto.randomUUID() });
      const list = await TK.listAttendees(e.owner, e.id);
      expect(list).toMatchObject({ page: 1, pageSize: 50, total: 3 });
      const jane = list.attendees.filter((a) => a.email === `jane-${P}@test.local`);
      expect(jane).toHaveLength(2);
      expect(list.attendees.find((a) => a.holderName === "Walk In")).toMatchObject({ email: null, source: "guest_list", status: "valid", ticketTypeName: "General", checkedInAt: null });
      const json = JSON.stringify(list);
      expect(json).not.toContain("ET1:");
      expect(json).not.toMatch(/qrText|doorCode|digest/i);
      // 60 guests: page 1 has 50, page 2 the rest.
      for (let i = 0; i < 3; i++) await TK.addGuests(e.owner, e.id, { ticketTypeId: e.typeId, guests: Array.from({ length: 20 }, (_, k) => ({ name: `Guest ${i}-${k}` })), clientOpId: crypto.randomUUID() });
      const p1 = await TK.listAttendees(e.owner, e.id, { page: "1" });
      const p2 = await TK.listAttendees(e.owner, e.id, { page: "2" });
      expect(p1.attendees).toHaveLength(50);
      expect(p2.attendees).toHaveLength(13);
      expect(p1.total).toBe(63);
      expect(new Set([...p1.attendees, ...p2.attendees].map((a) => a.ticketId)).size).toBe(63);
      await TK.voidTicket(e.owner, e.id, p1.attendees[0].ticketId, op());
      expect((await TK.listAttendees(e.owner, e.id, { status: "cancelled" })).total).toBe(1);
    });

    it("404 for another organiser and a missing event, 403 for attendees and admins, 400 for a bad page or id", async () => {
      const e = await mk();
      await expect(TK.listAttendees(org2, e.id)).rejects.toMatchObject({ status: 404 });
      await expect(TK.listAttendees(e.owner, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
      await expect(TK.listAttendees(await newUser(), e.id)).rejects.toMatchObject({ status: 403 });
      await expect(TK.listAttendees(admin, e.id)).rejects.toMatchObject({ status: 403 });
      await expect(TK.listAttendees(null, e.id)).rejects.toMatchObject({ name: "UnauthorizedError" });
      for (const q of [{ page: "0" }, { page: "x" }, { status: "nope" }, { other: "1" }]) await expect(TK.listAttendees(e.owner, e.id, q), JSON.stringify(q)).rejects.toMatchObject({ name: "ZodError" });
      await expect(TK.listAttendees(e.owner, `${e.id}\0`)).rejects.toMatchObject({ name: "ZodError" });
    });
  });

  describe("a mixed storm", () => {
    it("registrations, cancels, voids and reissues in parallel end in 4xx refusals only (no deadlock, no 500), and the books balance", async () => {
      const e = await mk(30, { maxPerRegistration: 3 });
      const users = await Promise.all(Array.from({ length: 24 }, (_, i) => newUser(`storm${i}`)));
      const regs = await Promise.allSettled(users.map((u, i) => RG.registerForEvent(u, e.id, reg(e.typeId, 1 + (i % 3)))));
      const made = regs.flatMap((r, i) => (r.status === "fulfilled" ? [{ u: users[i], r: r.value }] : []));
      const work = made.flatMap(({ u, r }, i) => {
        const t = r.tickets[0].id;
        const ops: Promise<unknown>[] = [TK.reissueMyTicket(u, t, op()), TK.getMyTicket(u, t)];
        if (i % 3 === 0) ops.push(RG.cancelRegistration(u, r.registration.id, op()));
        if (i % 3 === 1) ops.push(TK.voidTicket(e.owner, e.id, t, op()));
        if (i % 4 === 0) ops.push(TK.addGuests(e.owner, e.id, { ticketTypeId: e.typeId, guests: [{ name: `late ${i}` }], clientOpId: crypto.randomUUID() }));
        if (i % 5 === 0) ops.push(RG.registerForEvent(u, e.id, reg(e.typeId)));
        return ops;
      });
      const results = await Promise.allSettled(work);
      for (const r of results) {
        if (r.status !== "rejected") continue;
        expect(r.reason.status, String(r.reason?.message)).toBeGreaterThanOrEqual(400);
        expect(r.reason.status).toBeLessThan(500);
      }
      const [t] = await sql`select issued, capacity from ticket_type where id = ${e.typeId}`;
      const [{ valid }] = await sql`select count(*)::int as valid from ticket where event_id = ${e.id} and status = 'valid'`;
      expect(t.issued).toBe(valid);
      expect(t.issued).toBeLessThanOrEqual(t.capacity);
    });
  });

  describe("logs", () => {
    it("never carry a QR text, a door code, a holder name or an email", async () => {
      const lines: string[] = [];
      const grab = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
      vi.spyOn(console, "log").mockImplementation(grab);
      vi.spyOn(console, "error").mockImplementation(grab);
      const e = await mk();
      const u = await newUser();
      await sql`update "user" set name = 'Visible Name' where id = ${u.id}`;
      const r = await RG.registerForEvent(u, e.id, reg(e.typeId, 2));
      const mine = await TK.getMyTicket(u, r.tickets[0].id);
      await TK.reissueMyTicket(u, r.tickets[0].id, op());
      const g = await TK.addGuests(e.owner, e.id, { ticketTypeId: e.typeId, guests: [{ name: "Secret Guest" }], clientOpId: crypto.randomUUID() });
      await TK.reissueTicketAsOrganizer(e.owner, e.id, g.tickets[0].id, op());
      await TK.voidTicket(e.owner, e.id, r.tickets[1].id, op());
      await RG.cancelRegistration(u, r.registration.id, op()).catch(() => undefined);
      await TK.getMyTicket(u, crypto.randomUUID()).catch(() => undefined);
      const text = lines.join("\n");
      expect(lines.length).toBeGreaterThan(3);
      for (const secret of [mine.qrText!, mine.doorCode!, mine.doorCode!.replace("-", ""), g.tickets[0].qrText!, g.tickets[0].doorCode!, "Visible Name", "Secret Guest", "@test.local"]) {
        expect(text, secret).not.toContain(secret);
      }
      expect(text).not.toContain("ET1:");
    });
  });

  describe("routes", () => {
    const post = (path: string, body: unknown, origin: string | null = "http://localhost:3000") =>
      new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    const asUser = (a: TestActor) => (sessionUser = { ...a, name: a.id, email: `${a.id}@test.local` });

    it("GET /api/tickets/[id]: 200 with no-store and no-referrer for the holder, 404 for anyone else, 401 signed out", async () => {
      const e = await mk();
      const { u, t } = await holder(e);
      const { GET } = await import("@/app/api/tickets/[id]/route");
      const ctx = { params: Promise.resolve({ id: t }) };
      asUser(u);
      const ok = await GET(new Request("http://localhost:3000/api/tickets/x"), ctx);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("private, no-store");
      expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
      const body = await ok.json();
      expect(body.qrText).toMatch(/^ET1:/);
      asUser(await newUser());
      const nope = await GET(new Request("http://localhost:3000/api/tickets/x"), ctx);
      expect(nope.status).toBe(404);
      expect(nope.headers.get("cache-control")).toBeNull(); // errorResponse; the body carries nothing about the ticket
      expect(JSON.stringify(await nope.json())).not.toContain("ET1");
      asUser(e.owner);
      expect((await GET(new Request("http://localhost:3000/api/tickets/x"), ctx)).status).toBe(404);
      sessionUser = null;
      expect((await GET(new Request("http://localhost:3000/api/tickets/x"), ctx)).status).toBe(401);
      asUser(u);
      expect((await GET(new Request("http://localhost:3000/api/tickets/x"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(400);
    });

    it("register, cancel and reissue routes: 201 then 200 on a replay, cross-origin and missing-origin refused (403), a NUL or malformed JSON is 400", async () => {
      const e = await mk();
      const u = await newUser();
      asUser(u);
      const { POST: register } = await import("@/app/api/events/[id]/register/route");
      const { DELETE: cancel } = await import("@/app/api/registrations/[id]/route");
      const { POST: reissue } = await import("@/app/api/tickets/[id]/reissue/route");
      const body = reg(e.typeId, 2);
      const ctx = { params: Promise.resolve({ id: e.id }) };
      const first = await register(post(`/api/events/${e.id}/register`, body), ctx);
      expect(first.status).toBe(201);
      expect(first.headers.get("cache-control")).toBe("private, no-store");
      const created = await first.json();
      expect(JSON.stringify(created)).not.toContain("ET1:");
      const again = await register(post(`/api/events/${e.id}/register`, body), ctx);
      expect(again.status).toBe(200);
      expect((await again.json()).replayed).toBe(true);
      expect((await register(post(`/api/events/${e.id}/register`, body, "https://evil.example"), ctx)).status).toBe(403);
      expect((await register(post(`/api/events/${e.id}/register`, body, null), ctx)).status).toBe(403);
      const nul = await register(new Request("http://localhost:3000/x", { method: "POST", headers: { origin: "http://localhost:3000" }, body: '{"clientOpId":"a\\u0000b"}' }), ctx);
      expect(nul.status).toBe(400);
      const junk = await register(new Request("http://localhost:3000/x", { method: "POST", headers: { origin: "http://localhost:3000" }, body: "{nope" }), ctx);
      expect(junk.status).toBe(400);
      const sold = await register(post(`/api/events/${e.id}/register`, reg(e.typeId, 1)), ctx);
      expect(sold.status).toBe(409);
      expect((await sold.json()).code).toBe("already_registered");

      const re = await reissue(post(`/api/tickets/x/reissue`, op()), { params: Promise.resolve({ id: created.tickets[0].id }) });
      expect(re.status).toBe(200);
      expect(re.headers.get("referrer-policy")).toBe("no-referrer");
      expect((await re.json()).ticket.qrEpoch).toBe(2);

      const del = await cancel(new Request("http://localhost:3000/x", { method: "DELETE", headers: { origin: "http://localhost:3000" }, body: JSON.stringify(op()) }), {
        params: Promise.resolve({ id: created.registration.id }),
      });
      expect(del.status).toBe(200);
      expect((await del.json())).toMatchObject({ cancelled: true, changed: true, released: 2 });
      expect((await cancel(new Request("http://localhost:3000/x", { method: "DELETE", headers: { origin: "http://localhost:3000" }, body: "{}" }), { params: Promise.resolve({ id: created.registration.id }) })).status).toBe(400);
    });

    it("organiser routes: attendees, guests, void, reissue answer the organiser, refuse attendees (403) and other organisers (404)", async () => {
      const e = await mk();
      const { t } = await holder(e);
      const { GET: attendees } = await import("@/app/api/organizer/events/[id]/attendees/route");
      const { POST: guests } = await import("@/app/api/organizer/events/[id]/guests/route");
      const { POST: voidRoute } = await import("@/app/api/organizer/events/[id]/tickets/[ticketId]/void/route");
      const { POST: reissue } = await import("@/app/api/organizer/events/[id]/tickets/[ticketId]/reissue/route");
      const ctx = { params: Promise.resolve({ id: e.id }) };
      asUser(e.owner);
      const list = await attendees(new Request("http://localhost:3000/x?page=1"), ctx);
      expect(list.status).toBe(200);
      expect(list.headers.get("cache-control")).toBe("private, no-store");
      expect((await list.json()).total).toBe(1);
      const g = await guests(post("/x", { ticketTypeId: e.typeId, guests: [{ name: "Walk In" }], clientOpId: crypto.randomUUID() }), ctx);
      expect(g.status).toBe(201);
      expect((await g.json()).tickets[0].qrText).toMatch(/^ET1:/);
      const tctx = { params: Promise.resolve({ id: e.id, ticketId: t }) };
      expect((await reissue(post("/x", op()), tctx)).status).toBe(200);
      expect((await voidRoute(post("/x", op()), tctx)).status).toBe(200);
      expect((await voidRoute(post("/x", op()), tctx)).status).toBe(409);
      expect((await voidRoute(post("/x", op(), null), tctx)).status).toBe(403);
      asUser(org2);
      expect((await attendees(new Request("http://localhost:3000/x"), ctx)).status).toBe(404);
      expect((await guests(post("/x", { ticketTypeId: e.typeId, guests: [{ name: "x" }], clientOpId: crypto.randomUUID() }), ctx)).status).toBe(404);
      asUser(await newUser());
      expect((await attendees(new Request("http://localhost:3000/x"), ctx)).status).toBe(403);
      expect((await voidRoute(post("/x", op()), tctx)).status).toBe(403);
      sessionUser = null;
      expect((await attendees(new Request("http://localhost:3000/x"), ctx)).status).toBe(401);
    });
  });
});
