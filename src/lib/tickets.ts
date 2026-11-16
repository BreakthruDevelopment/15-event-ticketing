import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { assertCan } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { dbErrorCode } from "@/lib/db-errors";
import { CodedConflictError, NotFoundError } from "@/lib/errors";
import { idParam } from "@/lib/event-schema";
import { lockOwnEvent } from "@/lib/events";
import { log } from "@/lib/log";
import { withOp } from "@/lib/op-ledger";
import { registrationOrder, releaseSeats } from "@/lib/registrations";
import { TICKET_LIMITS, attendeesQuery, guestsInput, idArg, opInput } from "@/lib/ticket-schema";
import { doorCodeFor, doorFor, formatDoorCode, signTicket } from "@/lib/tickets/token";
import { type Tx } from "@/lib/usage";
import { spendRead, writeTx } from "@/lib/write-tx";

/**
 * Tickets: the holder's own (list, one with its QR text and door code, reissue), and the organiser's side (attendees,
 * guest list, void, reissue). The QR text and the door code leave this module in exactly two places: a holder's own
 * `getMyTicket` / `reissueMyTicket`, and an organiser's own guest-list tickets (`addGuests`, `reissueTicketAsOrganizer`
 * on a guest ticket: nobody else holds those, so the organiser is the delivery channel). An attendee's QR is never
 * returned to the organiser. Both are derived on the fly from the ticket id and epoch (src/lib/tickets/token.ts) and
 * never stored or logged.
 *
 * Reads spend the signed-in read allowance (`api_read`, 1,200 an hour) before touching the database, a refused read
 * (bad id, someone else's ticket) included. Writes go through `writeTx` (src/lib/write-tx.ts) and are charged when refused.
 */

const E = schema.event;
const T = schema.ticketType;
const K = schema.ticket;
const R = schema.registration;

/** What a holder sees of one ticket. `qrText` and `doorCode` only while the ticket is valid. */
function holderTicket(r: { id: string; status: "valid" | "cancelled"; qrEpoch: number }) {
  const live = r.status === "valid";
  return {
    qrText: live ? signTicket(r.id, r.qrEpoch) : null,
    doorCode: live ? formatDoorCode(doorCodeFor(r.id, r.qrEpoch)) : null,
  };
}

const eventBrief = {
  id: E.id,
  slug: E.slug,
  title: E.title,
  venueName: E.venueName,
  address: E.address,
  timeZone: E.timeZone,
  startsAt: E.startsAt,
  endsAt: E.endsAt,
  status: E.status,
};

/** GET /api/tickets: the holder's own tickets, newest event first, at most 100. No QR text and no door code in a list. */
export async function listMyTickets(actor: Actor | null) {
  assertCan(actor, "event:register");
  await spendRead(actor);
  const rows = await db()
    .select({
      id: K.id,
      status: K.status,
      holderName: K.holderName,
      guestLabel: K.guestLabel,
      ticketTypeName: T.name,
      checkedIn: sql<boolean>`${K.checkedInAt} is not null`,
      registrationId: K.registrationId,
      registrationStatus: R.status,
      event: eventBrief,
    })
    .from(K)
    .innerJoin(E, eq(E.id, K.eventId))
    .innerJoin(T, eq(T.id, K.ticketTypeId))
    .leftJoin(R, eq(R.id, K.registrationId))
    .where(eq(K.holderUserId, actor.id))
    .orderBy(desc(E.startsAt), asc(K.createdAt), ...registrationOrder())
    .limit(TICKET_LIMITS.myTicketsLimit);
  return { tickets: rows };
}

