/**
 * Door staff against a real Postgres (TEST_DATABASE_URL): invites (digest only, fragment link, single use, 72 h,
 * identical answers for unknown, used and expired tokens), accept, remove, caps, and the lock order under parallel accepts.
 */
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestActor, cleanup, makeUser, op, openDoorInput } from "./helpers";

const url = process.env.TEST_DATABASE_URL;
const P = "st";

describe.skipIf(!url)("door staff (Postgres)", () => {
  let sql: postgres.Sql;
  let org: TestActor;
  let org2: TestActor;
  let admin: TestActor;
  let EV: typeof import("@/lib/events");
  let TT: typeof import("@/lib/ticket-types");
  let ST: typeof import("@/lib/staff");
  let AC: typeof import("@/lib/access");
  let D: ReturnType<typeof import("@/lib/db").db>;
  let event: { id: string; slug: string };
  let n = 0;

  const tokenOf = (link: string) => new URL(link).hash.slice("#t=".length);
  const newUser = () => makeUser(sql, P, `u${++n}`, "user");
  const invite = async (eventId = event.id, who = org) => {
    const inv = await ST.createInvite(who, eventId, op());
    return { ...inv, token: tokenOf(inv.link) };
  };
  const door = (a: TestActor, id = event.id) => AC.resolveDoorAccess(D, a, id);
  const mkEvent = async (who = org, o: Record<string, unknown> = {}) => {
    const e = (await EV.createEvent(who, openDoorInput(o))).event;
    await TT.createTicketType(who, e.id, { name: "General", capacity: 10, clientOpId: crypto.randomUUID() });
    await EV.updateEvent(who, e.id, { version: 1, status: "published" });
    return e;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup(sql, P);
    org = await makeUser(sql, P, "org", "organizer");
    org2 = await makeUser(sql, P, "org2", "organizer");
    admin = await makeUser(sql, P, "admin", "admin");
    EV = await import("@/lib/events");
    TT = await import("@/lib/ticket-types");
    ST = await import("@/lib/staff");
    AC = await import("@/lib/access");
    D = (await import("@/lib/db")).db();
    event = await mkEvent(org, { title: "Staffed" });
  });

  afterAll(async () => {
    await cleanup(sql, P);
    await sql.end();
  });

  describe("create", () => {
    it("returns a link with the token in the URL fragment; only its sha256 is stored", async () => {
      const inv = await invite();
      expect(inv.link).toMatch(/^http:\/\/localhost:3000\/staff-invite#t=[A-Za-z0-9_-]{22}$/);
      expect(new URL(inv.link).search).toBe("");
      expect(new URL(inv.link).pathname).toBe("/staff-invite");
      const [row] = await sql`select token_digest, expires_at, created_by, used_at from staff_invite where id = ${inv.id}`;
      expect(Buffer.from(row.token_digest).equals(createHash("sha256").update(inv.token).digest())).toBe(true);
      expect(Buffer.from(row.token_digest).toString("utf8")).not.toContain(inv.token);
      expect(row.created_by).toBe(org.id);
      const hours = (new Date(row.expires_at).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(71.9);
      expect(hours).toBeLessThanOrEqual(72);
      // No column of any staff table holds the token.
      const dump = JSON.stringify(await sql`select * from staff_invite`);
      expect(dump).not.toContain(inv.token);
      // The organiser's list shows open invites without tokens.
      const { invites } = await ST.listStaff(org, event.id);
      expect(invites.map((i) => i.id)).toContain(inv.id);
      expect(JSON.stringify(invites)).not.toContain(inv.token);
      expect(Object.keys(invites[0]).sort()).toEqual(["createdAt", "expiresAt", "id"]);
    });

    it("a retry with the same clientOpId returns the same invite and link, uses no extra slot, and parallel duplicates make one invite", async () => {
      const e = await mkEvent(org, { title: "Invite replay" });
      const body = op();
      const first = await ST.createInvite(org, e.id, body);
      expect(first.replayed).toBe(false);
      const again = await ST.createInvite(org, e.id, body);
      expect(again).toMatchObject({ id: first.id, link: first.link, replayed: true });
      const par = op();
      const results = await Promise.all(Array.from({ length: 6 }, () => ST.createInvite(org, e.id, par)));
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(new Set(results.map((r) => r.link)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      const [{ n }] = await sql`select count(*)::int as n from staff_invite where event_id = ${e.id}`;
      expect(n).toBe(2);
      // The replayed link still works, once.
      await expect(ST.acceptInvite(await newUser(), { token: tokenOf(again.link) })).resolves.toMatchObject({ replayed: false });
      // Retries never eat the 10-slot allowance.
      const o = op();
      for (let i = 0; i < 15; i++) await ST.createInvite(org, e.id, o);
      expect((await ST.listStaff(org, e.id)).invites).toHaveLength(2);
    });

    it("a retry after the invite was used, revoked or expired is 409 invite_closed, and a revoked link can't be revived", async () => {
      const e = await mkEvent(org, { title: "Invite closed" });
      const used = op();
      const u = await ST.createInvite(org, e.id, used);
      await ST.acceptInvite(await newUser(), { token: tokenOf(u.link) });
      await expect(ST.createInvite(org, e.id, used)).rejects.toMatchObject({ status: 409, code: "invite_closed" });
      const revoked = op();
      const r = await ST.createInvite(org, e.id, revoked);
      await ST.revokeInvite(org, e.id, r.id);
      await expect(ST.createInvite(org, e.id, revoked)).rejects.toMatchObject({ status: 409, code: "invite_closed" });
      await expect(ST.acceptInvite(await newUser(), { token: tokenOf(r.link) })).rejects.toMatchObject({ status: 404 });
      const expired = op();
      const x = await ST.createInvite(org, e.id, expired);
      await sql`update staff_invite set expires_at = now() - interval '1 second' where id = ${x.id}`;
      await expect(ST.createInvite(org, e.id, expired)).rejects.toMatchObject({ status: 409, code: "invite_closed" });
      // Revoking a used invite changes nothing.
      await expect(ST.revokeInvite(org, e.id, u.id)).resolves.toEqual({ revoked: false });
    });

    it("the token depends on the event and the op id: the same op id on another event, or by another organiser, is another token; a body without a valid op id is a 400", async () => {
      const e2 = await mkEvent(org, { title: "Invite other" });
      const e3 = await mkEvent(org2, { title: "Invite third" });
      const body = op();
      const a = await ST.createInvite(org, event.id, body);
      const b = await ST.createInvite(org, e2.id, body);
      const c = await ST.createInvite(org2, e3.id, body);
      expect(new Set([tokenOf(a.link), tokenOf(b.link), tokenOf(c.link)]).size).toBe(3);
      for (const bad of [undefined, null, {}, { clientOpId: "nope" }, { clientOpId: crypto.randomUUID(), extra: 1 }, { clientOpId: "\0" }]) {
        expect((await ST.createInvite(org, event.id, bad).catch((x) => x)).name, JSON.stringify(bad)).toBe("ZodError");
      }
    });

    it("caps open invites at 10 per event exactly under parallel creates, and a revoked one frees a slot", async () => {
      const e = await mkEvent(org, { title: "Invite cap" });
      const r = await Promise.allSettled(Array.from({ length: 14 }, () => ST.createInvite(org, e.id, op())));
      const ok = r.filter((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof ST.createInvite>>> => x.status === "fulfilled");
      expect(ok).toHaveLength(10);
      for (const x of r.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) expect(x.reason).toMatchObject({ status: 409, code: "invite_limit" });
      await expect(ST.revokeInvite(org, e.id, ok[0].value.id)).resolves.toEqual({ revoked: true });
      await expect(ST.revokeInvite(org, e.id, ok[0].value.id)).resolves.toEqual({ revoked: false });
      await expect(ST.createInvite(org, e.id, op())).resolves.toBeTruthy();
    });

    it("another organiser can't create, list or revoke on this event (404); a revoked invite can't be accepted", async () => {
      await expect(ST.createInvite(org2, event.id, op())).rejects.toMatchObject({ status: 404 });
      await expect(ST.listStaff(org2, event.id)).rejects.toMatchObject({ status: 404 });
      const inv = await invite();
      await expect(ST.revokeInvite(org2, event.id, inv.id)).rejects.toMatchObject({ status: 404 });
      await expect(ST.revokeInvite(org, event.id, inv.id)).resolves.toEqual({ revoked: true });
      await expect(ST.acceptInvite(await newUser(), { token: inv.token })).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("accept", () => {
    it("works once: the first user becomes staff, the second with the same token gets a 404", async () => {
      const inv = await invite();
      const a = await newUser();
      const b = await newUser();
      await expect(ST.acceptInvite(a, { token: inv.token })).resolves.toMatchObject({ eventId: event.id, title: "Staffed", replayed: false });
      await expect(door(a)).resolves.toMatchObject({ via: "staff" });
      await expect(ST.acceptInvite(b, { token: inv.token })).rejects.toMatchObject({ status: 404 });
      await expect(door(b)).rejects.toMatchObject({ status: 404 });
      const [row] = await sql`select used_by, used_at from staff_invite where id = ${inv.id}`;
      expect(row.used_by).toBe(a.id);
      expect(row.used_at).not.toBeNull();
      const list = await ST.listStaff(org, event.id);
      expect(list.staff.map((s) => s.userId)).toContain(a.id);
      expect(list.invites.map((i) => i.id)).not.toContain(inv.id);
    });

    it("answers the same for an unknown, a used and an expired token", async () => {
      const used = await invite();
      await ST.acceptInvite(await newUser(), { token: used.token });
      const expired = await invite();
      await sql`update staff_invite set expires_at = now() - interval '1 second' where id = ${expired.id}`;
      const taker = await newUser();
      const errs = [];
      for (const token of [used.token, expired.token, "A".repeat(22), "nonsense", "x"]) {
        errs.push(await ST.acceptInvite(taker, { token }).catch((e) => e));
      }
      for (const e of errs) expect(e).toMatchObject({ status: 404, message: errs[0].message, name: errs[0].name });
      expect((await sql`select count(*)::int as n from event_staff where user_id = ${taker.id}`)[0].n).toBe(0);
    });

    it("a NUL byte, an empty token or an extra field is a 400; an unauthenticated or admin caller is refused", async () => {
      for (const body of [{ token: "a\0b" }, { token: "" }, { token: 1 }, {}, { token: "x", extra: 1 }, null, "x"]) {
        expect((await ST.acceptInvite(await newUser(), body).catch((e) => e)).name, JSON.stringify(body)).toBe("ZodError");
      }
      await expect(ST.acceptInvite(null, { token: "x" })).rejects.toMatchObject({ status: 401 });
      await expect(ST.acceptInvite(admin, { token: "x" })).rejects.toMatchObject({ status: 403 });
    });

    it("the organiser can't accept their own invite: same 404, and the invite stays unused", async () => {
      const inv = await invite();
      await expect(ST.acceptInvite(org, { token: inv.token })).rejects.toMatchObject({ status: 404 });
      const [row] = await sql`select used_at from staff_invite where id = ${inv.id}`;
      expect(row.used_at).toBeNull();
      await expect(ST.acceptInvite(await newUser(), { token: inv.token })).resolves.toMatchObject({ replayed: false });
    });

    it("an invite to a cancelled event is a 404 and stays unused; a deleted event's invite is a 404", async () => {
      const e = await mkEvent(org, { title: "Soon cancelled" });
      const inv = await invite(e.id);
      const cur = await EV.getMyEvent(org, e.id);
      await EV.updateEvent(org, e.id, { version: cur.version, status: "cancelled" });
      await expect(ST.acceptInvite(await newUser(), { token: inv.token })).rejects.toMatchObject({ status: 404 });
      await expect(ST.createInvite(org, e.id, op())).rejects.toMatchObject({ status: 409, code: "event_cancelled" });
      await EV.deleteEvent(org, e.id);
      await expect(ST.acceptInvite(await newUser(), { token: inv.token })).rejects.toMatchObject({ status: 404 });
    });

    it("a retry by the same user after a lost response answers 200 replayed, while they are still staff", async () => {
      const inv = await invite();
      const a = await newUser();
      await ST.acceptInvite(a, { token: inv.token });
      await expect(ST.acceptInvite(a, { token: inv.token })).resolves.toMatchObject({ eventId: event.id, replayed: true });
      await ST.removeStaff(org, event.id, a.id, op());
      await expect(ST.acceptInvite(a, { token: inv.token })).rejects.toMatchObject({ status: 404 });
    });

    it("parallel accepts of one token by five users: exactly one wins, four get the 404, one staff row", async () => {
      const inv = await invite();
      const users = await Promise.all(Array.from({ length: 5 }, () => newUser()));
      const r = await Promise.allSettled(users.map((u) => ST.acceptInvite(u, { token: inv.token })));
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      for (const x of r.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) expect(x.reason).toMatchObject({ status: 404 });
      const [{ staff }] = await sql`select count(*)::int as staff from event_staff where user_id = any(${users.map((u) => u.id)})`;
      expect(staff).toBe(1);
    });

    it("caps staff at 20 per event: the 21st accept is a 409 and the invite stays unused", async () => {
      const e = await mkEvent(org, { title: "Full crew" });
      for (let i = 0; i < 20; i++) {
        const inv = await ST.createInvite(org, e.id, op());
        await ST.acceptInvite(await newUser(), { token: tokenOf(inv.link) });
      }
      const inv = await ST.createInvite(org, e.id, op());
      await expect(ST.acceptInvite(await newUser(), { token: tokenOf(inv.link) })).rejects.toMatchObject({ status: 409, code: "staff_full" });
      const [row] = await sql`select used_at from staff_invite where id = ${inv.id}`;
      expect(row.used_at).toBeNull();
      expect((await ST.listStaff(org, e.id)).staff).toHaveLength(20);
    });

    it("accepts, invites, revokes and removals racing each other finish without a deadlock or a 500", async () => {
      const e = await mkEvent(org, { title: "Staff race" });
      const users = await Promise.all(Array.from({ length: 6 }, () => newUser()));
      const invs = await Promise.all(users.map(() => ST.createInvite(org, e.id, op())));
      const ops: Promise<unknown>[] = [];
      users.forEach((u, i) => {
        ops.push(ST.acceptInvite(u, { token: tokenOf(invs[i].link) }));
        ops.push(ST.removeStaff(org, e.id, u.id, op()));
        ops.push(ST.revokeInvite(org, e.id, invs[i].id));
        ops.push(ST.createInvite(org, e.id, op()));
      });
      ops.push(EV.updateEvent(org, e.id, { version: 1, title: "Staff race 2" }));
      const results = await Promise.allSettled(ops);
      for (const r of results) if (r.status === "rejected") expect(typeof (r.reason as { status?: number }).status, String(r.reason)).toBe("number");
    });
  });

  describe("remove", () => {
    it("a removed staffer loses door access on the next request; removing twice answers removed: false", async () => {
      const a = await newUser();
      await ST.acceptInvite(a, { token: (await invite()).token });
      await expect(door(a)).resolves.toMatchObject({ via: "staff" });
      await expect(ST.removeStaff(org, event.id, a.id, op())).resolves.toEqual({ removed: true, replayed: false });
      await expect(door(a)).rejects.toMatchObject({ status: 404 });
      await expect(ST.removeStaff(org, event.id, a.id, op())).resolves.toEqual({ removed: false, replayed: false });
      await expect(ST.removeStaff(org2, event.id, a.id, op())).rejects.toMatchObject({ status: 404 });
    });

    it("a late retry of a removal returns the first result and doesn't remove a membership granted again in between", async () => {
      const a = await newUser();
      await ST.acceptInvite(a, { token: (await invite()).token });
      const body = op();
      await expect(ST.removeStaff(org, event.id, a.id, body)).resolves.toEqual({ removed: true, replayed: false });
      await ST.acceptInvite(a, { token: (await invite()).token }); // re-invited and accepted
      await expect(door(a)).resolves.toMatchObject({ via: "staff" });
      await expect(ST.removeStaff(org, event.id, a.id, body)).resolves.toEqual({ removed: true, replayed: true });
      await expect(door(a)).resolves.toMatchObject({ via: "staff" }); // the late retry changed nothing
      // The same op id for another staffer or event is a different request.
      await expect(ST.removeStaff(org, event.id, "someone-else", body)).rejects.toMatchObject({ status: 409, code: "op_id_reused" });
      // No op id, no removal.
      for (const bad of [undefined, null, {}, { clientOpId: "x" }]) expect((await ST.removeStaff(org, event.id, a.id, bad).catch((e) => e)).name).toBe("ZodError");
      await expect(door(a)).resolves.toMatchObject({ via: "staff" });
    });

    it("removing staff of this event doesn't touch their staff rows on another event", async () => {
      const e2 = await mkEvent(org, { title: "Second door" });
      const a = await newUser();
      await ST.acceptInvite(a, { token: (await invite()).token });
      await ST.acceptInvite(a, { token: (await invite(e2.id)).token });
      await ST.removeStaff(org, event.id, a.id, op());
      await expect(door(a, event.id)).rejects.toMatchObject({ status: 404 });
      await expect(door(a, e2.id)).resolves.toMatchObject({ via: "staff" });
    });
  });

  describe("staff of event A can't touch event B", () => {
    it("has no door, staff list or invite power on an event they weren't invited to", async () => {
      const b = await mkEvent(org2, { title: "Other crew" });
      const a = await newUser();
      await ST.acceptInvite(a, { token: (await invite()).token });
      await expect(door(a, b.id)).rejects.toMatchObject({ status: 404 });
      await expect(ST.listStaff(a, b.id)).rejects.toMatchObject({ status: 403 });
      expect((await ST.listDoorEvents(a)).events.map((x) => x.id)).not.toContain(b.id);
    });
  });
});
