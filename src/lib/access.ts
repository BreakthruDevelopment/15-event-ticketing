import "server-only";
import { type SQL, and, eq, inArray, isNull } from "drizzle-orm";
import { type Actor, ForbiddenError, type Role, UnauthorizedError, toRole } from "@/lib/auth/rbac";
import { type Db, schema } from "@/lib/db";
import { CodedConflictError, NotFoundError } from "@/lib/errors";
import { LIMITS } from "@/lib/event-schema";
import type { Tx } from "@/lib/usage";

/**
 * Access rules for this app, in one place. The template's `can()` (admin passes everything) is deliberately not
 * used: here admin sees counts and moderates, and never reads attendees, tickets or questions.
 *
 * | Who | Allowed | Test |
 * | --- | --- | --- |
 * | Public (no actor) | `published`, not hidden events (and a `cancelled` one's page, so the cancellation shows), their ticket types (name, seats left); never attendee data, the organiser's id, hidden fields or the version | access.integration |
 * | `user` (attendee) | Public, plus own registrations and tickets (QR text and door code only for own tickets; another user's ticket id is a 404), the FAQ bot, accepting a staff invite | access.integration, staff.integration |
 * | `organizer` | Everything about events with `organizer_id = actor.id`: details, ticket types, staff, invites, attendees, check-ins, questions. Another organiser's event, or a missing id, is a 404 on every read and write. Counts as an attendee too | access.integration, events.integration |
 * | Door staff (per event, not a role) | For events with an `event_staff` row: check-in, name search (name, ticket type, guest label, status) and counts. Nothing else (404) | access.integration, staff.integration |
 * | `admin` | Counts, roles, hide and unhide. Every content function is 403 | access.integration |
 *
 * Two kinds of "no": a wrong ROLE is 403 (`assertCan`); a right role asking for a row that isn't theirs, or doesn't
 * exist, is 404 (`NotFoundError`), so a stranger can't tell a missing id from someone else's. A malformed id (not a
 * uuid, or one with a NUL byte) is a 400 from the zod id schemas in `src/lib/text.ts`.
 *
 * Capabilities for the later slices are declared here too (this file is a foundation path: only 15.1 edits it).
 */
export type Capability =
  | "event:manage" // organizer: events, ticket types, staff, invites, FAQ, attendees, guests, void, undo, CSV, questions
  | "staff-invite:accept" // any attendee-capable user
  | "door:use" // door requests; the per-event rule is `resolveDoorAccess`
  | "event:register" // attendee: register, own tickets, reissue, cancel
  | "faq:ask" // attendee: the FAQ bot
  | "admin:stats"
  | "admin:roles"
  | "admin:hide"
  | "admin:demo";

const ATTENDEE: Role[] = ["user", "organizer"];

const GRANTS: Record<Capability, Role[]> = {
  "event:manage": ["organizer"],
  "staff-invite:accept": ATTENDEE,
  "door:use": ATTENDEE,
  "event:register": ATTENDEE,
  "faq:ask": ATTENDEE,
  "admin:stats": ["admin"],
  "admin:roles": ["admin"],
  "admin:hide": ["admin"],
  "admin:demo": ["admin"],
};

export function can(actor: Actor | null | undefined, capability: Capability): boolean {
  return !!actor && GRANTS[capability].includes(actor.role);
}

/** Every data function calls this first. 401 without an actor, 403 for the wrong role. */
export function assertCan(actor: Actor | null | undefined, capability: Capability): asserts actor is Actor {
  if (!actor) throw new UnauthorizedError();
  if (!can(actor, capability)) throw new ForbiddenError();
}

/** The roles that may do `capability`, for `writeTx`, which re-reads the actor's role from the database. */
export function rolesFor(capability: Capability): readonly Role[] {
  return GRANTS[capability];
}

/** What anyone may list: published and not hidden. */
export function publicEvent(): SQL {
  return and(eq(schema.event.status, "published"), isNull(schema.event.hiddenAt)) as SQL;
}

/** What anyone may open by slug: published, or cancelled after being published (the page says so), and not hidden. A draft is never public. */
export function publicEventPage(): SQL {
  return and(inArray(schema.event.status, ["published", "cancelled"]), isNull(schema.event.hiddenAt)) as SQL;
}

/** Is this row visible to the public (listing rules)? For rows already loaded. */
export function isPublic(row: { status: string; hiddenAt: Date | null }): boolean {
  return row.status === "published" && row.hiddenAt === null;
}

/** The event belongs to this actor acting as an organiser. */
export function ownsEvent(actor: Actor | null | undefined, row: { organizerId: string }): boolean {
  return !!actor && actor.role === "organizer" && row.organizerId === actor.id;
}