/** One of the holder's tickets, read inside `tx` or the pool. 404 for anyone else's (and a missing id). */
async function holderView(reader: Pick<Tx, "select">, ticketId: string, userId: string) {
  const [r] = await reader
    .select({
      id: K.id,
      status: K.status,
      holderName: K.holderName,
      guestLabel: K.guestLabel,
      qrEpoch: K.qrEpoch,
      checkedInAt: K.checkedInAt,
      ticketTypeName: T.name,
      registrationId: K.registrationId,
      registrationStatus: R.status,
      event: eventBrief,
    })
    .from(K)
    .innerJoin(E, eq(E.id, K.eventId))
    .innerJoin(T, eq(T.id, K.ticketTypeId))
    .leftJoin(R, eq(R.id, K.registrationId))
    .where(and(eq(K.id, ticketId), eq(K.holderUserId, userId)));
  if (!r) throw new NotFoundError();
  const { qrEpoch, ...rest } = r;
  return { ...rest, qrEpoch, ...holderTicket(r) };
}

/** GET /api/tickets/[id]: the holder's ticket with `qrText` and `doorCode`. 404 for anyone but the holder. The route sends `no-store`. */
export async function getMyTicket(actor: Actor | null, rawId: string) {
  assertCan(actor, "event:register");
  await spendRead(actor);
  return holderView(db(), idArg.parse(rawId), actor.id);
}

/**
 * Shared by the holder's and the organiser's reissue. The ticket row is already locked FOR UPDATE by the caller.
 * Bumps `qr_epoch` and rewrites the door digest in ONE update, so the old QR and the old door code answer `invalid`
 * from then on (the QR carries the epoch; the digest is of a code derived from it). Limits: 5 per ticket per UTC day,
 * and the epoch can't pass 20 (the schema's check), so 19 reissues ever. A cancelled ticket can't be reissued.
 */
async function bumpEpoch(
  tx: Tx,
  t: { id: string; status: "valid" | "cancelled"; qrEpoch: number; reissuesToday: number; reissueDay: string | null; today: string },
): Promise<number> {
  if (t.status !== "valid") throw new CodedConflictError("ticket_cancelled", "That ticket was cancelled.");
  if (t.qrEpoch >= TICKET_LIMITS.maxEpoch) throw new CodedConflictError("reissue_limit", "This ticket has been reissued as often as it can be.");
  const usedToday = t.reissueDay === t.today ? t.reissuesToday : 0;
  if (usedToday >= TICKET_LIMITS.reissuesPerDay) throw new CodedConflictError("reissue_limit_day", `A ticket can be reissued ${TICKET_LIMITS.reissuesPerDay} times a day. Try again tomorrow.`);
  const epoch = t.qrEpoch + 1;
  try {
    const rows = await tx
      .update(K)
      .set({ qrEpoch: epoch, reissuesToday: usedToday + 1, reissueDay: t.today, doorCodeDigest: doorFor(t.id, epoch).digest })
      .where(and(eq(K.id, t.id), eq(K.qrEpoch, t.qrEpoch), eq(K.status, "valid")))
      .returning({ id: K.id });
    if (rows.length !== 1) throw new CodedConflictError("retry", "That was busy. Try again.");
  } catch (err) {
    // The new door code collided with another ticket's at this event (50 bits: effectively never). Nothing changed.
    if (dbErrorCode(err) === "23505") throw new CodedConflictError("retry", "That was busy. Try again.");
    throw err;
  }
  return epoch;
}

const lockedTicket = {
  id: K.id,
  eventId: K.eventId,
  status: K.status,
  qrEpoch: K.qrEpoch,
  reissuesToday: K.reissuesToday,
  reissueDay: K.reissueDay,
  today: sql<string>`(now() at time zone 'utc')::date::text`,
};

/**
 * The holder reissues their own ticket: body `{ clientOpId }`. Returns the ticket as `getMyTicket` does, with the new
 * `qrText` and `doorCode`. Idempotent through `op_ledger`: a retry returns the current ticket (`replayed: true`) and
 * doesn't burn another reissue. 404 for anyone else's ticket.
 */
