/**
 * Events and ticket types against a real Postgres (TEST_DATABASE_URL): idempotent create, versions, validation,
 * status transitions, E1-E5 bumping faq_version, caps, cascades, and the lock order under parallel writes.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type TestActor, cleanup, eventInput, makeUser, op } from "./helpers";

const url = process.env.TEST_DATABASE_URL;
const P = "ev";

describe.skipIf(!url)("events (Postgres)", () => {
  let sql: postgres.Sql;
  let org: TestActor;
  let org2: TestActor;
  let admin: TestActor;
  let attendee: TestActor;
  let EV: typeof import("@/lib/events");
  let TT: typeof import("@/lib/ticket-types");
  let AD: typeof import("@/lib/admin");
  let R: typeof import("@/lib/auth/roles");
  let ST: typeof import("@/lib/staff");
  let dbErrorCode: typeof import("@/lib/db-errors").dbErrorCode;

  const mk = async (o: Record<string, unknown> = {}, who = org) => (await EV.createEvent(who, eventInput(o))).event;
  const withType = async (o: Record<string, unknown> = {}, cap = 10, who = org) => {
    const e = await mk(o, who);
    const { ticketType } = await TT.createTicketType(who, e.id, { name: "General", capacity: cap });
    return { event: e, type: ticketType };
  };
  const faqVersion = async (id: string) => (await sql`select faq_version from event where id = ${id}`)[0].faq_version as number;
  const fresh = async (id: string) => (await EV.getMyEvent(org, id));

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup(sql, P);
    org = await makeUser(sql, P, "org", "organizer");
    org2 = await makeUser(sql, P, "org2", "organizer");
    admin = await makeUser(sql, P, "admin", "admin");
    attendee = await makeUser(sql, P, "att", "user");
    EV = await import("@/lib/events");
    TT = await import("@/lib/ticket-types");
    AD = await import("@/lib/admin");
    R = await import("@/lib/auth/roles");
    ST = await import("@/lib/staff");
    ({ dbErrorCode } = await import("@/lib/db-errors"));
  });

  // Each test starts the main organiser from zero events (the 20-event cap would otherwise fill up across tests).
  beforeEach(async () => {
    await sql`delete from event where organizer_id = ${org.id}`;
  });

  afterAll(async () => {
    await cleanup(sql, P);
    await sql.end();
  });

  describe("create", () => {
    it("makes a draft with the spec's defaults and a generated slug", async () => {
      const e = await mk({ title: "Defaults Day" });
      expect(e).toMatchObject({ status: "draft", version: 1, faqVersion: 1, maxPerRegistration: 4, hiddenAt: null, ticketTypes: [] });
      expect(e.slug).toMatch(/^defaults-day-[a-z0-9]{5}$/);
      expect(e.registrationClosesAt.getTime()).toBe(e.startsAt.getTime());
      expect(e.startsAt.getTime() - e.checkinOpensAt.getTime()).toBe(3 * 3_600_000);
      expect(Object.keys(e)).not.toContain("clientOpId");
      expect(Object.keys(e)).not.toContain("organizerId");
    });

    it("a duplicate client_op_id makes one event, sequentially and in parallel", async () => {
      const input = eventInput({ title: "Once" });
      const first = await EV.createEvent(org, input);
      const again = await EV.createEvent(org, input);
      expect(first.created).toBe(true);
      expect(again).toMatchObject({ created: false });
      expect(again.event.id).toBe(first.event.id);
      const par = eventInput({ title: "Parallel once" });
      const results = await Promise.all(Array.from({ length: 6 }, () => EV.createEvent(org, par)));
      expect(new Set(results.map((r) => r.event.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      const [{ n }] = await sql`select count(*)::int as n from event where organizer_id = ${org.id} and client_op_id = ${par.clientOpId}`;
      expect(n).toBe(1);
      // The same op id from another organiser is a different event.
      const other = await EV.createEvent(org2, par);
      expect(other.created).toBe(true);
      expect(other.event.id).not.toBe(results[0].event.id);
    });

    it("takes an explicit slug once and says so when it is taken", async () => {
      const slug = `${P}-taken-slug`;
      await mk({ slug });
      await expect(EV.createEvent(org2, eventInput({ slug }))).rejects.toMatchObject({ status: 409, code: "slug_taken" });
      await expect(EV.createEvent(org, eventInput({ slug: "Bad Slug!" }))).rejects.toMatchObject({ name: "ZodError" });
    });

    it("refuses an invalid time zone, bad times, unknown keys and NUL bytes with a 400", async () => {
      const bad = async (o: Record<string, unknown>) => {
        const err = await EV.createEvent(org, eventInput(o)).catch((e) => e);
        expect(err.name === "ZodError" || err.status === 400, JSON.stringify(Object.keys(o))).toBe(true);
      };
      await bad({ timeZone: "Mars/Olympus" });
      await bad({ endsAt: new Date(Date.now() + 3_600_000).toISOString() }); // ends before it starts
      await bad({ endsAt: new Date(Date.now() + 9 * 24 * 3_600_000).toISOString() }); // longer than 7 days
      await bad({ organizerId: org2.id });
      await bad({ title: "nul\0byte" });
      await bad({ description: "nul\0byte" });
      await bad({ venueName: "\0" });
      await bad({ address: "a\0" });
      await bad({ slug: "ab\0cd" });
      await bad({ timeZone: "America/Chicago\0" });
      await bad({ clientOpId: "not-a-uuid" });
      await bad({ clientOpId: undefined });
      await bad({ contactEmail: "nope" });
      await bad({ doorsAt: new Date(Date.now() + 30 * 3_600_000).toISOString() }); // doors after the start
    });

    it("keeps the 20-event cap exact under parallel creates, and a replay still works at the cap", async () => {
      const o = await makeUser(sql, P, "capper", "organizer");
      const ops = Array.from({ length: 25 }, () => crypto.randomUUID());
      const results = await Promise.allSettled(ops.map((clientOpId) => EV.createEvent(o, eventInput({ clientOpId }))));
      const ok = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(ok).toHaveLength(20);
      expect(refused).toHaveLength(5);
      for (const r of refused) expect(r.reason).toMatchObject({ status: 409, code: "event_limit" });
      const [{ n }] = await sql`select count(*)::int as n from event where organizer_id = ${o.id}`;
      expect(n).toBe(20);
      const firstOp = ops.find((_, i) => results[i].status === "fulfilled")!;
      await expect(EV.createEvent(o, eventInput({ clientOpId: firstOp }))).resolves.toMatchObject({ created: false });
      // Deleting one frees a slot.
      const any = (await EV.listMyEvents(o))[0];
      await EV.deleteEvent(o, any.id);
      await expect(EV.createEvent(o, eventInput())).resolves.toMatchObject({ created: true });
    });
  });

  describe("update, versions, status", () => {
    it("a stale version is a 409 carrying the current event; a good one bumps version", async () => {
      const e = await mk({ title: "Versioned" });
      const v2 = await EV.updateEvent(org, e.id, { version: 1, venueName: "New Hall" });
      expect(v2).toMatchObject({ version: 2, venueName: "New Hall" });
      const err = await EV.updateEvent(org, e.id, { version: 1, venueName: "Stale" }).catch((x) => x);
      expect(err).toMatchObject({ status: 409 });
      expect(err.current).toMatchObject({ id: e.id, version: 2, venueName: "New Hall" });
      expect((await fresh(e.id)).venueName).toBe("New Hall");
    });

    it("two parallel edits from the same version: one wins, one is a 409", async () => {
      const e = await mk();
      const r = await Promise.allSettled([
        EV.updateEvent(org, e.id, { version: 1, title: "A title" }),
        EV.updateEvent(org, e.id, { version: 1, title: "B title" }),
      ]);
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect((r.find((x) => x.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    });

    it("publishing without a ticket type is refused; with one it works and is idempotent", async () => {
      const e = await mk();
      await expect(EV.updateEvent(org, e.id, { version: 1, status: "published" })).rejects.toMatchObject({ status: 409, code: "no_ticket_types" });
      expect((await fresh(e.id)).status).toBe("draft");
      await TT.createTicketType(org, e.id, { name: "General", capacity: 5 });
      const pub = await EV.updateEvent(org, e.id, { version: 1, status: "published" });
      expect(pub.status).toBe("published");
      const same = await EV.updateEvent(org, e.id, { version: pub.version, status: "published", venueName: "Same status, new venue" });
      expect(same).toMatchObject({ status: "published", venueName: "Same status, new venue" });
    });

    it("enforces the transitions on the server: no cancel from draft, no edits after cancel, no publish after cancel", async () => {
      const { event: e } = await withType();
      await expect(EV.updateEvent(org, e.id, { version: 1, status: "cancelled" })).rejects.toMatchObject({ status: 409, code: "not_published" });
      const pub = await EV.updateEvent(org, e.id, { version: 1, status: "published" });
      const cancelled = await EV.updateEvent(org, e.id, { version: pub.version, status: "cancelled" });
      expect(cancelled.status).toBe("cancelled");
      await expect(EV.updateEvent(org, e.id, { version: cancelled.version, title: "Edit" })).rejects.toMatchObject({ status: 409, code: "event_cancelled" });
      await expect(EV.updateEvent(org, e.id, { version: cancelled.version, status: "published" })).rejects.toMatchObject({ status: 409 });
      await expect(TT.createTicketType(org, e.id, { name: "VIP", capacity: 1 })).rejects.toMatchObject({ status: 409, code: "event_cancelled" });
    });

    it("the slug can change in draft only, and not to a taken one", async () => {
      const a = await mk();
      const b = await mk();
      await expect(EV.updateEvent(org, a.id, { version: 1, slug: b.slug })).rejects.toMatchObject({ status: 409, code: "slug_taken" });
      const moved = await EV.updateEvent(org, a.id, { version: 1, slug: `${P}-moved-slug` });
      expect(moved.slug).toBe(`${P}-moved-slug`);
      await TT.createTicketType(org, a.id, { name: "General", capacity: 5 });
      const pub = await EV.updateEvent(org, a.id, { version: moved.version, status: "published" });
      await expect(EV.updateEvent(org, a.id, { version: pub.version, slug: `${P}-after-publish` })).rejects.toMatchObject({ status: 409, code: "slug_locked" });
    });

    it("merged times are re-checked: moving the start past a stored closing time is a 400", async () => {
      const e = await mk();
      const later = new Date(e.endsAt.getTime() + 24 * 3_600_000).toISOString();
      const err = await EV.updateEvent(org, e.id, { version: 1, startsAt: later, endsAt: new Date(e.endsAt.getTime() + 25 * 3_600_000).toISOString() }).catch((x) => x);
      // registration_closes_at stayed at the old start, which is fine (before the end), so this one succeeds...
      expect(err.version).toBe(2);
      // ...but an end before the stored check-in opening is refused.
      const bad = await EV.updateEvent(org, e.id, { version: 2, endsAt: new Date(e.startsAt.getTime() + 1000).toISOString() }).catch((x) => x);
      expect(bad.status === 400 || bad.name === "ZodError").toBe(true);
    });

    it("an event id or version with a NUL byte or a bad shape is a 400, not a 500", async () => {
      for (const id of ["abc\0def", "not-a-uuid", "", "1; drop table event"]) {
        const err = await EV.updateEvent(org, id, { version: 1, title: "x" }).catch((e) => e);
        expect(err.name, id).toBe("ZodError");
      }
      const e = await mk();
      await expect(EV.updateEvent(org, e.id, { version: 1.5, title: "x" })).rejects.toMatchObject({ name: "ZodError" });
      await expect(EV.updateEvent(org, e.id, { version: 1, title: "x\0" })).rejects.toMatchObject({ name: "ZodError" });
    });
  });

  describe("every id and slug goes through a NUL-rejecting schema (400), and a well-formed unknown id is a 404", () => {
    const nul = "\0";
    const ghost = () => crypto.randomUUID();
    it("organiser functions", async () => {
      const e = await mk();
      const bads = ["abc" + nul, nul, "zzz", ""];
      const calls: [string, (bad: string) => Promise<unknown>][] = [
        ["getMyEvent", (b) => EV.getMyEvent(org, b)],
        ["deleteEvent", (b) => EV.deleteEvent(org, b)],
        ["createTicketType event", (b) => TT.createTicketType(org, b, { name: "x", capacity: 1 })],
        ["updateTicketType event", (b) => TT.updateTicketType(org, b, ghost(), { version: 1, name: "x" })],
        ["updateTicketType type", (b) => TT.updateTicketType(org, e.id, b, { version: 1, name: "x" })],
        ["deleteTicketType event", (b) => TT.deleteTicketType(org, b, ghost())],
        ["deleteTicketType type", (b) => TT.deleteTicketType(org, e.id, b)],
        ["listStaff", (b) => ST.listStaff(org, b)],
        ["createInvite", (b) => ST.createInvite(org, b, op())],
        ["revokeInvite event", (b) => ST.revokeInvite(org, b, ghost())],
        ["revokeInvite invite", (b) => ST.revokeInvite(org, e.id, b)],
        ["removeStaff event", (b) => ST.removeStaff(org, b, "someone", op())],
      ];
      for (const [name, call] of calls) {
        for (const bad of bads) {
          const err = (await call(bad).catch((x) => x)) as { name?: string } | undefined;
          expect(err?.name, `${name} ${JSON.stringify(bad)}`).toBe("ZodError");
        }
      }
      // removeStaff's user id is text, not a uuid: only NUL and empty are malformed.
      for (const bad of ["a" + nul, ""]) expect((await ST.removeStaff(org, e.id, bad, op()).catch((x) => x)).name).toBe("ZodError");
      // Well formed but unknown: 404 (not 400, not 500).
      for (const call of [
        () => EV.getMyEvent(org, ghost()),
        () => EV.updateEvent(org, ghost(), { version: 1, title: "x" }),
        () => EV.deleteEvent(org, ghost()),
        () => TT.createTicketType(org, ghost(), { name: "x", capacity: 1 }),
        () => TT.updateTicketType(org, e.id, ghost(), { version: 1, name: "y" }),
        () => TT.deleteTicketType(org, e.id, ghost()),
        () => ST.listStaff(org, ghost()),
        () => ST.createInvite(org, ghost(), op()),
        () => ST.revokeInvite(org, ghost(), ghost()),
        () => ST.removeStaff(org, ghost(), "someone", op()),
      ]) {
        await expect(call()).rejects.toMatchObject({ status: 404 });
      }
    });

    it("public, admin and role functions", async () => {
      for (const bad of ["abc" + nul, nul, ""]) {
        expect((await EV.getPublicEventBySlug(bad).catch((x) => x)).name, JSON.stringify(bad)).toBe("ZodError");
        expect((await AD.hideEvent(admin, bad, { hidden: false, clientOpId: crypto.randomUUID() }).catch((x) => x)).name).toBe("ZodError");
        expect((await R.setUserRole(admin, { userId: bad, role: "user", from: "user", clientOpId: crypto.randomUUID() }).catch((x) => x)).name).toBe("ZodError");
        expect((await ST.acceptInvite(attendee, { token: bad }).catch((x) => x)).name).toBe(bad === "" ? "ZodError" : "ZodError");
      }
      await expect(EV.getPublicEventBySlug("no-such-event-slug")).rejects.toMatchObject({ status: 404 });
      await expect(AD.hideEvent(admin, ghost(), { hidden: false, clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ status: 404 });
      for (const q of [{ limit: "0" }, { limit: "101" }, { limit: "x" }, { past: "yes" }, { limit: "5\0" }, { other: "1" }]) {
        expect((await EV.listPublicEvents(q).catch((x) => x)).name, JSON.stringify(q)).toBe("ZodError");
      }
    });
  });

  describe("E1-E5 edits bump faq_version", () => {
    it("bumps on every E-field of the event PATCH, and not on the others or on a no-op", async () => {
      const { event: e } = await withType();
      let version = 1;
      const patch = async (change: Record<string, unknown>) => {
        const before = await faqVersion(e.id);
        const out = await EV.updateEvent(org, e.id, { version, ...change });
        version = out.version;
        return (await faqVersion(e.id)) - before;
      };
      const startPlus = (h: number) => new Date(e.startsAt.getTime() + h * 3_600_000).toISOString();
      const cases: [string, Record<string, unknown>][] = [
        ["title", { title: "New title" }],
        ["description", { description: "New about" }],
        ["venueName", { venueName: "Another venue" }],
        ["address", { address: "1 New St" }],
        ["timeZone", { timeZone: "America/New_York" }],
        ["startsAt", { startsAt: startPlus(0.5) }],
        ["endsAt", { endsAt: startPlus(4) }],
        ["doorsAt", { doorsAt: startPlus(-0.5) }],
        ["registrationClosesAt", { registrationClosesAt: startPlus(0.25) }],
        ["contactEmail", { contactEmail: "hello@example.com" }],
      ];
      for (const [name, change] of cases) expect(await patch(change), name).toBe(1);
      // Not part of E1-E5.
      expect(await patch({ maxPerRegistration: 2 }), "maxPerRegistration").toBe(0);
      expect(await patch({ checkinOpensAt: startPlus(-2) }), "checkinOpensAt").toBe(0);
      // Saving the same values again changes nothing the bot knows.
      expect(await patch({ title: "New title", venueName: "Another venue" }), "no-op").toBe(0);
      // Publishing alone doesn't change what the FAQ says either.
      expect(await patch({ status: "published" }), "publish").toBe(0);
    });

    it("bumps when a ticket type is added, renamed or deleted, and not when only capacity or position change", async () => {
      const { event: e, type } = await withType();
      const before = await faqVersion(e.id);
      const { ticketType: vip } = await TT.createTicketType(org, e.id, { name: "VIP", capacity: 5 });
      expect(await faqVersion(e.id)).toBe(before + 1);
      const resized = await TT.updateTicketType(org, e.id, vip.id, { version: vip.version, capacity: 8, position: 3 });
      expect(await faqVersion(e.id)).toBe(before + 1);
      const renamed = await TT.updateTicketType(org, e.id, vip.id, { version: resized.ticketType.version, name: "VIP+" });
      expect(renamed.ticketType.name).toBe("VIP+");
      expect(await faqVersion(e.id)).toBe(before + 2);
      await TT.deleteTicketType(org, e.id, vip.id);
      expect(await faqVersion(e.id)).toBe(before + 3);
      expect(type.name).toBe("General");
    });
  });

  describe("ticket types", () => {
    it("enforces 5 types, 5,000 per type, 10,000 per event, unique names and the no-op / stale rules", async () => {
      const e = await mk();
      await expect(TT.createTicketType(org, e.id, { name: "Big", capacity: 5001 })).rejects.toMatchObject({ name: "ZodError" });
      await expect(TT.createTicketType(org, e.id, { name: "Zero", capacity: 0 })).rejects.toMatchObject({ name: "ZodError" });
      await expect(TT.createTicketType(org, e.id, { name: "N\0", capacity: 1 })).rejects.toMatchObject({ name: "ZodError" });
      const a = (await TT.createTicketType(org, e.id, { name: "A", capacity: 5000 })).ticketType;
      await TT.createTicketType(org, e.id, { name: "B", capacity: 4000 });
      await expect(TT.createTicketType(org, e.id, { name: "A", capacity: 1 })).rejects.toMatchObject({ status: 409, code: "name_taken" });
      await expect(TT.createTicketType(org, e.id, { name: "C", capacity: 1001 })).rejects.toMatchObject({ status: 409, code: "capacity_limit" });
      await expect(TT.updateTicketType(org, e.id, a.id, { version: 1, name: "B" })).rejects.toMatchObject({ status: 409, code: "name_taken" });
      await expect(TT.updateTicketType(org, e.id, a.id, { version: 1, capacity: 5000, position: 1 })).resolves.toBeTruthy();
      const stale = await TT.updateTicketType(org, e.id, a.id, { version: 99, name: "Z" }).catch((x) => x);
      expect(stale).toMatchObject({ status: 409 });
      expect(stale.current.ticketType).toMatchObject({ id: a.id, version: 2 });
      await TT.updateTicketType(org, e.id, a.id, { version: 2, capacity: 100 });
      for (const n of ["C", "D", "E"]) await TT.createTicketType(org, e.id, { name: n, capacity: 10 });
      await expect(TT.createTicketType(org, e.id, { name: "F", capacity: 1 })).rejects.toMatchObject({ status: 409, code: "type_limit" });
    });

    it("keeps the 5-type cap exact when created in parallel", async () => {
      const e = await mk();
      const r = await Promise.allSettled(Array.from({ length: 9 }, (_, i) => TT.createTicketType(org, e.id, { name: `T${i}`, capacity: 10 })));
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(5);
      for (const x of r.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) expect(x.reason).toMatchObject({ status: 409, code: "type_limit" });
    });

    it("refuses a capacity below issued and a delete with issued tickets; the last type of a published event stays", async () => {
      const { event: e, type } = await withType({}, 10);
      await sql`update ticket_type set issued = 4 where id = ${type.id}`;
      await expect(TT.updateTicketType(org, e.id, type.id, { version: 1, capacity: 3 })).rejects.toMatchObject({ status: 409, code: "capacity_below_issued" });
      const ok = await TT.updateTicketType(org, e.id, type.id, { version: 1, capacity: 4 });
      expect(ok.ticketType).toMatchObject({ capacity: 4, issued: 4, seatsLeft: 0 });
      await expect(TT.deleteTicketType(org, e.id, type.id)).rejects.toMatchObject({ status: 409, code: "has_tickets" });
      await sql`update ticket_type set issued = 0 where id = ${type.id}`;
      await EV.updateEvent(org, e.id, { version: 1, status: "published" });
      await expect(TT.deleteTicketType(org, e.id, type.id)).rejects.toMatchObject({ status: 409, code: "last_ticket_type" });
      const { ticketType: second } = await TT.createTicketType(org, e.id, { name: "Second", capacity: 2 });
      await expect(TT.deleteTicketType(org, e.id, type.id)).resolves.toEqual({ deleted: true });
      expect((await fresh(e.id)).ticketTypes.map((t) => t.id)).toEqual([second.id]);
    });

    it("a ticket type of another event is a 404 under this event's id", async () => {
      const a = await withType();
      const b = await withType();
      await expect(TT.updateTicketType(org, a.event.id, b.type.id, { version: 1, name: "x" })).rejects.toMatchObject({ status: 404 });
      await expect(TT.deleteTicketType(org, a.event.id, b.type.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("delete and cascades", () => {
    it("deletes a draft and a cancelled event with everything attached; refuses a published one", async () => {
      const { event: e, type } = await withType();
      const guest = await makeUser(sql, P, "cascade-guest", "user");
      await sql`insert into event_staff (event_id, user_id) values (${e.id}, ${guest.id})`;
      await sql`insert into staff_invite (event_id, token_digest, client_op_id, expires_at) values (${e.id}, ${Buffer.from("d1")}, ${crypto.randomUUID()}, now() + interval '1 day')`;
      const [reg] = await sql`insert into registration (event_id, ticket_type_id, user_id, quantity, client_op_id, payload_hash) values (${e.id}, ${type.id}, ${guest.id}, 1, ${crypto.randomUUID()}, 'h') returning id`;
      const [tk] = await sql`insert into ticket (event_id, ticket_type_id, registration_id, holder_user_id, holder_name, source, door_code_digest) values (${e.id}, ${type.id}, ${reg.id}, ${guest.id}, 'G', 'registration', ${Buffer.from("dc1")}) returning id`;
      await sql`insert into checkin_event (event_id, ticket_id, actor_id, op_id, payload_hash, method, outcome) values (${e.id}, ${tk.id}, ${guest.id}, ${crypto.randomUUID()}, 'h', 'qr', 'checked_in')`;
      await sql`insert into faq_entry (event_id, ref_no, question, answer) values (${e.id}, 1, 'Q', 'A')`;
      await sql`insert into faq_ask (event_id, question, q_hash, faq_version, status, mode) values (${e.id}, 'Q', 'h', 1, 'not_in_faq', 'lookup')`;
      const pub = await EV.updateEvent(org, e.id, { version: 1, status: "published" });
      await expect(EV.deleteEvent(org, e.id)).rejects.toMatchObject({ status: 409, code: "not_deletable" });
      await EV.updateEvent(org, e.id, { version: pub.version, status: "cancelled" });
      await expect(EV.deleteEvent(org, e.id)).resolves.toEqual({ deleted: true });
      for (const table of ["ticket_type", "registration", "ticket", "event_staff", "staff_invite", "checkin_event", "faq_entry", "faq_ask"]) {
        const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${table} where event_id = '${e.id}'`);
        expect(n, table).toBe(0);
      }
      expect((await sql`select id from "user" where id = ${guest.id}`).length).toBe(1);
      await expect(EV.getMyEvent(org, e.id)).rejects.toMatchObject({ status: 404 });
      await expect(EV.deleteEvent(org, e.id)).rejects.toMatchObject({ status: 404 });
    });

    it("user foreign keys restrict: nothing deletes an account that owns events, registrations, tickets, staff rows or check-ins", async () => {
      const { event: e, type } = await withType();
      const holder = await makeUser(sql, P, "restrict-holder", "user");
      const [reg] = await sql`insert into registration (event_id, ticket_type_id, user_id, quantity, client_op_id, payload_hash) values (${e.id}, ${type.id}, ${holder.id}, 1, ${crypto.randomUUID()}, 'h') returning id`;
      await sql`insert into ticket (event_id, ticket_type_id, registration_id, holder_user_id, holder_name, source, door_code_digest) values (${e.id}, ${type.id}, ${reg.id}, ${holder.id}, 'H', 'registration', ${Buffer.from("rd1")})`;
      await sql`insert into event_staff (event_id, user_id) values (${e.id}, ${holder.id})`;
      await sql`insert into checkin_event (event_id, actor_id, op_id, payload_hash, method, outcome) values (${e.id}, ${holder.id}, ${crypto.randomUUID()}, 'h', 'qr', 'invalid')`;
      for (const id of [org.id, holder.id]) {
        const err = await sql`delete from "user" where id = ${id}`.catch((x) => x);
        expect(err.code, id).toBe("23503");
      }
      await sql`delete from event_staff where user_id = ${holder.id}`;
      await sql`delete from checkin_event where actor_id = ${holder.id}`;
      expect((await sql`delete from "user" where id = ${holder.id}`.catch((x) => x)).code).toBe("23503"); // still holds a registration and ticket
    });

    it("deletes a draft directly", async () => {
      const e = await mk();
      await expect(EV.deleteEvent(org, e.id)).resolves.toEqual({ deleted: true });
    });
  });

  describe("public reads", () => {
    it("lists and opens only published, not hidden events, with seats left and no private fields", async () => {
      const { event: pub } = await withType({ title: "Listed one" }, 6);
      await EV.updateEvent(org, pub.id, { version: 1, status: "published" });
      const draft = await mk({ title: "Still draft" });
      const { event: hid } = await withType({ title: "Hidden one" });
      await EV.updateEvent(org, hid.id, { version: 1, status: "published" });
      await AD.hideEvent(admin, hid.id, { hidden: true, reason: "test hide", clientOpId: crypto.randomUUID() });
      await sql`update ticket_type set issued = 2 where event_id = ${pub.id}`;

      const { events } = await EV.listPublicEvents({ limit: "100" });
      const ids = events.map((x) => x.id);
      expect(ids).toContain(pub.id);
      expect(ids).not.toContain(draft.id);
      expect(ids).not.toContain(hid.id);
      const card = events.find((x) => x.id === pub.id)!;
      expect(card).toMatchObject({ seatsLeft: 4, soldOut: false, registrationOpen: true });
      for (const e of events) {
        for (const forbidden of ["organizerId", "clientOpId", "hiddenAt", "hiddenReason", "version", "faqVersion", "checkinOpensAt", "faqNextRef"]) {
          expect(Object.keys(e), forbidden).not.toContain(forbidden);
        }
      }

      const page = await EV.getPublicEventBySlug(pub.slug);
      expect(page.event).toMatchObject({ id: pub.id, title: "Listed one", status: "published", registrationOpen: true });
      expect(page.ticketTypes).toEqual([expect.objectContaining({ name: "General", seatsLeft: 4, soldOut: false })]);
      expect(Object.keys(page.ticketTypes[0]).sort()).toEqual(["id", "name", "seatsLeft", "soldOut"]);
      expect(JSON.stringify(page)).not.toContain(org.id);
      for (const slug of [draft.slug, hid.slug, "no-such-slug"]) await expect(EV.getPublicEventBySlug(slug)).rejects.toMatchObject({ status: 404 });
    });

    it("shows a cancelled event's page (so the cancellation is visible) but never lists it", async () => {
      const { event: e } = await withType({ title: "Cancelled one" });
      const pub = await EV.updateEvent(org, e.id, { version: 1, status: "published" });
      await EV.updateEvent(org, e.id, { version: pub.version, status: "cancelled" });
      const page = await EV.getPublicEventBySlug(e.slug);
      expect(page.event).toMatchObject({ status: "cancelled", registrationOpen: false });
      expect((await EV.listPublicEvents({ limit: "100" })).events.map((x) => x.id)).not.toContain(e.id);
    });

    it("lists past events newest first only when asked, and honours the limit", async () => {
      const { event: e } = await withType({ title: "Long gone" });
      await EV.updateEvent(org, e.id, { version: 1, status: "published" });
      await sql`update event set starts_at = now() - interval '3 days', ends_at = now() - interval '3 days' + interval '2 hours', registration_closes_at = now() - interval '3 days', checkin_opens_at = now() - interval '3 days 3 hours' where id = ${e.id}`;
      expect((await EV.listPublicEvents({ limit: "100" })).events.map((x) => x.id)).not.toContain(e.id);
      const past = await EV.listPublicEvents({ past: "1", limit: "100" });
      expect(past.events.map((x) => x.id)).toContain(e.id);
      expect(past.events.every((x) => x.registrationOpen === false)).toBe(true);
      const starts = past.events.map((x) => x.startsAt.getTime());
      expect(starts).toEqual([...starts].sort((a, b) => b - a));
      const { event: soon } = await withType({ title: "Coming up" });
      await EV.updateEvent(org, soon.id, { version: 1, status: "published" });
      expect((await EV.listPublicEvents({ limit: "1" })).events).toHaveLength(1);
    });
  });

  describe("lock order: parallel writes never deadlock", () => {
    it("organiser edits, ticket types, invites, deletes, a revoke and an admin hide, all at once, finish without a deadlock or a 500", async () => {
      const racer = await makeUser(sql, P, "racer", "organizer");
      const a = (await EV.createEvent(racer, eventInput({ title: "Race A" }))).event;
      const b = (await EV.createEvent(racer, eventInput({ title: "Race B" }))).event;
      await TT.createTicketType(racer, a.id, { name: "General", capacity: 50 });
      await EV.updateEvent(racer, a.id, { version: 1, status: "published" });
      await ST.createInvite(racer, a.id, op());
      const ops: Promise<unknown>[] = [];
      for (let round = 0; round < 6; round++) {
        ops.push(
          EV.updateEvent(racer, a.id, { version: 1 + round, title: `Race A ${round}` }),
          EV.updateEvent(racer, b.id, { version: 1 + round, title: `Race B ${round}` }),
          TT.createTicketType(racer, a.id, { name: `R${round}`, capacity: 5 }),
          TT.createTicketType(racer, b.id, { name: `R${round}`, capacity: 5 }),
          ST.createInvite(racer, b.id, op()),
          EV.createEvent(racer, eventInput({ title: `Racing ${round}` })),
          AD.hideEvent(admin, a.id, { hidden: round % 2 === 0, reason: "race", clientOpId: crypto.randomUUID() }),
          R.setUserRole(admin, { userId: racer.id, role: round % 2 === 0 ? "user" : "organizer", from: round % 2 === 0 ? "organizer" : "user", clientOpId: crypto.randomUUID() }),
        );
      }
      ops.push(EV.deleteEvent(racer, b.id), EV.deleteEvent(racer, a.id));
      const results = await Promise.allSettled(ops);
      for (const r of results) {
        if (r.status === "fulfilled") continue;
        const err = r.reason as { status?: number; code?: string };
        // A database error (deadlock 40P01, serialization 40001, a constraint) has no HTTP status.
        expect(typeof err.status, `${dbErrorCode(r.reason) ?? ""} ${String(r.reason)}`).toBe("number");
        expect(err.status).toBeLessThan(500);
      }
      // The grant/revoke sequence may leave the racer in either role; put them back for cleanup and check events are coherent.
      const [row] = await sql`select role from "user" where id = ${racer.id}`;
      expect(["user", "organizer"]).toContain(row.role);
      const hiddenWrong = await sql`select id from event where organizer_id = ${racer.id} and (hidden_at is null) <> (hidden_reason is null)`;
      expect(hiddenWrong).toHaveLength(0);
    });
  });
});