/**
 * The first lock of every write transaction: the acting user's row FOR SHARE, re-read from the database. The role in
 * `actor` came from the session, so this checks the CURRENT role and ban state: a revoke that committed a moment ago
 * wins (a revoke takes the same row FOR UPDATE, so it also waits for a write already in flight).
 *
 * Lock order for EVERY write in this app: (1) the acting user's row FOR SHARE here, (2) the actor's write-allowance
 * advisory lock (`consumeRate`, called by `writeTx`), (3) other user rows (a role change locks its target FOR UPDATE;
 * a hide reads the organiser FOR SHARE), (4) the event row, (5) its ticket types, registrations, tickets, staff and
 * invites. Taking rows before the allowance lock deadlocked app 14's edit against delete, so nobody does.
 */
export async function lockActor(tx: Tx, actor: Actor, allowed: readonly Role[]): Promise<Role> {
  const [u] = await tx
    .select({ role: schema.user.role, banned: schema.user.banned })
    .from(schema.user)
    .where(eq(schema.user.id, actor.id))
    .for("share");
  if (!u || u.banned) throw new ForbiddenError();
  const role = toRole(u.role);
  if (!allowed.includes(role)) throw new ForbiddenError();
  return role;
}

type Reader = Pick<Db, "select">;

export type DoorAccess = {
  event: {
    id: string;
    slug: string;
    title: string;
    timeZone: string;
    startsAt: Date;
    endsAt: Date;
    checkinOpensAt: Date;
    status: (typeof schema.EVENT_STATUSES)[number];
    hiddenAt: Date | null;
    organizerId: string;
  };
  /** How the actor got in: as the event's organiser (who still holds the `organizer` role) or as invited door staff. */
  via: "organizer" | "staff";
  /** Why check-in is closed right now, or null when it is open. */
  closed: null | "not_published" | "cancelled" | "hidden" | "not_open_yet" | "ended";
};

/**
 * Who may use the door of this event, decided from the database on every request (so a removed staffer and a revoked
 * organiser lose access on the next scan):
 *  - the event's organiser, only while they CURRENTLY hold the `organizer` role (read from the user row, not the session);
 *  - or a user with an `event_staff` row for it.
 * Anyone else, a missing event included, gets a 404. Whether the door is OPEN is a separate question, answered in
 * `closed` and enforced by `assertDoorOpen`: published, not cancelled, not hidden (admin hide or `organizer_revoked`),
 * and now between `checkin_opens_at` and `ends_at` + 6 h. A hidden event is therefore a 409 for its staff but a 404
 * for a revoked organiser.
 */
export async function resolveDoorAccess(reader: Reader, actor: Actor | null | undefined, eventId: string, now: Date = new Date()): Promise<DoorAccess> {
  assertCan(actor, "door:use");
  const E = schema.event;
  const [row] = await reader
    .select({
      id: E.id,
      slug: E.slug,
      title: E.title,
      timeZone: E.timeZone,
      startsAt: E.startsAt,
      endsAt: E.endsAt,
      checkinOpensAt: E.checkinOpensAt,
      status: E.status,
      hiddenAt: E.hiddenAt,
      organizerId: E.organizerId,
    })
    .from(E)
    .where(eq(E.id, eventId));
  if (!row) throw new NotFoundError();

  let via: DoorAccess["via"] | null = null;
  if (row.organizerId === actor.id) {
    const [u] = await reader.select({ role: schema.user.role, banned: schema.user.banned }).from(schema.user).where(eq(schema.user.id, actor.id));
    if (u && !u.banned && toRole(u.role) === "organizer") via = "organizer";
  } else {
    const [s] = await reader
      .select({ userId: schema.eventStaff.userId })
      .from(schema.eventStaff)
      .where(and(eq(schema.eventStaff.eventId, eventId), eq(schema.eventStaff.userId, actor.id)));
    if (s) via = "staff";
  }
  if (!via) throw new NotFoundError();
  return { event: row, via, closed: closedReason(row, now) };
}

export function closedReason(row: { status: string; hiddenAt: Date | null; checkinOpensAt: Date; endsAt: Date }, now: Date): DoorAccess["closed"] {
  if (row.status === "cancelled") return "cancelled";
  if (row.status !== "published") return "not_published";
  if (row.hiddenAt) return "hidden";
  if (now.getTime() < row.checkinOpensAt.getTime()) return "not_open_yet";
  if (now.getTime() > row.endsAt.getTime() + LIMITS.checkinTailHours * 3_600_000) return "ended";
  return null;
}

/** 409 `checkin_closed` when the door is shut (see `resolveDoorAccess`). */
export function assertDoorOpen(access: Pick<DoorAccess, "closed">): void {
  if (access.closed) throw new CodedConflictError("checkin_closed", "Check-in is closed for this event.");
}