export async function reissueMyTicket(actor: Actor | null, rawId: string, input: unknown) {
  assertCan(actor, "event:register");
  const out = await writeTx(actor, "event:register", async (tx) => {
    const id = idArg.parse(rawId);
    const { clientOpId } = opInput.parse(input);
    const op = await withOp(tx, actor.id, { kind: "ticket-reissue", clientOpId, payload: id }, async () => {
      const [t] = await tx.select(lockedTicket).from(K).where(and(eq(K.id, id), eq(K.holderUserId, actor.id))).for("update");
      if (!t) throw new NotFoundError();
      const epoch = await bumpEpoch(tx, t);
      return { ticketId: t.id, eventId: t.eventId, epoch };
    });
    return { view: await holderView(tx, id, actor.id), replayed: op.replayed, fresh: op.replayed ? null : op.result };
  });
  if (out.fresh) log.info("ticket.reissued", { actorId: actor.id, eventId: out.fresh.eventId, ticketId: out.fresh.ticketId, by: "holder" });
  return { ticket: out.view, replayed: out.replayed };
}

// ---------------------------------------------------------------------------
// Organiser side
// ---------------------------------------------------------------------------

/**
 * GET /api/organizer/events/[id]/attendees?page=&status=: the event's tickets, 50 a page, oldest first: holder name,
 * guest label, the holder's email (null for guest-list tickets), ticket type, status, source, checked-in time. Never a
 * QR text or a door code. 404 for another organiser's event. Spends `api_read`.
 */
export async function listAttendees(actor: Actor | null, rawEventId: string, query: unknown = {}) {
  assertCan(actor, "event:manage");
  await spendRead(actor);
  const eventId = idParam.parse(rawEventId);
  const q = attendeesQuery.parse(query);
  const [ev] = await db().select({ id: E.id }).from(E).where(and(eq(E.id, eventId), eq(E.organizerId, actor.id)));
  if (!ev) throw new NotFoundError();
  const where = q.status ? and(eq(K.eventId, ev.id), eq(K.status, q.status)) : eq(K.eventId, ev.id);
  const [{ total }] = await db().select({ total: count() }).from(K).where(where);
  const rows = await db()
    .select({
      ticketId: K.id,
      registrationId: K.registrationId,
      holderName: K.holderName,
      guestLabel: K.guestLabel,
      email: schema.user.email,
      ticketTypeId: K.ticketTypeId,
      ticketTypeName: T.name,
      status: K.status,
      source: K.source,
      checkedInAt: K.checkedInAt,
      createdAt: K.createdAt,
    })
    .from(K)
    .innerJoin(T, eq(T.id, K.ticketTypeId))
    .leftJoin(schema.user, eq(schema.user.id, K.holderUserId))
    .where(where)
    .orderBy(asc(K.createdAt), ...registrationOrder())
    .limit(TICKET_LIMITS.attendeesPageSize)
    .offset((q.page - 1) * TICKET_LIMITS.attendeesPageSize);
  return { attendees: rows, page: q.page, pageSize: TICKET_LIMITS.attendeesPageSize, total };
}

/**
 * POST /api/organizer/events/[id]/guests, body `{ ticketTypeId, guests: [{ name, label? }] (1 to 20), clientOpId }`:
 * guest-list tickets (`holder_user_id` null), counted against the type's capacity by the same conditional increment
 * as a registration, at most 500 a day per event. Only for a published, visible event (409 otherwise). Returns each
 * ticket with its `qrText` and `doorCode`: the organiser hands those on. Idempotent through `op_ledger`.
 */
