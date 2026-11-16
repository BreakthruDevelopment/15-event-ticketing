import "server-only";
import { createHash, createHmac } from "node:crypto";
import { and, asc, count, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { assertCan } from "@/lib/access";
import { type Actor, toRole } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { CodedConflictError, NotFoundError } from "@/lib/errors";
import { LIMITS, TOO_MANY_READS, idParam, inviteTokenInput, newInviteInput, removeStaffInput } from "@/lib/event-schema";
import { lockOwnEvent } from "@/lib/events";
import { log } from "@/lib/log";
import { withOp } from "@/lib/op-ledger";
import { idText } from "@/lib/text";
import { deriveKey } from "@/lib/tickets/keys";
import { consumeRate } from "@/lib/usage";
import { spendRead, writeTx } from "@/lib/write-tx";

/**
 * Door staff: invites, accept, remove, and the list of events a user may open the door for.
 *
 * Staff is not a role: it is a row in `event_staff`, created when a signed-in user accepts the organiser's invite and
 * checked on every door request (`resolveDoorAccess` in src/lib/access.ts), so removal takes effect on the next scan.
 * An invite is a 128-bit token; only its sha256 is stored, and the link carries it in the URL FRAGMENT
 * (`/staff-invite#t=<token>`), which browsers never send, so request logs and referrers never see it. It is single
 * use and expires after 72 hours. The token is HMAC(key, event id + client op id) with the key derived from
 * `BETTER_AUTH_SECRET` (HKDF), so it is unguessable, never stored, and a retried create (same `clientOpId`) re-derives
 * the same link instead of making a second invite whose link nobody could recover.
 */

const S = schema.eventStaff;
const I = schema.staffInvite;
const E = schema.event;

/** A stable UUID from a string (first 16 bytes of its sha256, version and variant bits set). */
function uuidFrom(text: string): string {
  const b = createHash("sha256").update(text).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const digest = (token: string) => createHash("sha256").update(token).digest();

/** The token for (event, op id): 16 bytes of HMAC-SHA256, base64url (22 characters). Ids are lower-cased first (Postgres returns uuids in lower case, and accept re-derives from the stored value). Key: `src/lib/tickets/keys.ts`. */
function inviteToken(eventId: string, clientOpId: string): string {
  return createHmac("sha256", deriveKey("staff-invite:v1")).update(`${eventId.toLowerCase()}:${clientOpId.toLowerCase()}`).digest().subarray(0, 16).toString("base64url");
}

const linkFor = (token: string) => `${env().APP_URL.replace(/\/$/, "")}/staff-invite#t=${token}`;

/** An invite that can still be accepted. */
const openInvite = () => and(isNull(I.usedAt), isNull(I.revokedAt), gt(I.expiresAt, sql`now()`));

/** The 404 for an unknown, used or expired token: one message, so a prober learns nothing. */
const noInvite = () => new NotFoundError("This invite isn't valid.");

/** Staff and open invites of one of the organiser's events. Never the token. */
export async function listStaff(actor: Actor | null, rawEventId: string) {
  assertCan(actor, "event:manage");
  await spendRead(actor);
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
    .where(and(eq(I.eventId, eventId), openInvite()))
    .orderBy(desc(I.createdAt))
    .limit(LIMITS.openInvitesPerEvent);
  return { staff, invites };
}

/**
 * Create a single-use invite (72 hours) and return its link. Body `{ clientOpId }`, one id per click: a retry with the
 * same id returns the same invite and link with `replayed: true` (the unique (event, op id) index backs it, and the
 * organiser's allowance lock serialises parallel duplicates), and costs no extra open-invite slot. A retry after the
 * invite was used, revoked or expired is 409 `invite_closed`: it needs a new id. At most 10 open invites per event.
 */
export async function createInvite(actor: Actor | null, rawEventId: string, input: unknown) {
  assertCan(actor, "event:manage");
  const { clientOpId } = newInviteInput.parse(input);
  const out = await writeTx(actor, "event:manage", async (tx) => {
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    const token = inviteToken(ev.id, clientOpId);
    const [existing] = await tx
      .select({ id: I.id, tokenDigest: I.tokenDigest, expiresAt: I.expiresAt, usedAt: I.usedAt, revokedAt: I.revokedAt, expired: sql<boolean>`${I.expiresAt} <= now()` })
      .from(I)
      .where(and(eq(I.eventId, ev.id), eq(I.clientOpId, clientOpId)));
    if (existing) {
      // A stored digest the current key no longer derives (secret rotated) can never be accepted: closed, like a used one.
      if (existing.usedAt || existing.revokedAt || existing.expired || !existing.tokenDigest.equals(digest(token))) {
        throw new CodedConflictError("invite_closed", "That invite was already used, revoked or has expired. Create a new one.");
      }
      return { eventId: ev.id, id: existing.id, expiresAt: existing.expiresAt, token, replayed: true };
    }
    if (ev.status === "cancelled") throw new CodedConflictError("event_cancelled", "A cancelled event can't take door staff.");
    // The event row lock also serialises this count against other invites and against accepts, so the cap is exact.
    const [{ open }] = await tx.select({ open: count() }).from(I).where(and(eq(I.eventId, ev.id), openInvite()));
    if (open >= LIMITS.openInvitesPerEvent) throw new CodedConflictError("invite_limit", `At most ${LIMITS.openInvitesPerEvent} invites can be open at once. Revoke one first.`);
    const [row] = await tx
      .insert(I)
      .values({
        eventId: ev.id,
        tokenDigest: digest(token),
        clientOpId,
        expiresAt: sql`now() + make_interval(hours => ${LIMITS.inviteTtlHours})`,
        createdBy: actor.id,
      })
      .returning({ id: I.id, expiresAt: I.expiresAt });
    return { eventId: ev.id, ...row, token, replayed: false };
  });
  if (!out.replayed) log.info("staff.invite.created", { actorId: actor.id, eventId: out.eventId });
  return { id: out.id, expiresAt: out.expiresAt, link: linkFor(out.token), replayed: out.replayed };
}

/** Revoke an open invite (it stays as a row, marked, so a stale retry can't recreate it). A second call, a used invite or an unknown id answers `revoked: false`; a foreign event is a 404 first. */
export async function revokeInvite(actor: Actor | null, rawEventId: string, rawInviteId: string): Promise<{ revoked: boolean }> {
  assertCan(actor, "event:manage");
  const inviteId = idParam.parse(rawInviteId);
  return writeTx(actor, "event:manage", async (tx) => {
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    const rows = await tx
      .update(I)
      .set({ revokedAt: new Date() })
      .where(and(eq(I.id, inviteId), eq(I.eventId, ev.id), isNull(I.usedAt), isNull(I.revokedAt)))
      .returning({ id: I.id });
    return { revoked: rows.length > 0 };
  });
}

/**
 * Remove a staffer. Their next door request is a 404. Body `{ clientOpId }`, required (`op_ledger`): a late retry of a
 * removal returns the first result and doesn't remove a membership the organiser granted again in between (re-invited,
 * accepted, then the old DELETE arrives). A new id for a staffer who is already gone answers `removed: false`.
 */
export async function removeStaff(actor: Actor | null, rawEventId: string, rawUserId: string, input: unknown): Promise<{ removed: boolean; replayed: boolean }> {
  assertCan(actor, "event:manage");
  const userId = idText.parse(rawUserId);
  const { clientOpId } = removeStaffInput.parse(input);
  const out = await writeTx(actor, "event:manage", async (tx) => {
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    return withOp(tx, actor.id, { kind: "staff-remove", clientOpId, payload: `${ev.id}\n${userId}` }, async () => {
      const rows = await tx.delete(S).where(and(eq(S.eventId, ev.id), eq(S.userId, userId))).returning({ userId: S.userId });
      return { removed: rows.length > 0, eventId: ev.id };
    });
  });
  if (!out.replayed && out.result.removed) log.info("staff.removed", { actorId: actor.id, eventId: out.result.eventId, userId });
  return { removed: out.result.removed, replayed: out.replayed };
}

/**
 * Accept an invite: body `{ token }`. One transaction, in lock order user, allowance, event, invite, staff:
 * the event row is locked first (as every organiser write does), then
 * `update staff_invite set used_by, used_at where id = $i and used_at is null and expires_at > now()`; zero rows is the
 * same 404 for an unknown, used or expired token. The organiser of the event can't accept their own invite (same 404,
 * the invite stays unused), and neither can anyone for a cancelled or hidden event. Someone who is already staff gets 200 `replayed: true` and the invite stays open. At most 20 staff per event (409 `staff_full`,
 * and the invite stays unused). A retry by the user who already used this very token, while they are still staff,
 * answers 200 with `replayed: true`, so a lost response doesn't strand them.
 */
export async function acceptInvite(actor: Actor | null, input: unknown) {
  assertCan(actor, "staff-invite:accept");
  const { token } = inviteTokenInput.parse(input);
  const d = digest(token);
  const out = await writeTx(actor, "staff-invite:accept", async (tx) => {
    const [peek] = await tx.select({ id: I.id, eventId: I.eventId, clientOpId: I.clientOpId }).from(I).where(eq(I.tokenDigest, d));
    if (!peek) throw noInvite();
    // The token must still be the one the CURRENT key derives for this invite: after `BETTER_AUTH_SECRET` is rotated
    // every open invite fails here, even though its digest is still stored.
    if (!digest(inviteToken(peek.eventId, peek.clientOpId)).equals(d)) throw noInvite();
    // Event row first: the same order organiser writes use, so an accept can't deadlock a revoke or an invite.
    const [ev] = await tx.select({ id: E.id, title: E.title, organizerId: E.organizerId, status: E.status, hiddenAt: E.hiddenAt }).from(E).where(eq(E.id, peek.eventId)).for("update");
    if (!ev || ev.organizerId === actor.id || ev.status === "cancelled" || ev.hiddenAt) throw noInvite();
    // Already door staff here: answer ok and leave the invite open for someone else (no cap check, nothing burned).
    // The no-op is recorded in `op_ledger` (keyed by this token), so a delayed retry after the organiser removed them
    // answers the same and can't consume the invite and restore access.
    const noopOp = uuidFrom(`${d.toString("hex")}:${actor.id}`);
    const [noop] = await tx.select({ id: schema.opLedger.clientOpId }).from(schema.opLedger).where(and(eq(schema.opLedger.actorId, actor.id), eq(schema.opLedger.clientOpId, noopOp)));
    if (noop) {
      // A replay answers 200 only while they still hold the staff row; after a removal it is the invite 404.
      const [held] = await tx.select({ userId: S.userId }).from(S).where(and(eq(S.eventId, ev.id), eq(S.userId, actor.id)));
      if (!held) throw noInvite();
      return { eventId: ev.id, title: ev.title, replayed: true };
    }
    // Only while the invite is still open: a used invite takes the replay path below.
    const [stillOpen] = await tx.select({ id: I.id }).from(I).where(and(eq(I.id, peek.id), openInvite()));
    const [already] = stillOpen ? await tx.select({ userId: S.userId }).from(S).where(and(eq(S.eventId, ev.id), eq(S.userId, actor.id))) : [];
    if (already) {
      await tx.insert(schema.opLedger).values({ actorId: actor.id, clientOpId: noopOp, kind: "invite-accept-noop", payloadHash: d.toString("hex"), result: { eventId: ev.id } }).onConflictDoNothing();
      return { eventId: ev.id, title: ev.title, replayed: true };
    }
    const [used] = await tx
      .update(I)
      .set({ usedBy: actor.id, usedAt: new Date() })
      .where(and(eq(I.id, peek.id), openInvite()))
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
  // Signed-in reads spend the per-user `door_read` allowance (600/hour), also for users with no events at all.
  await db().transaction((tx) => consumeRate(tx, actor.id, "door_read", LIMITS.doorReadsPerHour, TOO_MANY_READS));
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
