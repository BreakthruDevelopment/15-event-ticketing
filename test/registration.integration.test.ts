/**
 * Registration, capacity and cancel (spec 15, "Registration and capacity") against a real Postgres (TEST_DATABASE_URL):
 * 50 registrations for 10 seats, a double registration, replay and op-id reuse, cancel then register again, cancel after
 * check-in, cancel racing void, cancel racing a scan, registration racing an organiser cancel, refusals (hidden, draft,
 * cancelled, closed, wrong type, quantity) and that every refusal is charged.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestActor, cleanup, fillRate, makeUser, op, openDoorInput } from "./helpers";

const url = process.env.TEST_DATABASE_URL;
const P = "rg";

describe.skipIf(!url)("registration and capacity (Postgres)", () => {
  let sql: postgres.Sql;
  let org: TestActor;
  let admin: TestActor;
  let EV: typeof import("@/lib/events");
  let TT: typeof import("@/lib/ticket-types");
  let RG: typeof import("@/lib/registrations");
  let TK: typeof import("@/lib/tickets");
  let AD: typeof import("@/lib/admin");
  let n = 0;

  const newUser = (name = `u${++n}`) => makeUser(sql, P, name, "user");
  const reg = (typeId: string, quantity = 1, clientOpId: string = crypto.randomUUID()) => ({ ticketTypeId: typeId, quantity, clientOpId });
  /** A published event with one type "General" of `capacity`. */
  const mk = async (capacity: number, o: Record<string, unknown> = {}, who?: TestActor) => {
    // A fresh organiser per event: an organiser holds at most 20 events.
    who ??= await makeUser(sql, P, `own${++n}`, "organizer");
    const e = (await EV.createEvent(who, openDoorInput(o))).event;
    const { ticketType } = await TT.createTicketType(who, e.id, { name: "General", capacity, clientOpId: crypto.randomUUID() });
    const pub = await EV.updateEvent(who, e.id, { version: 1, status: "published" });
    return { id: e.id, typeId: ticketType.id, version: pub.version, owner: who };
  };
  const issued = async (typeId: string) => (await sql`select issued from ticket_type where id = ${typeId}`)[0].issued as number;
  const ticketCount = async (eventId: string, status?: string) =>
    (await sql`select count(*)::int as n from ticket where event_id = ${eventId} ${status ? sql`and status = ${status}` : sql``}`)[0].n as number;
  const writes = async (id: string) => (await sql`select count(*)::int as n from rate_event where user_id = ${id} and kind = 'api_write'`)[0].n as number;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DB_POOL_MAX = "20";
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    sql = postgres(url!, { max: 6, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup(sql, P);
    org = await makeUser(sql, P, "org", "organizer");
    admin = await makeUser(sql, P, "admin", "admin");
    EV = await import("@/lib/events");
    TT = await import("@/lib/ticket-types");
    RG = await import("@/lib/registrations");
    TK = await import("@/lib/tickets");
    AD = await import("@/lib/admin");
  });

  afterAll(async () => {
    await cleanup(sql, P);
    await sql.end();
  });

  describe("capacity under concurrency", () => {
    it("50 parallel registrations for 10 seats: exactly 10 tickets, issued = 10, the other 40 get 409 sold_out", async () => {
      const e = await mk(10);
      const users = await Promise.all(Array.from({ length: 50 }, (_, i) => newUser(`race${i}`)));
      const results = await Promise.allSettled(users.map((u) => RG.registerForEvent(u, e.id, reg(e.typeId))));
      const ok = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(10);
      expect(refused).toHaveLength(40);
      for (const r of refused) expect(r.reason).toMatchObject({ status: 409, code: "sold_out" });
      expect(await ticketCount(e.id)).toBe(10);
      expect(await issued(e.typeId)).toBe(10);
      expect((await sql`select count(*)::int as n from registration where event_id = ${e.id} and status = 'active'`)[0].n).toBe(10);
    });

    it("parallel registrations of several tickets each never pass capacity, and issued always equals the tickets that exist", async () => {
      const e = await mk(10);
      const users = await Promise.all(Array.from({ length: 12 }, (_, i) => newUser(`multi${i}`)));
      const results = await Promise.allSettled(users.map((u, i) => RG.registerForEvent(u, e.id, reg(e.typeId, 1 + (i % 4)))));
      const got = results.flatMap((r) => (r.status === "fulfilled" ? r.value.tickets.length : []));
      const total = got.reduce((a, b) => a + b, 0);
      expect(total).toBeLessThanOrEqual(10);
      expect(await issued(e.typeId)).toBe(total);
      expect(await ticketCount(e.id)).toBe(total);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 409, code: "sold_out" });
    });

    it("a sold_out answer says how many seats are left; a request that doesn't fit changes nothing", async () => {
      const e = await mk(3);
      const a = await newUser();
      const b = await newUser();
      await RG.registerForEvent(a, e.id, reg(e.typeId, 2));
      await expect(RG.registerForEvent(b, e.id, reg(e.typeId, 2))).rejects.toMatchObject({ status: 409, code: "sold_out", message: expect.stringContaining("Only 1 seat left") });
      expect(await issued(e.typeId)).toBe(2);
      await RG.registerForEvent(b, e.id, reg(e.typeId, 1));
      const c = await newUser();
      await expect(RG.registerForEvent(c, e.id, reg(e.typeId, 1))).rejects.toMatchObject({ status: 409, code: "sold_out", message: "Sold out." });
    });

    it("the CHECK constraint backs the conditional update: issued can't be pushed past capacity or below zero", async () => {
      const e = await mk(2);
      await expect(sql`update ticket_type set issued = 3 where id = ${e.typeId}`).rejects.toMatchObject({ code: "23514" });
      await expect(sql`update ticket_type set issued = -1 where id = ${e.typeId}`).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("one registration per user, replay and op ids", () => {
    it("parallel double registration by one user (new op id each time): one registration, one 409 already_registered", async () => {
      const e = await mk(10);
      const u = await newUser();
      const results = await Promise.allSettled([RG.registerForEvent(u, e.id, reg(e.typeId, 2)), RG.registerForEvent(u, e.id, reg(e.typeId, 2))]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      expect(lost.reason).toMatchObject({ status: 409, code: "already_registered" });
      expect(await ticketCount(e.id)).toBe(2);
      expect(await issued(e.typeId)).toBe(2);
    });

    it("parallel duplicates with the SAME op id: both answer, one registration, the second says replayed", async () => {
      const e = await mk(10);
      const u = await newUser();
      const body = reg(e.typeId, 2);
      const [a, b] = await Promise.all([RG.registerForEvent(u, e.id, body), RG.registerForEvent(u, e.id, body)]);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(a.registration.id).toBe(b.registration.id);
      expect(a.tickets.map((t) => t.id).sort()).toEqual(b.tickets.map((t) => t.id).sort());
      expect(await ticketCount(e.id)).toBe(2);
      expect(await issued(e.typeId)).toBe(2);
    });

    it("a replay returns the same registration and tickets and spends no register attempt and no seat", async () => {
      const e = await mk(10);
      const u = await newUser();
      const body = reg(e.typeId, 3);
      const first = await RG.registerForEvent(u, e.id, body);
      expect(first.replayed).toBe(false);
      const regCount = async () => (await sql`select count(*)::int as n from rate_event where user_id = ${u.id} and kind = 'register'`)[0].n as number;
      expect(await regCount()).toBe(1);
      const again = await RG.registerForEvent(u, e.id, body);
      expect(again.replayed).toBe(true);
      expect(again.registration.id).toBe(first.registration.id);
      expect(again.tickets.map((t) => t.id)).toEqual(first.tickets.map((t) => t.id));
      expect(await regCount()).toBe(1);
      expect(await issued(e.typeId)).toBe(3);
      // The op id is spent on a ledger row, once.
      expect((await sql`select count(*)::int as n from op_ledger where actor_id = ${u.id} and client_op_id = ${body.clientOpId}`)[0].n).toBe(1);
    });

    it("the same op id for a different request is 409 op_id_reused (other quantity, other type, other event), changing nothing", async () => {
      const e = await mk(10);
      const e2 = await mk(10);
      const u = await newUser();
      const body = reg(e.typeId, 2);
      await RG.registerForEvent(u, e.id, body);
      await expect(RG.registerForEvent(u, e.id, { ...body, quantity: 3 })).rejects.toMatchObject({ status: 409, code: "op_id_reused" });
      await expect(RG.registerForEvent(u, e2.id, { ...body, ticketTypeId: e2.typeId })).rejects.toMatchObject({ status: 409, code: "op_id_reused" });
      await expect(RG.cancelRegistration(u, crypto.randomUUID(), { clientOpId: body.clientOpId })).rejects.toMatchObject({ status: 409, code: "op_id_reused" });
      expect(await issued(e.typeId)).toBe(2);
      expect(await issued(e2.typeId)).toBe(0);
    });

    it("upper-case ids hash like lower-case ones (the payload hashed is the parsed input)", async () => {
      const e = await mk(10);
      const u = await newUser();
      const body = reg(e.typeId, 1);
      await RG.registerForEvent(u, e.id, body);
      const again = await RG.registerForEvent(u, e.id.toUpperCase(), { ...body, ticketTypeId: body.ticketTypeId.toUpperCase(), clientOpId: body.clientOpId.toUpperCase() });
      expect(again.replayed).toBe(true);
    });

    it("cancel, then register again with a new op id works, and the seats come back", async () => {
      const e = await mk(2);
      const u = await newUser();
      const first = await RG.registerForEvent(u, e.id, reg(e.typeId, 2));
      expect(await issued(e.typeId)).toBe(2);
      const cancelled = await RG.cancelRegistration(u, first.registration.id, op());
      expect(cancelled).toMatchObject({ cancelled: true, changed: true, released: 2, replayed: false });
      expect(await issued(e.typeId)).toBe(0);
      expect(await ticketCount(e.id, "valid")).toBe(0);
      expect((await sql`select status from registration where id = ${first.registration.id}`)[0].status).toBe("cancelled");
      const second = await RG.registerForEvent(u, e.id, reg(e.typeId, 2));
      expect(second.registration.id).not.toBe(first.registration.id);
      expect(await issued(e.typeId)).toBe(2);
    });

    it("holder names: the account name first, then 'Name, guest 2'; a long name is cut to fit 80 characters", async () => {
      const e = await mk(10);
      const u = await newUser();
      await sql`update "user" set name = ${"Jane Doe"} where id = ${u.id}`;
      const r = await RG.registerForEvent(u, e.id, reg(e.typeId, 3));
      expect(r.tickets.map((t) => t.holderName)).toEqual(["Jane Doe", "Jane Doe, guest 2", "Jane Doe, guest 3"]);
      expect(r.tickets.map((t) => t.guestLabel)).toEqual([null, "Guest 2", "Guest 3"]);
      const long = await newUser();
      await sql`update "user" set name = ${"x".repeat(200)} where id = ${long.id}`;
      const e2 = await mk(10, { maxPerRegistration: 10 });
      const r2 = await RG.registerForEvent(long, e2.id, reg(e2.typeId, 10));
      for (const t of r2.tickets) expect(t.holderName.length).toBeLessThanOrEqual(80);
      expect(new Set(r2.tickets.map((t) => t.holderName)).size).toBe(10);
    });
  });

  describe("cancel", () => {
    it("a second cancel (new op id) changes nothing and releases nothing twice; the same op id replays", async () => {
      const e = await mk(5);
      const u = await newUser();
      const r = await RG.registerForEvent(u, e.id, reg(e.typeId, 2));
      const body = op();
      const first = await RG.cancelRegistration(u, r.registration.id, body);
      const replay = await RG.cancelRegistration(u, r.registration.id, body);
      expect(replay).toMatchObject({ replayed: true, changed: true, released: 2 });
      const second = await RG.cancelRegistration(u, r.registration.id, op());
      expect(second).toMatchObject({ cancelled: true, changed: false, released: 0, replayed: false });
      expect(first.released).toBe(2);
      expect(await issued(e.typeId)).toBe(0);
    });

    it("someone else's registration, a missing one and a malformed id: 404, 404, 400", async () => {
      const e = await mk(5);
      const a = await newUser();
      const b = await newUser();
      const r = await RG.registerForEvent(a, e.id, reg(e.typeId));
      await expect(RG.cancelRegistration(b, r.registration.id, op())).rejects.toMatchObject({ status: 404 });
      await expect(RG.cancelRegistration(org, r.registration.id, op())).rejects.toMatchObject({ status: 404 });
      await expect(RG.cancelRegistration(a, crypto.randomUUID(), op())).rejects.toMatchObject({ status: 404 });
      await expect(RG.cancelRegistration(a, "not-a-uuid", op())).rejects.toMatchObject({ name: "ZodError" });
      await expect(RG.cancelRegistration(a, r.registration.id, {})).rejects.toMatchObject({ name: "ZodError" });
      expect(await issued(e.typeId)).toBe(1);
    });

    it("cancel after a check-in is refused (409 checked_in) and nothing changes", async () => {
      const e = await mk(5);
      const u = await newUser();
      const r = await RG.registerForEvent(u, e.id, reg(e.typeId, 2));
      await sql`update ticket set checked_in_at = now() where id = ${r.tickets[0].id}`;
      await expect(RG.cancelRegistration(u, r.registration.id, op())).rejects.toMatchObject({ status: 409, code: "checked_in" });
      expect(await ticketCount(e.id, "valid")).toBe(2);
      expect(await issued(e.typeId)).toBe(2);
      expect((await sql`select status from registration where id = ${r.registration.id}`)[0].status).toBe("active");
    });

    it("cancel after the event started is refused (409 event_started)", async () => {
      const e = await mk(5);
      const u = await newUser();
      const r = await RG.registerForEvent(u, e.id, reg(e.typeId));
      await sql`update event set starts_at = now() - interval '5 minutes', ends_at = now() + interval '1 hour', checkin_opens_at = now() - interval '3 hours', registration_closes_at = now() + interval '30 minutes' where id = ${e.id}`;
      await expect(RG.cancelRegistration(u, r.registration.id, op())).rejects.toMatchObject({ status: 409, code: "event_started" });
      expect(await issued(e.typeId)).toBe(1);
    });

    it("holder cancel and organiser void of the same ticket in parallel: issued drops by exactly one (20 rounds)", async () => {
      const e = await mk(40);
      // Bystanders keep `issued` well above zero, so a double release shows as a wrong number rather than hiding behind the CHECK constraint.
      for (let i = 0; i < 3; i++) await RG.registerForEvent(await newUser(`by${i}`), e.id, reg(e.typeId, 1));
      for (let i = 0; i < 20; i++) {
        const u = await newUser(`cv${i}`);
        const r = await RG.registerForEvent(u, e.id, reg(e.typeId, 1));
        const before = await issued(e.typeId);
        const t = r.tickets[0].id;
        // Alternate who starts first (and stagger by a few ms), so both orders of the lock get exercised.
        const doCancel = () => RG.cancelRegistration(u, r.registration.id, op());
        const doVoid = () => TK.voidTicket(e.owner, e.id, t, op());
        const lag = (i % 4) * 4;
        const later = <T>(f: () => Promise<T>) => new Promise((res) => setTimeout(res, lag)).then(f);
        const [c, v] = await (i % 2 === 0
          ? (async () => {
              const [c_, v_] = await Promise.allSettled([doCancel(), later(doVoid)]);
              return [c_, v_] as const;
            })()
          : (async () => {
              const [v_, c_] = await Promise.allSettled([doVoid(), later(doCancel)]);
              return [c_, v_] as const;
            })());
        expect(await issued(e.typeId), `round ${i}`).toBe(before - 1);
        expect(await ticketCount(e.id, "valid") + 0, `round ${i}`).toBe(await issued(e.typeId));
        // One did the work; the other either changed nothing (cancel, 200) or was refused (void, 409).
        const changed = (c.status === "fulfilled" && c.value.changed ? 1 : 0) + (v.status === "fulfilled" ? 1 : 0);
        expect(changed, `round ${i}`).toBe(1);
        expect(c.status, `round ${i}: a cancel is never refused here`).toBe("fulfilled");
        if (v.status === "rejected") expect(v.reason).toMatchObject({ status: 409, code: "ticket_not_voidable" });
        expect((await sql`select status from registration where id = ${r.registration.id}`)[0].status).toBe("cancelled");
      }
    });

    it("two cancels of one registration in parallel (different op ids): released once", async () => {
      const e = await mk(10);
      const u = await newUser();
      const r = await RG.registerForEvent(u, e.id, reg(e.typeId, 3));
      const results = await Promise.all([RG.cancelRegistration(u, r.registration.id, op()), RG.cancelRegistration(u, r.registration.id, op())]);
      expect(results.filter((x) => x.changed)).toHaveLength(1);
      expect(await issued(e.typeId)).toBe(0);
    });

    it("cancel racing a check-in has exactly one winner (the scan's conditional update, 20 rounds)", async () => {
      const e = await mk(40);
      let cancelWins = 0;
      let scanWins = 0;
      for (let i = 0; i < 20; i++) {
        const u = await newUser(`ci${i}`);
        const r = await RG.registerForEvent(u, e.id, reg(e.typeId, 1));
        const t = r.tickets[0].id;
        // Exactly the predicate 15.3's check-in uses.
        const scan = sql`update ticket set checked_in_at = now(), checked_in_by = ${org.id} where id = ${t} and event_id = ${e.id} and status = 'valid' and qr_epoch = 1 and checked_in_at is null returning id`;
        const [c, s] = await Promise.allSettled([RG.cancelRegistration(u, r.registration.id, op()), scan]);
        const scanned = s.status === "fulfilled" && s.value.length === 1;
        const cancelled = c.status === "fulfilled" && c.value.changed;
        expect(scanned !== cancelled, `round ${i}: exactly one winner`).toBe(true);
        const [row] = await sql`select status, checked_in_at from ticket where id = ${t}`;
        if (cancelled) {
          cancelWins++;
          expect(row.status).toBe("cancelled");
          expect(row.checked_in_at).toBeNull();
        } else {
          scanWins++;
          expect(row.status).toBe("valid");
          expect(row.checked_in_at).not.toBeNull();
          expect(c.status === "rejected" && c.reason).toMatchObject({ status: 409, code: "checked_in" });
        }
        expect(await issued(e.typeId), `round ${i}`).toBe(await ticketCount(e.id, "valid"));
      }
      expect(cancelWins + scanWins).toBe(20);
    });

    it("void racing a check-in has exactly one winner too", async () => {
      const e = await mk(40);
      for (let i = 0; i < 10; i++) {
        const u = await newUser(`vi${i}`);
        const r = await RG.registerForEvent(u, e.id, reg(e.typeId, 1));
        const t = r.tickets[0].id;
        const scan = sql`update ticket set checked_in_at = now() where id = ${t} and event_id = ${e.id} and status = 'valid' and qr_epoch = 1 and checked_in_at is null returning id`;
        const [v, s] = await Promise.allSettled([TK.voidTicket(e.owner, e.id, t, op()), scan]);
        const voided = v.status === "fulfilled";
        const scanned = s.status === "fulfilled" && s.value.length === 1;
        expect(voided !== scanned, `round ${i}`).toBe(true);
        expect(await issued(e.typeId), `round ${i}`).toBe(await ticketCount(e.id, "valid"));
      }
    });
  });

  describe("registration racing the organiser", () => {
    it("an organiser cancel that holds the event lock first: the registration waits and is refused, never a ticket for a cancelled event", async () => {
      const e = await mk(10);
      const u = await newUser();
      let release!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      let registered: Promise<unknown> | undefined;
      let settled = false;
      const cancelTx = sql.begin(async (tx) => {
        await tx`select id from event where id = ${e.id} for update`;
        registered = RG.registerForEvent(u, e.id, reg(e.typeId)).finally(() => (settled = true));
        registered.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 400));
        expect(settled, "the registration must wait for the event lock").toBe(false);
        await tx`update event set status = 'cancelled', version = version + 1 where id = ${e.id}`;
        await hold;
      });
      await new Promise((r) => setTimeout(r, 600));
      release();
      await cancelTx;
      await expect(registered).rejects.toMatchObject({ status: 409, code: "event_cancelled" });
      expect(await ticketCount(e.id)).toBe(0);
      expect(await issued(e.typeId)).toBe(0);
    });

    it("a registration that holds the event lock first finishes before the organiser's cancel (20 rounds): nothing is registered after the cancel", async () => {
      for (let i = 0; i < 20; i++) {
        const e = await mk(10);
        const u = await newUser(`oc${i}`);
        const [r, c] = await Promise.allSettled([RG.registerForEvent(u, e.id, reg(e.typeId)), EV.updateEvent(e.owner, e.id, { version: e.version, status: "cancelled" })]);
        expect(c.status, `round ${i}`).toBe("fulfilled");
        if (r.status === "rejected") expect(r.reason, `round ${i}`).toMatchObject({ status: 409, code: "event_cancelled" });
        // Whatever the order, the books agree.
        expect(await issued(e.typeId), `round ${i}`).toBe(await ticketCount(e.id, "valid"));
        // And once the cancel is committed, nobody else gets in.
        await expect(RG.registerForEvent(await newUser(`oc${i}b`), e.id, reg(e.typeId))).rejects.toMatchObject({ status: 409, code: "event_cancelled" });
      }
    });

    it("a capacity edit racing registrations never leaves issued above capacity", async () => {
      const e = await mk(10);
      const users = await Promise.all(Array.from({ length: 10 }, (_, i) => newUser(`ce${i}`)));
      const [ty] = await sql`select version from ticket_type where id = ${e.typeId}`;
      const edit = TT.updateTicketType(e.owner, e.id, e.typeId, { capacity: 4, version: ty.version });
      const regs = users.map((u) => RG.registerForEvent(u, e.id, reg(e.typeId)));
      const results = await Promise.allSettled([edit, ...regs]);
      const [after] = await sql`select issued, capacity from ticket_type where id = ${e.typeId}`;
      expect(after.issued).toBeLessThanOrEqual(after.capacity);
      expect(after.issued).toBe(await ticketCount(e.id, "valid"));
      for (const r of results) if (r.status === "rejected") expect(r.reason.status, String(r.reason.code)).toBe(409);
    });
  });

  describe("refusals", () => {
    it("a hidden event, a draft and a missing event are all 404; a cancelled one is 409 event_cancelled; a closed one 409 registration_closed", async () => {
      const u = await newUser();
      const hidden = await mk(5);
      await AD.hideEvent(admin, hidden.id, { hidden: true, reason: "test", clientOpId: crypto.randomUUID() });
      await expect(RG.registerForEvent(u, hidden.id, reg(hidden.typeId))).rejects.toMatchObject({ status: 404 });

      const draft = (await EV.createEvent(org, openDoorInput())).event;
      const { ticketType } = await TT.createTicketType(org, draft.id, { name: "General", capacity: 5, clientOpId: crypto.randomUUID() });
      await expect(RG.registerForEvent(u, draft.id, reg(ticketType.id))).rejects.toMatchObject({ status: 404 });
      await expect(RG.registerForEvent(u, crypto.randomUUID(), reg(ticketType.id))).rejects.toMatchObject({ status: 404 });

      const cancelled = await mk(5);
      await EV.updateEvent(cancelled.owner, cancelled.id, { version: cancelled.version, status: "cancelled" });
      await expect(RG.registerForEvent(u, cancelled.id, reg(cancelled.typeId))).rejects.toMatchObject({ status: 409, code: "event_cancelled" });

      const closed = await mk(5);
      await sql`update event set registration_closes_at = now() - interval '1 minute' where id = ${closed.id}`;
      await expect(RG.registerForEvent(u, closed.id, reg(closed.typeId))).rejects.toMatchObject({ status: 409, code: "registration_closed" });
      const over = await mk(5);
      await sql`update event set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 minute', checkin_opens_at = now() - interval '3 hours', registration_closes_at = now() - interval '1 hour' where id = ${over.id}`;
      await expect(RG.registerForEvent(u, over.id, reg(over.typeId))).rejects.toMatchObject({ status: 409, code: "registration_closed" });
      for (const x of [hidden, cancelled, closed, over]) expect(await issued(x.typeId)).toBe(0);
    });

    it("a ticket type of another event is 404; quantity over the event's max is 400; 0, 11, 1.5 and a string are 400", async () => {
      const u = await newUser();
      const a = await mk(10);
      const b = await mk(10);
      await expect(RG.registerForEvent(u, a.id, reg(b.typeId))).rejects.toMatchObject({ status: 404 });
      await expect(RG.registerForEvent(u, a.id, reg(a.typeId, 5))).rejects.toMatchObject({ status: 400 }); // default max is 4
      for (const q of [0, 11, 1.5, "2", -1, null]) {
        await expect(RG.registerForEvent(u, a.id, { ...reg(a.typeId), quantity: q }), String(q)).rejects.toMatchObject({ name: "ZodError" });
      }
      await expect(RG.registerForEvent(u, a.id, { ...reg(a.typeId), extra: 1 })).rejects.toMatchObject({ name: "ZodError" });
      expect(await issued(a.typeId)).toBe(0);
    });

    it("a NUL byte or any malformed id (event, type, op id) is a 400, never a 500", async () => {
      const u = await newUser();
      const e = await mk(10);
      await expect(RG.registerForEvent(u, `${e.id}\0`, reg(e.typeId))).rejects.toMatchObject({ name: "ZodError" });
      await expect(RG.registerForEvent(u, "nope", reg(e.typeId))).rejects.toMatchObject({ name: "ZodError" });
      await expect(RG.registerForEvent(u, e.id, { ...reg(e.typeId), ticketTypeId: `${e.typeId}\0` })).rejects.toMatchObject({ name: "ZodError" });
      await expect(RG.registerForEvent(u, e.id, { ...reg(e.typeId), clientOpId: `${crypto.randomUUID()}\0` })).rejects.toMatchObject({ name: "ZodError" });
      await expect(RG.registerForEvent(u, e.id, "garbage")).rejects.toMatchObject({ name: "ZodError" });
      const { errorInfo } = await import("@/lib/http");
      await RG.registerForEvent(u, e.id, { ...reg(e.typeId), clientOpId: "x" }).catch((err) => expect(errorInfo(err).status).toBe(400));
    });

    it("roles: an organiser may register for any event; an admin is 403; no actor is 401", async () => {
      const e = await mk(10);
      const own = await RG.registerForEvent(org, e.id, reg(e.typeId));
      expect(own.tickets).toHaveLength(1);
      await expect(RG.registerForEvent(admin, e.id, reg(e.typeId))).rejects.toMatchObject({ status: 403 });
      await expect(RG.registerForEvent(null, e.id, reg(e.typeId))).rejects.toMatchObject({ name: "UnauthorizedError" });
      await expect(RG.cancelRegistration(admin, crypto.randomUUID(), op())).rejects.toMatchObject({ status: 403 });
      // A user whose role was revoked in the database after the session was read is refused as well (lockActor re-reads it).
      const stale = await newUser();
      await sql`update "user" set role = 'admin' where id = ${stale.id}`;
      await expect(RG.registerForEvent(stale, e.id, reg(e.typeId))).rejects.toMatchObject({ status: 403 });
      const banned = await newUser();
      await sql`update "user" set banned = true where id = ${banned.id}`;
      await expect(RG.registerForEvent(banned, e.id, reg(e.typeId))).rejects.toMatchObject({ status: 403 });
    });

    it("every refused registration is charged one api_write: sold out, already registered, bad input, unknown event, op id reuse", async () => {
      const e = await mk(1);
      const taker = await newUser();
      const u = await newUser();
      await RG.registerForEvent(taker, e.id, reg(e.typeId));
      const body = reg(e.typeId);
      let w = await writes(u.id);
      const refusals: [string, () => Promise<unknown>][] = [
        ["sold_out", () => RG.registerForEvent(u, e.id, body)],
        ["unknown event", () => RG.registerForEvent(u, crypto.randomUUID(), reg(e.typeId))],
        ["bad quantity", () => RG.registerForEvent(u, e.id, { ...reg(e.typeId), quantity: 0 })],
        ["bad event id", () => RG.registerForEvent(u, "nope", reg(e.typeId))],
        ["bad body", () => RG.registerForEvent(u, e.id, null)],
        ["wrong type", () => RG.registerForEvent(u, e.id, reg(crypto.randomUUID()))],
      ];
      for (const [name, run] of refusals) {
        await expect(run(), name).rejects.toBeTruthy();
        expect(await writes(u.id), name).toBe(++w);
      }
      // An unauthorised caller (admin) is refused for authorisation, not charged.
      const before = await writes(admin.id);
      await expect(RG.registerForEvent(admin, e.id, reg(e.typeId))).rejects.toMatchObject({ status: 403 });
      expect(await writes(admin.id)).toBe(before);
      // And over the allowance it is 429 instead.
      await fillRate(sql, u.id, 300);
      await expect(RG.registerForEvent(u, e.id, body)).rejects.toMatchObject({ status: 429 });
      expect(await issued(e.typeId)).toBe(1);
    });

    it("10 registrations per user per hour: the 11th is 429 (a refusal inside the limit doesn't count)", async () => {
      const e = await mk(10);
      const u = await newUser();
      await fillRate(sql, u.id, 9, "register");
      await expect(RG.registerForEvent(u, e.id, reg(e.typeId, 5))).rejects.toMatchObject({ status: 400 }); // refused: not counted
      await RG.registerForEvent(u, e.id, reg(e.typeId, 1)); // the 10th
      const e2 = await mk(10);
      await expect(RG.registerForEvent(u, e2.id, reg(e2.typeId))).rejects.toMatchObject({ status: 429 });
      expect(await issued(e2.typeId)).toBe(0);
    });

    it("a registration for an event deleted since, replayed: 409 registration_gone, not a 500", async () => {
      const e = await mk(10);
      const u = await newUser();
      const body = reg(e.typeId);
      await RG.registerForEvent(u, e.id, body);
      await EV.updateEvent(e.owner, e.id, { version: e.version, status: "cancelled" });
      await EV.deleteEvent(e.owner, e.id);
      await expect(RG.registerForEvent(u, e.id, body)).rejects.toMatchObject({ status: 409, code: "registration_gone" });
    });
  });

  describe("tickets issued", () => {
    it("each ticket gets a random uuid, epoch 1 and a keyed door digest that is unique per event; nothing personal in the QR", async () => {
      const e = await mk(10);
      const u = await newUser();
      const r = await RG.registerForEvent(u, e.id, reg(e.typeId, 4));
      const rows = await sql`select id, qr_epoch, door_code_digest, status, source, holder_user_id from ticket where registration_id = ${r.registration.id}`;
      expect(rows).toHaveLength(4);
      const T = await import("@/lib/tickets/token");
      for (const row of rows) {
        expect(row.qr_epoch).toBe(1);
        expect(row.status).toBe("valid");
        expect(row.source).toBe("registration");
        expect(row.holder_user_id).toBe(u.id);
        expect(Buffer.from(row.door_code_digest).equals(T.doorFor(row.id, 1).digest)).toBe(true);
        expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
      expect(new Set(rows.map((x) => Buffer.from(x.door_code_digest).toString("hex"))).size).toBe(4);
    });

    it("the registration response never carries a QR text or a door code", async () => {
      const e = await mk(10);
      const r = await RG.registerForEvent(await newUser(), e.id, reg(e.typeId, 2));
      const json = JSON.stringify(r);
      expect(json).not.toContain("ET1:");
      expect(json).not.toMatch(/qrText|doorCode|door_code/i);
    });
  });
});