export async function addGuests(actor: Actor | null, rawEventId: string, input: unknown) {
  assertCan(actor, "event:manage");
  const out = await writeTx(actor, "event:manage", async (tx) => {
    const data = guestsInput.parse(input);
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    const payload = JSON.stringify([ev.id, data.ticketTypeId, data.guests.map((g) => [g.name, g.label ?? null])]);
    const op = await withOp(tx, actor.id, { kind: "guests-add", clientOpId: data.clientOpId, payload }, async () => {
      const [hid] = await tx.select({ hiddenAt: E.hiddenAt }).from(E).where(eq(E.id, ev.id));
      if (ev.status === "cancelled") throw new CodedConflictError("event_cancelled", "This event was cancelled.");
      if (ev.status !== "published" || hid?.hiddenAt) throw new CodedConflictError("not_open", "Guests can be added only to a published event that is visible.");
      const [type] = await tx.select({ id: T.id }).from(T).where(and(eq(T.id, data.ticketTypeId), eq(T.eventId, ev.id)));
      if (!type) throw new NotFoundError();
      // Under the event's FOR UPDATE lock, so the daily cap is exact.
      const [{ today }] = await tx
        .select({ today: count() })
        .from(K)
        .where(and(eq(K.eventId, ev.id), eq(K.source, "guest_list"), sql`${K.createdAt} > now() - interval '1 day'`));
      if (today + data.guests.length > TICKET_LIMITS.guestsPerEventPerDay) {
        throw new CodedConflictError("guest_limit", `At most ${TICKET_LIMITS.guestsPerEventPerDay} guest tickets a day per event.`);
      }
      const n = data.guests.length;
      const bumped = await tx
        .update(T)
        .set({ issued: sql`${T.issued} + ${n}` })
        .where(and(eq(T.id, type.id), eq(T.eventId, ev.id), sql`${T.issued} + ${n} <= ${T.capacity}`))
        .returning({ issued: T.issued });
      if (bumped.length === 0) {
        const [cur] = await tx.select({ left: sql<number>`${T.capacity} - ${T.issued}` }).from(T).where(eq(T.id, type.id));
        const left = Math.max(0, cur?.left ?? 0);
        throw new CodedConflictError("sold_out", left === 0 ? "Sold out." : `Only ${left} seat${left === 1 ? "" : "s"} left for that ticket type.`);
      }
      const rows = data.guests.map((g) => {
        const id = randomUUID();
        return {
          id,
          eventId: ev.id,
          ticketTypeId: type.id,
          registrationId: null,
          holderUserId: null,
          holderName: g.name,
          guestLabel: g.label ? g.label : null,
          source: "guest_list" as const,
          doorCodeDigest: doorFor(id, 1).digest,
        };
      });
      const made = await tx.insert(K).values(rows).onConflictDoNothing().returning({ id: K.id });
      if (made.length !== rows.length) throw new CodedConflictError("retry", "That was busy. Try again.");
      return { eventId: ev.id, ticketIds: rows.map((r) => r.id) };
    });
    const tickets = await tx
      .select({ id: K.id, holderName: K.holderName, guestLabel: K.guestLabel, status: K.status, qrEpoch: K.qrEpoch, ticketTypeName: T.name })
      .from(K)
      .innerJoin(T, eq(T.id, K.ticketTypeId))
      .where(and(eq(K.eventId, ev.id), eq(K.source, "guest_list"), inArray(K.id, op.result.ticketIds as string[])))
      .orderBy(asc(K.createdAt), asc(K.id));
    // Back in the order the organiser listed them (one insert gives every row the same `created_at`).
    const rank = new Map((op.result.ticketIds as string[]).map((id, i) => [id, i]));
    tickets.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    return { tickets, replayed: op.replayed, count: op.replayed ? 0 : data.guests.length, eventId: ev.id };
  });
  if (out.count > 0) log.info("guests.added", { actorId: actor.id, eventId: out.eventId, count: out.count });
  return {
    tickets: out.tickets.map(({ qrEpoch, ...t }) => ({ ...t, ...holderTicket({ id: t.id, status: t.status, qrEpoch }) })),
    replayed: out.replayed,
  };
}

/**
 * The organiser voids one ticket of their event: body `{ clientOpId }`. One conditional update (`status = 'valid' and
 * checked_in_at is null`), then `issued` drops by the rows it changed and, when the registration has no valid ticket
 * left, the registration becomes cancelled (so the attendee can register again). Zero rows (already cancelled by the
 * attendee or a void, or checked in): 409 `ticket_not_voidable`, `issued` untouched. Another organiser's event or
 * ticket: 404. Idempotent through `op_ledger`.
 */
