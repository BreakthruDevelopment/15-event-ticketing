import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { assertCan } from "@/lib/access";
import { type Actor, toRole } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { CodedConflictError, NotFoundError } from "@/lib/errors";
import { LIMITS, idParam, inviteTokenInput } from "@/lib/event-schema";
import { lockOwnEvent } from "@/lib/events";
import { log } from "@/lib/log";
import { idText } from "@/lib/text";
import { writeTx } from "@/lib/write-tx";

/**
 * Door staff: invites, accept, remove, and the list of events a user may open the door for.
 *
 * Staff is not a role: it is a row in `event_staff`, created when a signed-in user accepts the organiser's invite and
 * checked on every door request (`resolveDoorAccess` in src/lib/access.ts), so removal takes effect on the next scan.
 * An invite is a random 128-bit token; only its sha256 is stored, and the link carries it in the URL FRAGMENT
 * (`/staff-invite#t=<token>`), which browsers never send, so request logs and referrers never see it. It is shown once,
 * single use, and expires after 72 hours.
 */

const S = schema.eventStaff;
const I = schema.staffInvite;
const E = schema.event;

const digest = (token: string) => createHash("sha256").update(token).digest();

/** The 404 for an unknown, used or expired token: one message, so a prober learns nothing. */
const noInvite = () => new NotFoundError("This invite isn't valid.");

/** Staff and open invites of one of the organiser's events. Never the token. */
export async function listStaff(actor: Actor | null, rawEventId: string) {
  assertCan(actor, "event:manage");
  const eventId = idParam.parse(rawEventId);
  const [ev] = await db().select({ id: E.id }).from(E).where(and(eq(E.id, eventId), eq(E.organizerId, actor.id)));
  if (!ev) throw new NotFoundError();
  const staff = await db()
    .select({ userId: S.userId, name: schema.user.name, email: schema.user.email, addedAt: S.createdAt })
    .from(S)
    .innerJoin(schema.user, eq(schema.user.id, S.userId))
    .where(eq(S.eventId, eventId))
    .orderBy(asc(S.createdAt))
    .limit(LIMITS.staffPerEvent);
  const invites = await db()
    .select({ id: I.id, createdAt: I.createdAt, expiresAt: I.expiresAt })
    .from(I)
    .where(and(eq(I.eventId, eventId), isNull(I.usedAt), gt(I.expiresAt, sql`now()`)))
    .orderBy(desc(I.createdAt))
    .limit(LIMITS.openInvitesPerEvent);
  return { staff, invites };
}

/**
 * Create a single-use invite (72 hours) and return the link ONCE. At most 10 open invites per event. A retry makes a
 * second, equally valid invite (the token can't be shown again); the organiser revokes the extra one.
 */
export async function createInvite(actor: Actor | null, rawEventId: string) {
  assertCan(actor, "event:manage");
  const token = randomBytes(16).toString("base64url");
  const out = await writeTx(actor, "event:manage", async (tx) => {
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    if (ev.status === "cancelled") throw new CodedConflictError("event_cancelled", "A cancelled event can't take door staff.");
    // The event row lock also serialises this count against other invites and against accepts, so the cap is exact.
    const [{ open }] = await tx
      .select({ open: count() })
      .from(I)
      .where(and(eq(I.eventId, ev.id), isNull(I.usedAt), gt(I.expiresAt, sql`now()`)));
    if (open >= LIMITS.openInvitesPerEvent) throw new CodedConflictError("invite_limit", `At most ${LIMITS.openInvitesPerEvent} invites can be open at once. Revoke one first.`);
    const [row] = await tx
      .insert(I)
      .values({
        eventId: ev.id,
        tokenDigest: digest(token),
        expiresAt: sql`now() + make_interval(hours => ${LIMITS.inviteTtlHours})`,
        createdBy: actor.id,
      })
      .returning({ id: I.id, expiresAt: I.expiresAt });
    return { eventId: ev.id, ...row };
  });
  log.info("staff.invite.created", { actorId: actor.id, eventId: out.eventId });
  return { id: out.id, expiresAt: out.expiresAt, link: `${env().APP_URL.replace(/\/$/, "")}/staff-invite#t=${token}` };
}

/** Revoke an open invite. A second call (or an unknown id) answers `revoked: false`; a foreign event is a 404 first. */
export async function revokeInvite(actor: Actor | null, rawEventId: string, rawInviteId: string): Promise<{ revoked: boolean }> {
  assertCan(actor, "event:manage");
  const inviteId = idParam.parse(rawInviteId);
  return writeTx(actor, "event:manage", async (tx) => {
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    const rows = await tx.delete(I).where(and(eq(I.id, inviteId), eq(I.eventId, ev.id))).returning({ id: I.id });
    return { revoked: rows.length > 0 };
  });
}

/** Remove a staffer. Their next door request is a 404. A second call answers `removed: false`. */
export async function removeStaff(actor: Actor | null, rawEventId: string, rawUserId: string): Promise<{ removed: boolean }> {
  assertCan(actor, "event:manage");
  const userId = idText.parse(rawUserId);
  const out = await writeTx(actor, "event:manage", async (tx) => {
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    const rows = await tx.delete(S).where(and(eq(S.eventId, ev.id), eq(S.userId, userId))).returning({ userId: S.userId });
    return { removed: rows.length > 0, eventId: ev.id };
  });
  if (out.removed) log.info("staff.removed", { actorId: actor.id, eventId: out.eventId, userId });
  return { removed: out.removed };
}

