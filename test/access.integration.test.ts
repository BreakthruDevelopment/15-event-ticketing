/**
 * One test per access rule in src/lib/access.ts (spec 15, "Access rules"): who may read and write what, against a real
 * Postgres (TEST_DATABASE_URL). Pattern for each rule: owner allowed, other organiser blocked (404, id guessing
 * included), attendee blocked (403), admin blocked from content (403) or allowed where the spec gives admins counts,
 * roles and hide.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestActor, cleanup, eventInput, fillRate, makeUser, op, openDoorInput } from "./helpers";

const url = process.env.TEST_DATABASE_URL;
const P = "ac";

describe.skipIf(!url)("access rules (Postgres)", () => {
  let sql: postgres.Sql;
  let orgA: TestActor;
  let orgB: TestActor;
  let attendee: TestActor;
  let staffer: TestActor;
  let admin: TestActor;
  let EV: typeof import("@/lib/events");
  let TT: typeof import("@/lib/ticket-types");
  let ST: typeof import("@/lib/staff");
  let AD: typeof import("@/lib/admin");
  let R: typeof import("@/lib/auth/roles");
  let AC: typeof import("@/lib/access");
  let D: ReturnType<typeof import("@/lib/db").db>;

  type Ev = { id: string; slug: string };
  let draft: Ev; // orgA, draft with a type
  let live: Ev; // orgA, published, door open
  let liveType: string;
  let other: Ev; // orgB, published, door open

  const publish = async (who: TestActor, o: Record<string, unknown>) => {
    const e = (await EV.createEvent(who, o)).event;
    const { ticketType } = await TT.createTicketType(who, e.id, { name: "General", capacity: 10, clientOpId: crypto.randomUUID() });
    const pub = await EV.updateEvent(who, e.id, { version: 1, status: "published" });
    return { id: e.id, slug: e.slug, typeId: ticketType.id, version: pub.version };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup(sql, P);
    orgA = await makeUser(sql, P, "orgA", "organizer");
    orgB = await makeUser(sql, P, "orgB", "organizer");
    attendee = await makeUser(sql, P, "att", "user");
    staffer = await makeUser(sql, P, "staffer", "user");
    admin = await makeUser(sql, P, "admin", "admin");
    EV = await import("@/lib/events");
    TT = await import("@/lib/ticket-types");
    ST = await import("@/lib/staff");
    AD = await import("@/lib/admin");
    R = await import("@/lib/auth/roles");
    AC = await import("@/lib/access");
    D = (await import("@/lib/db")).db();
    draft = (await EV.createEvent(orgA, eventInput({ title: "Draft of A" }))).event;
    await TT.createTicketType(orgA, draft.id, { name: "General", capacity: 5, clientOpId: crypto.randomUUID() });
    const l = await publish(orgA, openDoorInput({ title: "Live of A" }));
    live = l;
    liveType = l.typeId;
    other = await publish(orgB, openDoorInput({ title: "Live of B" }));
  });

  afterAll(async () => {
    await cleanup(sql, P);
    await sql.end();
  });

  describe("capabilities", () => {
    it("grants by role, 401 without an actor, 403 for the wrong role", () => {
      expect(AC.can(orgA, "event:manage")).toBe(true);
      expect(AC.can(attendee, "event:manage")).toBe(false);
      expect(AC.can(admin, "event:manage")).toBe(false); // admin is not a superset of organizer
      expect(AC.can(admin, "admin:roles")).toBe(true);
      expect(AC.can(orgA, "admin:roles")).toBe(false);
      for (const c of ["staff-invite:accept", "door:use", "event:register", "faq:ask"] as const) {
        expect(AC.can(attendee, c), c).toBe(true);
        expect(AC.can(orgA, c), c).toBe(true);
        expect(AC.can(admin, c), c).toBe(false); // admins see counts, not content
        expect(AC.can(null, c), c).toBe(false);
      }
      expect(() => AC.assertCan(null, "event:manage")).toThrowError(expect.objectContaining({ status: 401 }));
      expect(() => AC.assertCan(attendee, "event:manage")).toThrowError(expect.objectContaining({ status: 403 }));
    });
  });

  describe("public", () => {
    it("sees a published, not hidden event; never a draft, and gets no attendee or organiser data", async () => {
      const page = await EV.getPublicEventBySlug(live.slug);
      expect(page.event.title).toBe("Live of A");
      expect(JSON.stringify(page)).not.toContain(orgA.id);
      await expect(EV.getPublicEventBySlug(draft.slug)).rejects.toMatchObject({ status: 404 });
      expect((await EV.listPublicEvents({ limit: "100" })).events.map((e) => e.id)).not.toContain(draft.id);
    });
  });

  describe("attendee (user)", () => {
    it("is blocked from every organiser, door-management and admin function (403)", async () => {
      const calls: (() => Promise<unknown>)[] = [
        () => EV.listMyEvents(attendee),
        () => EV.getMyEvent(attendee, live.id),
        () => EV.createEvent(attendee, eventInput()),
        () => EV.updateEvent(attendee, live.id, { version: 1, title: "x" }),
        () => EV.deleteEvent(attendee, draft.id),
        () => TT.createTicketType(attendee, live.id, { name: "VIP", capacity: 1, clientOpId: crypto.randomUUID() }),
        () => TT.updateTicketType(attendee, live.id, liveType, { version: 1, name: "x" }),
        () => TT.deleteTicketType(attendee, live.id, liveType),
        () => ST.listStaff(attendee, live.id),
        () => ST.createInvite(attendee, live.id, op()),
        () => ST.revokeInvite(attendee, live.id, crypto.randomUUID()),
        () => ST.removeStaff(attendee, live.id, staffer.id, op()),
        () => AD.adminStats(attendee),
        () => AD.hideEvent(attendee, live.id, { hidden: true, reason: "x", clientOpId: crypto.randomUUID() }),
        () => R.setUserRole(attendee, { userId: attendee.id, role: "organizer", from: "user", clientOpId: crypto.randomUUID() }),
      ];
      for (const [i, call] of calls.entries()) await expect(call(), `call ${i}`).rejects.toMatchObject({ status: 403 });
      const [{ role }] = await sql`select role from "user" where id = ${attendee.id}`;
      expect(role).toBe("user");
    });

    it("can use the door and accept an invite capability-wise, but a door request for an event they don't staff is a 404", async () => {
      await expect(AC.resolveDoorAccess(D, attendee, live.id)).rejects.toMatchObject({ status: 404 });
      await expect(ST.listDoorEvents(attendee)).resolves.toEqual({ events: [] });
    });
  });

  describe("organizer", () => {
    it("is allowed on their own event, in every state", async () => {
      expect((await EV.getMyEvent(orgA, draft.id)).title).toBe("Draft of A");
      expect((await EV.listMyEvents(orgA)).map((e) => e.id)).toEqual(expect.arrayContaining([draft.id, live.id]));
      await expect(ST.listStaff(orgA, live.id)).resolves.toMatchObject({ staff: [], invites: [] });
    });

    it("gets a 404 on every read and write of another organiser's event, and for an unknown id (id guessing)", async () => {
      const ghost = crypto.randomUUID();
      for (const id of [other.id, ghost]) {
        const calls: (() => Promise<unknown>)[] = [
          () => EV.getMyEvent(orgA, id),
          () => EV.updateEvent(orgA, id, { version: 1, title: "hijack" }),
          () => EV.deleteEvent(orgA, id),
          () => TT.createTicketType(orgA, id, { name: "VIP", capacity: 1, clientOpId: crypto.randomUUID() }),
          () => TT.updateTicketType(orgA, id, liveType, { version: 1, name: "x" }),
          () => TT.deleteTicketType(orgA, id, liveType),
          () => ST.listStaff(orgA, id),
          () => ST.createInvite(orgA, id, op()),
          () => ST.revokeInvite(orgA, id, crypto.randomUUID()),
          () => ST.removeStaff(orgA, id, staffer.id, op()),
        ];
        for (const [i, call] of calls.entries()) await expect(call(), `${id === ghost ? "ghost" : "foreign"} call ${i}`).rejects.toMatchObject({ status: 404 });
      }
      const [row] = await sql`select title, status from event where id = ${other.id}`;
      expect(row).toMatchObject({ title: "Live of B", status: "published" });
      // Another organiser's ticket type id under the right event is a 404 too.
      await expect(TT.updateTicketType(orgB, other.id, liveType, { version: 1, name: "x" })).rejects.toMatchObject({ status: 404 });
    });

    it("is blocked from admin functions (403)", async () => {
      await expect(AD.adminStats(orgA)).rejects.toMatchObject({ status: 403 });
      await expect(AD.hideEvent(orgA, other.id, { hidden: true, reason: "x", clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ status: 403 });
      await expect(R.setUserRole(orgA, { userId: orgB.id, role: "user", from: "organizer", clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ status: 403 });
    });

    it("loses write access the moment the role is revoked, even with a session that still says organizer (403)", async () => {
      const ghostOrg = await makeUser(sql, P, "stale", "organizer");
      const e = (await EV.createEvent(ghostOrg, eventInput())).event;
      await sql`update "user" set role = 'user' where id = ${ghostOrg.id}`; // revoked behind the session's back
      await expect(EV.updateEvent(ghostOrg, e.id, { version: 1, title: "still here?" })).rejects.toMatchObject({ status: 403 });
      await expect(EV.createEvent(ghostOrg, eventInput())).rejects.toMatchObject({ status: 403 });
      await expect(ST.createInvite(ghostOrg, e.id, op())).rejects.toMatchObject({ status: 403 });
      await sql`update "user" set banned = true, role = 'organizer' where id = ${ghostOrg.id}`;
      await expect(EV.createEvent(ghostOrg, eventInput())).rejects.toMatchObject({ status: 403 }); // banned
    });
  });

  describe("admin", () => {
    it("sees counts only, grants roles and hides events", async () => {
      const stats = await AD.adminStats(admin);
      expect(stats.events.byStatus.published).toBeGreaterThanOrEqual(2);
      expect(stats.users.organizer).toBeGreaterThanOrEqual(2);
      expect(Object.keys(stats).sort()).toEqual(["checkinsToday", "events", "faq", "generatedAt", "tickets", "users"]);
      const text = JSON.stringify(stats);
      for (const secret of ["Live of A", "Draft of A", orgA.id, "@test.local"]) expect(text).not.toContain(secret);
    });

    it("is blocked from every organiser function and from door access (403)", async () => {
      const calls: (() => Promise<unknown>)[] = [
        () => EV.listMyEvents(admin),
        () => EV.getMyEvent(admin, live.id),
        () => EV.createEvent(admin, eventInput()),
        () => EV.updateEvent(admin, live.id, { version: 1, title: "x" }),
        () => EV.deleteEvent(admin, draft.id),
        () => TT.createTicketType(admin, live.id, { name: "VIP", capacity: 1, clientOpId: crypto.randomUUID() }),
        () => TT.deleteTicketType(admin, live.id, liveType),
        () => ST.listStaff(admin, live.id),
        () => ST.createInvite(admin, live.id, op()),
        () => ST.removeStaff(admin, live.id, staffer.id, op()),
        () => ST.acceptInvite(admin, { token: "whatever" }),
        () => ST.listDoorEvents(admin),
        () => AC.resolveDoorAccess(D, admin, live.id),
      ];
      for (const [i, call] of calls.entries()) await expect(call(), `call ${i}`).rejects.toMatchObject({ status: 403 });
    });

    it("hides and unhides with a reason; the public page 404s while hidden; reserved and missing reasons are refused", async () => {
      const e = await publish(orgA, eventInput({ title: "To hide" }));
      await expect(AD.hideEvent(admin, e.id, { hidden: true, clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ name: "ZodError" });
      await expect(AD.hideEvent(admin, e.id, { hidden: true, reason: "organizer_revoked", clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ name: "ZodError" });
      await expect(AD.hideEvent(admin, e.id, { hidden: true, reason: "spam", clientOpId: crypto.randomUUID() })).resolves.toMatchObject({ changed: true });
      await expect(AD.hideEvent(admin, e.id, { hidden: true, reason: "again", clientOpId: crypto.randomUUID() })).resolves.toMatchObject({ changed: false });
      await expect(EV.getPublicEventBySlug(e.slug)).rejects.toMatchObject({ status: 404 });
      expect((await EV.getMyEvent(orgA, e.id)).hiddenReason).toBe("spam");
      await expect(AD.hideEvent(admin, e.id, { hidden: false, clientOpId: crypto.randomUUID() })).resolves.toMatchObject({ changed: true });
      await expect(EV.getPublicEventBySlug(e.slug)).resolves.toBeTruthy();
      await expect(AD.hideEvent(admin, draft.id, { hidden: true, reason: "x", clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 }); // only published
    });
  });

  describe("cancelled events (public by slug) can be hidden", () => {
    it("an admin hide of a cancelled event makes its slug 404; unhide restores it", async () => {
      const e = await publish(orgA, eventInput({ title: "Cancelled then hidden" }));
      const c = await EV.updateEvent(orgA, e.id, { version: e.version, status: "cancelled" });
      await expect(EV.getPublicEventBySlug(e.slug)).resolves.toBeTruthy();
      await expect(AD.hideEvent(admin, e.id, { hidden: true, reason: "spam", clientOpId: crypto.randomUUID() })).resolves.toMatchObject({ changed: true });
      await expect(EV.getPublicEventBySlug(e.slug)).rejects.toMatchObject({ status: 404 });
      await expect(AD.hideEvent(admin, e.id, { hidden: false, clientOpId: crypto.randomUUID() })).resolves.toMatchObject({ changed: true });
      await expect(EV.getPublicEventBySlug(e.slug)).resolves.toBeTruthy();
      expect(c.status).toBe("cancelled");
    });

    it("revoking organizer hides a cancelled event too; re-granting unhides it", async () => {
      const o = await makeUser(sql, P, "revcancel", "organizer");
      const e = await publish(o, eventInput({ title: "Revoked cancelled" }));
      await EV.updateEvent(o, e.id, { version: e.version, status: "cancelled" });
      const rev = await R.setUserRole(admin, { userId: o.id, role: "user", from: "organizer", clientOpId: crypto.randomUUID() });
      expect(rev).toMatchObject({ changed: true, hidden: 1 });
      await expect(EV.getPublicEventBySlug(e.slug)).rejects.toMatchObject({ status: 404 });
      const grant = await R.setUserRole(admin, { userId: o.id, role: "organizer", from: "user", clientOpId: crypto.randomUUID() });
      expect(grant).toMatchObject({ unhidden: 1 });
      await expect(EV.getPublicEventBySlug(e.slug)).resolves.toBeTruthy();
    });
  });

  describe("accept invite: hidden events and existing staff", () => {
    const tokenOf = (link: string) => new URL(link).hash.slice("#t=".length);

    it("refuses a hidden event (404) and leaves the invite unused", async () => {
      const u = await makeUser(sql, P, "hidacc", "user");
      const e = await publish(orgA, eventInput({ title: "Hidden accept" }));
      const inv = await ST.createInvite(orgA, e.id, op());
      await AD.hideEvent(admin, e.id, { hidden: true, reason: "spam", clientOpId: crypto.randomUUID() });
      await expect(ST.acceptInvite(u, { token: tokenOf(inv.link) })).rejects.toMatchObject({ status: 404 });
      const [row] = await sql`select used_at from staff_invite where id = ${inv.id}`;
      expect(row.used_at).toBeNull();
    });

    it("an existing staffer accepting another invite burns nothing and ignores the cap", async () => {
      const u = await makeUser(sql, P, "dupstaff", "user");
      const e = await publish(orgA, eventInput({ title: "Dup staff" }));
      const first = await ST.createInvite(orgA, e.id, op());
      await ST.acceptInvite(u, { token: tokenOf(first.link) });
      const second = await ST.createInvite(orgA, e.id, op());
      await expect(ST.acceptInvite(u, { token: tokenOf(second.link) })).resolves.toMatchObject({ replayed: true });
      const [row] = await sql`select used_at from staff_invite where id = ${second.id}`;
      expect(row.used_at).toBeNull();
    });
  });

  describe("door staff (per event, not a role)", () => {
    it("staff of event A can use A's door and nothing of event B's; a stranger gets 404 on both", async () => {
      const inv = await ST.createInvite(orgA, live.id, op());
      const token = new URL(inv.link).hash.slice("#t=".length);
      await ST.acceptInvite(staffer, { token });
      const a = await AC.resolveDoorAccess(D, staffer, live.id);
      expect(a).toMatchObject({ via: "staff", closed: null });
      expect(a.event.id).toBe(live.id);
      await expect(AC.resolveDoorAccess(D, staffer, other.id)).rejects.toMatchObject({ status: 404 });
      await expect(AC.resolveDoorAccess(D, attendee, live.id)).rejects.toMatchObject({ status: 404 });
      await expect(AC.resolveDoorAccess(D, staffer, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
      // Staff get no organiser powers on the event they staff.
      await expect(EV.getMyEvent(staffer, live.id)).rejects.toMatchObject({ status: 403 });
      await expect(ST.listStaff(staffer, live.id)).rejects.toMatchObject({ status: 403 });
      const list = await ST.listDoorEvents(staffer);
      expect(list.events.map((e) => e.id)).toEqual([live.id]);
      expect(list.events[0]).toMatchObject({ via: "staff", checkinOpen: true });
      expect(Object.keys(list.events[0]).sort()).toEqual(["checkinOpen", "checkinOpensAt", "endsAt", "id", "slug", "startsAt", "timeZone", "title", "venueName", "via"]);
      // Removal closes the door on the next request.
      await ST.removeStaff(orgA, live.id, staffer.id, op());
      await expect(AC.resolveDoorAccess(D, staffer, live.id)).rejects.toMatchObject({ status: 404 });
      expect((await ST.listDoorEvents(staffer)).events).toEqual([]);
    });

    it("the organiser opens their own door; a revoked organiser's door is a 404, even with a stale session", async () => {
      const o = await makeUser(sql, P, "doororg", "organizer");
      const e = await publish(o, openDoorInput());
      await expect(AC.resolveDoorAccess(D, o, e.id)).resolves.toMatchObject({ via: "organizer", closed: null });
      expect((await ST.listDoorEvents(o)).events.map((x) => x.id)).toEqual([e.id]);
      await sql`update "user" set role = 'user' where id = ${o.id}`;
      await expect(AC.resolveDoorAccess(D, o, e.id)).rejects.toMatchObject({ status: 404 });
      expect((await ST.listDoorEvents(o)).events).toEqual([]);
      await expect(AC.resolveDoorAccess(D, { id: o.id, role: "user" }, e.id)).rejects.toMatchObject({ status: 404 });
    });

    it("a hidden event is closed to its staff (409 checkin_closed) while a revoked organiser gets 404", async () => {
      const o = await makeUser(sql, P, "hiddenorg", "organizer");
      const s = await makeUser(sql, P, "hiddenstaff", "user");
      const e = await publish(o, openDoorInput());
      const token = new URL((await ST.createInvite(o, e.id, op())).link).hash.slice(3);
      await ST.acceptInvite(s, { token });
      await AD.hideEvent(admin, e.id, { hidden: true, reason: "abuse", clientOpId: crypto.randomUUID() });
      const hidden = await AC.resolveDoorAccess(D, s, e.id);
      expect(hidden.closed).toBe("hidden");
      expect(() => AC.assertDoorOpen(hidden)).toThrowError(expect.objectContaining({ status: 409, code: "checkin_closed" }));
      expect((await ST.listDoorEvents(s)).events).toEqual([]);
      await AD.hideEvent(admin, e.id, { hidden: false, clientOpId: crypto.randomUUID() });
      await expect(AC.resolveDoorAccess(D, s, e.id)).resolves.toMatchObject({ closed: null });
      // Revoking the organiser hides the event: staff see 409, the organiser 404.
      await R.setUserRole(admin, { userId: o.id, role: "user", from: "organizer", clientOpId: crypto.randomUUID() });
      expect((await AC.resolveDoorAccess(D, s, e.id)).closed).toBe("hidden");
      await expect(AC.resolveDoorAccess(D, { id: o.id, role: "user" }, e.id)).rejects.toMatchObject({ status: 404 });
    });

    it("the door is open only from checkin_opens_at until ends_at + 6 h, and only for a published event", () => {
      const base = { status: "published", hiddenAt: null, checkinOpensAt: new Date("2026-12-01T16:00:00Z"), endsAt: new Date("2026-12-01T21:00:00Z") };
      const at = (iso: string, o = {}) => AC.closedReason({ ...base, ...o }, new Date(iso));
      expect(at("2026-12-01T15:59:59Z")).toBe("not_open_yet");
      expect(at("2026-12-01T16:00:00Z")).toBeNull();
      expect(at("2026-12-02T03:00:00Z")).toBeNull();
      expect(at("2026-12-02T03:00:01Z")).toBe("ended");
      expect(at("2026-12-01T18:00:00Z", { status: "cancelled" })).toBe("cancelled");
      expect(at("2026-12-01T18:00:00Z", { status: "draft" })).toBe("not_published");
      expect(at("2026-12-01T18:00:00Z", { hiddenAt: new Date() })).toBe("hidden");
    });

    it("lists only today's and the next seven days' published events (not drafts, cancelled, far-future or ended ones)", async () => {
      const o = await makeUser(sql, P, "listorg", "organizer");
      const open = await publish(o, openDoorInput({ title: "Open now" }));
      const soon = await publish(o, eventInput({ title: "Tomorrow" }));
      const far = await publish(o, eventInput({ title: "Far away", startsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), endsAt: new Date(Date.now() + 20 * 86_400_000 + 7_200_000).toISOString() }));
      const ended = await publish(o, eventInput({ title: "Ended" }));
      await sql`update event set starts_at = now() - interval '2 days', ends_at = now() - interval '2 days' + interval '2 hours', registration_closes_at = now() - interval '2 days', checkin_opens_at = now() - interval '2 days 3 hours' where id = ${ended.id}`;
      const draftOne = (await EV.createEvent(o, eventInput({ title: "Draft" }))).event;
      const cancelled = await publish(o, eventInput({ title: "Cancelled" }));
      await EV.updateEvent(o, cancelled.id, { version: cancelled.version, status: "cancelled" });
      const ids = (await ST.listDoorEvents(o)).events.map((e) => e.id);
      expect(ids).toEqual([open.id, soon.id]);
      for (const hidden of [far.id, ended.id, draftOne.id, cancelled.id]) expect(ids).not.toContain(hidden);
    });
  });

  describe("roles: grant and revoke hide and unhide events", () => {
    it("revoking organizer hides their published events (not drafts), re-granting unhides only those, an admin hide stays", async () => {
      const o = await makeUser(sql, P, "revoked", "organizer");
      const one = await publish(o, eventInput({ title: "Revoked one" }));
      const two = await publish(o, eventInput({ title: "Revoked two" }));
      const adminHid = await publish(o, eventInput({ title: "Admin hid" }));
      const dr = (await EV.createEvent(o, eventInput({ title: "Revoked draft" }))).event;
      await AD.hideEvent(admin, adminHid.id, { hidden: true, reason: "spam", clientOpId: crypto.randomUUID() });

      const rev = await R.setUserRole(admin, { userId: o.id, role: "user", from: "organizer", clientOpId: crypto.randomUUID() });
      expect(rev).toMatchObject({ changed: true, previous: "organizer", role: "user", hidden: 2, unhidden: 0, replayed: false });
      const rows = await sql`select id, hidden_reason from event where organizer_id = ${o.id}`;
      const reason = (id: string) => rows.find((r) => r.id === id)?.hidden_reason;
      expect(reason(one.id)).toBe("organizer_revoked");
      expect(reason(two.id)).toBe("organizer_revoked");
      expect(reason(adminHid.id)).toBe("spam");
      expect(reason(dr.id)).toBeNull();
      await expect(EV.getPublicEventBySlug(one.slug)).rejects.toMatchObject({ status: 404 });
      expect((await EV.listPublicEvents({ limit: "100" })).events.map((e) => e.id)).not.toContain(one.id);
      // Can't write, and an admin can't unhide an organizer_revoked event while the owner is not an organiser.
      await expect(EV.updateEvent(o, one.id, { version: 2, title: "x" })).rejects.toMatchObject({ status: 403 });
      await expect(AD.hideEvent(admin, one.id, { hidden: false, clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 });

      const grant = await R.setUserRole(admin, { userId: o.id, role: "organizer", from: "user", clientOpId: crypto.randomUUID() });
      expect(grant).toMatchObject({ changed: true, hidden: 0, unhidden: 2 });
      await expect(EV.getPublicEventBySlug(one.slug)).resolves.toBeTruthy();
      await expect(EV.getPublicEventBySlug(two.slug)).resolves.toBeTruthy();
      await expect(EV.getPublicEventBySlug(adminHid.slug)).rejects.toMatchObject({ status: 404 });
      expect((await EV.getMyEvent(o, adminHid.id)).hiddenReason).toBe("spam");
    });

    it("a late retry of an unhide returns the first result and doesn't clear a newer hide by another admin; an op id can't be reused for another change", async () => {
      const admin2 = await makeUser(sql, P, "admin3", "admin");
      const e = await publish(orgA, eventInput({ title: "Hide ABA" }));
      await AD.hideEvent(admin, e.id, { hidden: true, reason: "first", clientOpId: crypto.randomUUID() });
      const unhideOp = crypto.randomUUID();
      const first = await AD.hideEvent(admin, e.id, { hidden: false, clientOpId: unhideOp });
      expect(first).toMatchObject({ hidden: false, changed: true, replayed: false });
      await AD.hideEvent(admin2, e.id, { hidden: true, reason: "second, newer", clientOpId: crypto.randomUUID() });
      const late = await AD.hideEvent(admin, e.id, { hidden: false, clientOpId: unhideOp });
      expect(late).toMatchObject({ hidden: false, changed: true, replayed: true });
      expect((await EV.getMyEvent(orgA, e.id)).hiddenReason).toBe("second, newer");
      await expect(EV.getPublicEventBySlug(e.slug)).rejects.toMatchObject({ status: 404 });
      await expect(AD.hideEvent(admin, e.id, { hidden: true, reason: "other", clientOpId: unhideOp })).rejects.toMatchObject({ status: 409, code: "op_id_reused" });
      // The same op id used for a role change is a different request too.
      await expect(R.setUserRole(admin, { userId: orgB.id, role: "user", from: "organizer", clientOpId: unhideOp })).rejects.toMatchObject({ status: 409, code: "op_id_reused" });
      expect((await sql`select role from "user" where id = ${orgB.id}`)[0].role).toBe("organizer");
      // Parallel duplicates of one hide make one change.
      const op1 = crypto.randomUUID();
      const par = await Promise.all(Array.from({ length: 5 }, () => AD.hideEvent(admin, e.id, { hidden: true, reason: "parallel", clientOpId: op1 })));
      expect(par.filter((x) => !x.replayed)).toHaveLength(1);
      expect(par.every((x) => x.hidden)).toBe(true);
    });

    it("an admin hide over an organizer_revoked hide replaces the reason, so a re-grant doesn't unhide it", async () => {
      const o = await makeUser(sql, P, "overwrite", "organizer");
      const e = await publish(o, eventInput({ title: "Overwritten" }));
      await R.setUserRole(admin, { userId: o.id, role: "user", from: "organizer", clientOpId: crypto.randomUUID() });
      await expect(AD.hideEvent(admin, e.id, { hidden: true, reason: "also abusive", clientOpId: crypto.randomUUID() })).resolves.toMatchObject({ changed: true });
      await R.setUserRole(admin, { userId: o.id, role: "organizer", from: "user", clientOpId: crypto.randomUUID() });
      await expect(EV.getPublicEventBySlug(e.slug)).rejects.toMatchObject({ status: 404 });
      await expect(AD.hideEvent(admin, e.id, { hidden: false, clientOpId: crypto.randomUUID() })).resolves.toMatchObject({ changed: true });
      await expect(EV.getPublicEventBySlug(e.slug)).resolves.toBeTruthy();
    });

    it("compare-and-set: a stale `from` is a 409 with the current role and changes nothing", async () => {
      const o = await makeUser(sql, P, "cas", "user");
      const err = await R.setUserRole(admin, { userId: o.id, role: "user", from: "organizer", clientOpId: crypto.randomUUID() }).catch((e) => e);
      expect(err).toMatchObject({ status: 409, current: { userId: o.id, role: "user" } });
      await R.setUserRole(admin, { userId: o.id, role: "organizer", from: "user", clientOpId: crypto.randomUUID() });
      const stale = await R.setUserRole(admin, { userId: o.id, role: "organizer", from: "user", clientOpId: crypto.randomUUID() }).catch((e) => e);
      expect(stale).toMatchObject({ status: 409, current: { role: "organizer" } });
      await expect(R.setUserRole(admin, { userId: o.id, role: "organizer", from: "organizer", clientOpId: crypto.randomUUID() })).resolves.toMatchObject({ changed: false });
      await expect(R.setUserRole(admin, { userId: o.id, role: "user", clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ name: "ZodError" }); // `from` is required
      await expect(R.setUserRole(admin, { userId: o.id, role: "user", from: "organizer" })).rejects.toMatchObject({ name: "ZodError" }); // so is `clientOpId`
    });

    it("clientOpId replays the first result, even after the role moved; another request under the same id is a 409", async () => {
      const o = await makeUser(sql, P, "ledger", "user");
      const clientOpId = crypto.randomUUID();
      const body = { userId: o.id, role: "organizer", from: "user", clientOpId } as const;
      const first = await R.setUserRole(admin, body);
      expect(first).toMatchObject({ changed: true, replayed: false });
      await R.setUserRole(admin, { userId: o.id, role: "user", from: "organizer", clientOpId: crypto.randomUUID() }); // someone moves it back
      const again = await R.setUserRole(admin, body);
      expect(again).toMatchObject({ changed: true, role: "organizer", previous: "user", replayed: true });
      const [{ role }] = await sql`select role from "user" where id = ${o.id}`;
      expect(role).toBe("user"); // the replay changed nothing
      await expect(R.setUserRole(admin, { ...body, role: "user", from: "organizer" })).rejects.toMatchObject({ status: 409, code: "op_id_reused" });
    });

    it("parallel duplicates of one clientOpId make one change", async () => {
      const o = await makeUser(sql, P, "ledgerpar", "user");
      const published = await publish((await makeUser(sql, P, "ledgerowner", "organizer")), eventInput());
      expect(published.id).toBeTruthy();
      const clientOpId = crypto.randomUUID();
      const r = await Promise.all(Array.from({ length: 5 }, () => R.setUserRole(admin, { userId: o.id, role: "organizer", from: "user", clientOpId })));
      expect(r.filter((x) => !x.replayed)).toHaveLength(1);
      expect(r.every((x) => x.changed && x.role === "organizer")).toBe(true);
      const [{ n }] = await sql`select count(*)::int as n from op_ledger where actor_id = ${admin.id} and client_op_id = ${clientOpId}`;
      expect(n).toBe(1);
    });

    it("an admin's role can't be changed, nobody is promoted to admin, and unknown users are a 404", async () => {
      await expect(R.setUserRole(admin, { userId: admin.id, role: "user", from: "admin", clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 });
      await expect(R.setUserRole(admin, { userId: attendee.id, role: "admin", from: "user", clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ name: "ZodError" });
      await expect(R.setUserRole(admin, { userId: "ac-nobody", role: "organizer", from: "user", clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ status: 404 });
    });

    it("two admins changing each other's targets in parallel don't deadlock", async () => {
      const admin2 = await makeUser(sql, P, "admin2", "admin");
      const targets = await Promise.all(Array.from({ length: 4 }, (_, i) => makeUser(sql, P, `par${i}`, "user")));
      const ops = targets.flatMap((t) => [
        R.setUserRole(admin, { userId: t.id, role: "organizer", from: "user", clientOpId: crypto.randomUUID() }),
        R.setUserRole(admin2, { userId: t.id, role: "organizer", from: "user", clientOpId: crypto.randomUUID() }),
        R.setUserRole(admin, { userId: admin2.id, role: "user", from: "admin", clientOpId: crypto.randomUUID() }),
        R.setUserRole(admin2, { userId: admin.id, role: "user", from: "admin", clientOpId: crypto.randomUUID() }),
      ]);
      const results = await Promise.allSettled(ops);
      for (const r of results) if (r.status === "rejected") expect(typeof (r.reason as { status?: number }).status).toBe("number");
      for (const t of targets) expect((await sql`select role from "user" where id = ${t.id}`)[0].role).toBe("organizer");
    });
  });

  describe("every write spends the write limit (300 per hour)", () => {
    it("a user over the limit gets 429 on each write, nothing changes, and 299 attempts leave room for exactly one", async () => {
      const o = await makeUser(sql, P, "limited", "organizer");
      const s = await makeUser(sql, P, "limitedstaff", "user");
      const e = await publish(o, eventInput({ title: "Limited" }));
      const token = new URL((await ST.createInvite(o, e.id, op())).link).hash.slice(3);
      const target = await makeUser(sql, P, "limitedtarget", "user");
      const adm = await makeUser(sql, P, "limitedadmin", "admin");

      await fillRate(sql, o.id, 300);
      const organiserWrites: (() => Promise<unknown>)[] = [
        () => EV.createEvent(o, eventInput()),
        () => EV.updateEvent(o, e.id, { version: e.version, venueName: "x" }),
        () => EV.deleteEvent(o, e.id),
        () => TT.createTicketType(o, e.id, { name: "VIP", capacity: 1, clientOpId: crypto.randomUUID() }),
        () => TT.updateTicketType(o, e.id, e.typeId, { version: 1, name: "x" }),
        () => TT.deleteTicketType(o, e.id, e.typeId),
        () => ST.createInvite(o, e.id, op()),
        () => ST.revokeInvite(o, e.id, crypto.randomUUID()),
        () => ST.removeStaff(o, e.id, "someone", op()),
      ];
      for (const [i, w] of organiserWrites.entries()) await expect(w(), `organiser write ${i}`).rejects.toMatchObject({ status: 429 });

      await fillRate(sql, s.id, 300);
      await expect(ST.acceptInvite(s, { token })).rejects.toMatchObject({ status: 429 });
      const [{ used }] = await sql`select count(*)::int as used from staff_invite where event_id = ${e.id} and used_at is not null`;
      expect(used).toBe(0);

      await fillRate(sql, adm.id, 300);
      await expect(R.setUserRole(adm, { userId: target.id, role: "organizer", from: "user", clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ status: 429 });
      await expect(AD.hideEvent(adm, e.id, { hidden: true, reason: "x", clientOpId: crypto.randomUUID() })).rejects.toMatchObject({ status: 429 });
      expect((await sql`select role from "user" where id = ${target.id}`)[0].role).toBe("user");

      await fillRate(sql, o.id, 299);
      await expect(EV.updateEvent(o, e.id, { version: e.version, venueName: "Spent the last one" })).resolves.toBeTruthy();
      await expect(EV.updateEvent(o, e.id, { version: e.version + 1, venueName: "Over" })).rejects.toMatchObject({ status: 429 });
      // A refused write (here a stale version) rolls its attempt back, so it doesn't eat the allowance.
      await fillRate(sql, o.id, 100);
      await expect(EV.updateEvent(o, e.id, { version: 1, venueName: "stale" })).rejects.toMatchObject({ status: 409 });
      const [{ n }] = await sql`select count(*)::int as n from rate_event where user_id = ${o.id} and kind = 'api_write'`;
      expect(n).toBe(100);
    });
  });
});