export async function voidTicket(actor: Actor | null, rawEventId: string, rawTicketId: string, input: unknown) {
  assertCan(actor, "event:manage");
  const out = await writeTx(actor, "event:manage", async (tx) => {
    const ticketId = idArg.parse(rawTicketId);
    const { clientOpId } = opInput.parse(input);
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    return withOp(tx, actor.id, { kind: "ticket-void", clientOpId, payload: `${ev.id}\n${ticketId}` }, async () => {
      // Row lock first, so a racing scan or cancel finishes (or waits) before the conditional update decides.
      const [locked] = await tx.select({ id: K.id }).from(K).where(and(eq(K.id, ticketId), eq(K.eventId, ev.id))).for("update");
      if (!locked) throw new NotFoundError();
      const rows = await tx
        .update(K)
        .set({ status: "cancelled" })
        .where(and(eq(K.id, ticketId), eq(K.eventId, ev.id), eq(K.status, "valid"), sql`${K.checkedInAt} is null`))
        .returning({ id: K.id, ticketTypeId: K.ticketTypeId, registrationId: K.registrationId });
      if (rows.length === 0) {
        const [cur] = await tx.select({ status: K.status, checkedIn: sql<boolean>`${K.checkedInAt} is not null` }).from(K).where(eq(K.id, ticketId));
        throw new CodedConflictError("ticket_not_voidable", cur?.checkedIn ? "That ticket is already checked in." : "That ticket is already cancelled.");
      }
      await releaseSeats(tx, rows);
      let registrationCancelled = false;
      const regId = rows[0].registrationId;
      if (regId) {
        const [left] = await tx.select({ n: count() }).from(K).where(and(eq(K.registrationId, regId), eq(K.status, "valid")));
        if (left.n === 0) {
          const done = await tx.update(R).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(R.id, regId), eq(R.status, "active"))).returning({ id: R.id });
          registrationCancelled = done.length > 0;
        }
      }
      return { ticketId, eventId: ev.id, registrationCancelled };
    });
  });
  if (!out.replayed) log.info("ticket.voided", { actorId: actor.id, eventId: out.result.eventId, ticketId: out.result.ticketId });
  return { ticketId: out.result.ticketId, voided: true, registrationCancelled: out.result.registrationCancelled, replayed: out.replayed };
}

/**
 * The organiser reissues a ticket of their event (a screenshot got out): body `{ clientOpId }`, same limits as the
 * holder's. The response carries the new `qrText` and `doorCode` ONLY for a guest-list ticket (the organiser holds
 * those); for an attendee's ticket it returns just the new epoch, since the attendee's QR is theirs alone.
 */
export async function reissueTicketAsOrganizer(actor: Actor | null, rawEventId: string, rawTicketId: string, input: unknown) {
  assertCan(actor, "event:manage");
  const out = await writeTx(actor, "event:manage", async (tx) => {
    const ticketId = idArg.parse(rawTicketId);
    const { clientOpId } = opInput.parse(input);
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    const op = await withOp(tx, actor.id, { kind: "ticket-reissue-org", clientOpId, payload: `${ev.id}\n${ticketId}` }, async () => {
      const [t] = await tx.select({ ...lockedTicket, source: K.source }).from(K).where(and(eq(K.id, ticketId), eq(K.eventId, ev.id))).for("update");
      if (!t) throw new NotFoundError();
      const epoch = await bumpEpoch(tx, t);
      return { ticketId: t.id, eventId: ev.id, epoch };
    });
    const [cur] = await tx.select({ id: K.id, status: K.status, qrEpoch: K.qrEpoch, source: K.source }).from(K).where(eq(K.id, ticketId));
    return { cur, replayed: op.replayed, eventId: ev.id };
  });
  if (!out.replayed) log.info("ticket.reissued", { actorId: actor.id, eventId: out.eventId, ticketId: out.cur.id, by: "organizer" });
  return {
    ticketId: out.cur.id,
    qrEpoch: out.cur.qrEpoch,
    status: out.cur.status,
    ...(out.cur.source === "guest_list" ? holderTicket(out.cur) : {}),
    replayed: out.replayed,
  };
}