/**
 * Accept an invite: body `{ token }`. One transaction, in lock order user, allowance, event, invite, staff:
 * the event row is locked first (as every organiser write does), then
 * `update staff_invite set used_by, used_at where id = $i and used_at is null and expires_at > now()`; zero rows is the
 * same 404 for an unknown, used or expired token. The organiser of the event can't accept their own invite (same 404,
 * the invite stays unused), and neither can anyone for a cancelled event. At most 20 staff per event (409 `staff_full`,
 * and the invite stays unused). A retry by the user who already used this very token, while they are still staff,
 * answers 200 with `replayed: true`, so a lost response doesn't strand them.
 */
export async function acceptInvite(actor: Actor | null, input: unknown) {
  assertCan(actor, "staff-invite:accept");
  const { token } = inviteTokenInput.parse(input);
  const d = digest(token);
  const out = await writeTx(actor, "staff-invite:accept", async (tx) => {
    const [peek] = await tx.select({ id: I.id, eventId: I.eventId }).from(I).where(eq(I.tokenDigest, d));
    if (!peek) throw noInvite();
    // Event row first: the same order organiser writes use, so an accept can't deadlock a revoke or an invite.
    const [ev] = await tx.select({ id: E.id, title: E.title, organizerId: E.organizerId, status: E.status }).from(E).where(eq(E.id, peek.eventId)).for("update");
    if (!ev || ev.organizerId === actor.id || ev.status === "cancelled") throw noInvite();
    const [used] = await tx
      .update(I)
      .set({ usedBy: actor.id, usedAt: new Date() })
      .where(and(eq(I.id, peek.id), isNull(I.usedAt), gt(I.expiresAt, sql`now()`)))
      .returning({ createdBy: I.createdBy });
    if (!used) {
      const [again] = await tx.select({ usedBy: I.usedBy }).from(I).where(eq(I.id, peek.id));
      const [stillStaff] = again?.usedBy === actor.id ? await tx.select({ userId: S.userId }).from(S).where(and(eq(S.eventId, ev.id), eq(S.userId, actor.id))) : [];
      if (!stillStaff) throw noInvite();
      return { eventId: ev.id, title: ev.title, replayed: true };
    }
    const [{ n }] = await tx.select({ n: count() }).from(S).where(eq(S.eventId, ev.id));
    if (n >= LIMITS.staffPerEvent) throw new CodedConflictError("staff_full", `This event already has ${LIMITS.staffPerEvent} door staff.`);
    await tx.insert(S).values({ eventId: ev.id, userId: actor.id, invitedBy: used.createdBy }).onConflictDoNothing();
    return { eventId: ev.id, title: ev.title, replayed: false };
  });
  if (!out.replayed) log.info("staff.invite.accepted", { actorId: actor.id, eventId: out.eventId });
  return out;
}

/**
 * GET /api/door/events: events the actor can open the door for. Their own (only while they still hold the
 * `organizer` role) and the ones they are staff for, published, not cancelled, not hidden, whose check-in hasn't ended
 * (`ends_at` + 6 h) and that start within the next 7 days. Soonest first, at most 50.
 */
export async function listDoorEvents(actor: Actor | null) {
  assertCan(actor, "door:use");
  const [u] = await db().select({ role: schema.user.role, banned: schema.user.banned }).from(schema.user).where(eq(schema.user.id, actor.id));
  if (!u || u.banned) return { events: [] };
  const isOrganizer = toRole(u.role) === "organizer";
  const now = new Date();
  const horizon = new Date(now.getTime() + 7 * 24 * 3_600_000);
  const base = and(
    eq(E.status, "published"),
    isNull(E.hiddenAt),
    sql`${E.endsAt} + make_interval(hours => ${LIMITS.checkinTailHours}) >= ${now.toISOString()}::timestamptz`,
    lte(E.startsAt, horizon),
  );
  const cols = {
    id: E.id,
    slug: E.slug,
    title: E.title,
    venueName: E.venueName,
    timeZone: E.timeZone,
    startsAt: E.startsAt,
    endsAt: E.endsAt,
    checkinOpensAt: E.checkinOpensAt,
  };
  const staffed = await db()
    .select(cols)
    .from(E)
    .innerJoin(S, and(eq(S.eventId, E.id), eq(S.userId, actor.id)))
    .where(base)
    .orderBy(asc(E.startsAt))
    .limit(50);
  const owned = isOrganizer ? await db().select(cols).from(E).where(and(base, eq(E.organizerId, actor.id))).orderBy(asc(E.startsAt)).limit(50) : [];
  const events = [
    ...owned.map((e) => ({ ...e, via: "organizer" as const })),
    ...staffed.map((e) => ({ ...e, via: "staff" as const })),
  ]
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, 50)
    .map((e) => ({ ...e, checkinOpen: now >= e.checkinOpensAt && now.getTime() <= e.endsAt.getTime() + LIMITS.checkinTailHours * 3_600_000 }));
  return { events };
}
