import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { assertCan } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { schema } from "@/lib/db";
import { dbErrorCode } from "@/lib/db-errors";
import { BadRequestError, CodedConflictError, NotFoundError } from "@/lib/errors";
import { log } from "@/lib/log";
import { withOp } from "@/lib/op-ledger";
import { TICKET_LIMITS, idArg, opInput, registerInput } from "@/lib/ticket-schema";
import { doorFor } from "@/lib/tickets/token";
import { type Tx, consumeRate } from "@/lib/usage";
import { writeTx } from "@/lib/write-tx";

/**
 * Registration (free tickets, spec "Registration and capacity"), the attendee side. One transaction per request, in the
 * lock order of `lockActor`: the user row FOR SHARE, the user's `api_write` allowance, then `register` (registration only),
 * the event row, the actor's ticket rows, the ticket type's counter.
 *
 * Capacity never oversells. `ticket_type.issued` moves only by conditional updates inside these transactions:
 *  - register: `issued = issued + q where issued + q <= capacity` (the event row is held FOR SHARE, and every capacity
 *    edit and organiser cancel takes it FOR UPDATE, so a capacity can't drop under `issued` mid-registration);
 *  - cancel and void: `status = 'valid' and checked_in_at is null` on the ticket rows first, then `issued = issued - n`
 *    by the number of rows that update actually changed, so two racing cancels, or a cancel and a void, release a seat once;
 *  - the CHECK `0 <= issued <= capacity` backs both up.
 * A check-in (15.3) uses the same predicate on the ticket row, so a cancel racing a scan has exactly one winner.
 */

const E = schema.event;
const T = schema.ticketType;
const R = schema.registration;
const K = schema.ticket;

const TOO_MANY_REGISTRATIONS = "You've registered a lot this hour. Try again later.";

/**
 * A registration's tickets in a stable, readable order: the account holder's own first, then "Guest 2", "Guest 3", ...
 * (all of them are inserted by one statement and share `created_at`, so the label decides).
 */
export const registrationOrder = () => [
  asc(sql`(${K.guestLabel} is not null)`),
  asc(sql`char_length(${K.guestLabel})`),
  asc(K.guestLabel),
  asc(K.id),
];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type RegistrationView = Awaited<ReturnType<typeof readRegistration>>;

/** One of the actor's registrations with its tickets (no QR text and no door code: those are only on `GET /api/tickets/[id]`). */
async function readRegistration(tx: Tx, registrationId: string, userId: string) {
  const [reg] = await tx
    .select({
      id: R.id,
      eventId: R.eventId,
      ticketTypeId: R.ticketTypeId,
      ticketTypeName: T.name,
      quantity: R.quantity,
      status: R.status,
      createdAt: R.createdAt,
    })
    .from(R)
    .innerJoin(T, eq(T.id, R.ticketTypeId))
    .where(and(eq(R.id, registrationId), eq(R.userId, userId)));
  if (!reg) return null;
  const tickets = await tx
    .select({ id: K.id, holderName: K.holderName, guestLabel: K.guestLabel, status: K.status, checkedIn: sql<boolean>`${K.checkedInAt} is not null` })
    .from(K)
    .where(eq(K.registrationId, registrationId))
    .orderBy(...registrationOrder());
  return { registration: reg, tickets };
}

/**
 * Register for a free ticket: body `{ ticketTypeId, quantity, clientOpId }`. Idempotent through `op_ledger` (the op id
 * and a hash of the parsed request): a retry returns the same registration and tickets with `replayed: true`; the same
 * op id with a different request is 409 `op_id_reused`.
 *
 * Refusals (all charged one `api_write`): the event is missing, a draft or hidden (404, indistinguishable); cancelled
 * (409 `event_cancelled`); closed (409 `registration_closed`); a quantity over the event's `max_per_registration` (400);
 * a ticket type of another event (404); an active registration for this event already (409 `already_registered`);
 * not enough seats (409 `sold_out`, the message says how many are left). 10 registrations per user per hour (`register`, 429).
 */
export async function registerForEvent(actor: Actor | null, rawEventId: string, input: unknown) {
  assertCan(actor, "event:register");
  const out = await writeTx(actor, "event:register", async (tx) => {
    const eventId = idArg.parse(rawEventId);
    const data = registerInput.parse(input);
    const op = await withOp(
      tx,
      actor.id,
      { kind: "register", clientOpId: data.clientOpId, payload: `${eventId}\n${data.ticketTypeId}\n${data.quantity}` },
      async () => {
        await consumeRate(tx, actor.id, "register", TICKET_LIMITS.registersPerHour, TOO_MANY_REGISTRATIONS);
        const [ev] = await tx
          .select({
            id: E.id,
            status: E.status,
            hiddenAt: E.hiddenAt,
            maxPerRegistration: E.maxPerRegistration,
            closed: sql<boolean>`now() >= ${E.registrationClosesAt} or now() >= ${E.endsAt}`,
          })
          .from(E)
          .where(eq(E.id, eventId))
          .for("share");
        // A draft and a hidden event are not public: they look exactly like a missing one.
        if (!ev || ev.status === "draft" || ev.hiddenAt) throw new NotFoundError();
        if (ev.status === "cancelled") throw new CodedConflictError("event_cancelled", "This event was cancelled.");
        if (ev.closed) throw new CodedConflictError("registration_closed", "Registration for this event is closed.");
        if (data.quantity > ev.maxPerRegistration) {
          throw new BadRequestError(`You can register at most ${ev.maxPerRegistration} ticket${ev.maxPerRegistration === 1 ? "" : "s"} for this event.`);
        }

        const [dup] = await tx.select({ id: R.id }).from(R).where(and(eq(R.eventId, ev.id), eq(R.userId, actor.id), eq(R.status, "active")));
        if (dup) throw new CodedConflictError("already_registered", "You're already registered for this event. Cancel that registration to change it.");

        const [type] = await tx.select({ id: T.id }).from(T).where(and(eq(T.id, data.ticketTypeId), eq(T.eventId, ev.id)));
        if (!type) throw new NotFoundError();
        const bumped = await tx
          .update(T)
          .set({ issued: sql`${T.issued} + ${data.quantity}` })
          .where(and(eq(T.id, type.id), eq(T.eventId, ev.id), sql`${T.issued} + ${data.quantity} <= ${T.capacity}`))
          .returning({ issued: T.issued });
        if (bumped.length === 0) {
          const [cur] = await tx.select({ left: sql<number>`${T.capacity} - ${T.issued}` }).from(T).where(eq(T.id, type.id));
          const left = Math.max(0, cur?.left ?? 0);
          throw new CodedConflictError("sold_out", left === 0 ? "Sold out." : `Only ${left} seat${left === 1 ? "" : "s"} left for that ticket type.`);
        }

        let regId: string;
        try {
          const [row] = await tx
            .insert(R)
            .values({
              eventId: ev.id,
              ticketTypeId: type.id,
              userId: actor.id,
              quantity: data.quantity,
              clientOpId: data.clientOpId,
              payloadHash: sha(`${eventId}\n${data.ticketTypeId}\n${data.quantity}`),
            })
            .returning({ id: R.id });
          regId = row.id;
        } catch (err) {
          // The partial unique index (event, user) where active: the pre-check above makes this unreachable under the
          // user's own allowance lock, but the index is the last word.
          if (dbErrorCode(err) === "23505") throw new CodedConflictError("already_registered", "You're already registered for this event. Cancel that registration to change it.");
          throw err;
        }

        const [u] = await tx.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, actor.id));
        const base = (u?.name ?? "Guest").trim() || "Guest";
        const rows = Array.from({ length: data.quantity }, (_, i) => {
          const id = randomUUID();
          const { digest } = doorFor(id, 1);
          // The first ticket carries the account name; the rest "Jane Doe, guest 2" (the name is cut so the whole fits the 80-character column).
          const guest = i + 1;
          return {
            id,
            eventId: ev.id,
            ticketTypeId: type.id,
            registrationId: regId,
            holderUserId: actor.id,
            holderName: i === 0 ? base.slice(0, 80) : `${base.slice(0, 80 - `, guest ${guest}`.length)}, guest ${guest}`,
            guestLabel: i === 0 ? null : `Guest ${guest}`,
            source: "registration" as const,
            doorCodeDigest: digest,
          };
        });
        const made = await tx.insert(K).values(rows).onConflictDoNothing().returning({ id: K.id });
        // A door-code collision (50 bits per event) is astronomically unlikely; if one happens, the whole registration is retried.
        if (made.length !== rows.length) throw new CodedConflictError("retry", "That was busy. Try again.");
        return { registrationId: regId, eventId: ev.id, quantity: data.quantity };
      },
    );
    const view = await readRegistration(tx, op.result.registrationId, actor.id);
    // A replay after the event was deleted: the first answer is gone with it.
    if (!view) throw new CodedConflictError("registration_gone", "That registration no longer exists. Register again with a new request.");
    return { ...view, replayed: op.replayed, fresh: op.replayed ? null : { eventId: op.result.eventId, quantity: op.result.quantity } };
  });
  if (out.fresh) log.info("registration.created", { actorId: actor.id, eventId: out.fresh.eventId, quantity: out.fresh.quantity });
  return { registration: out.registration, tickets: out.tickets, replayed: out.replayed };
}

/**
 * Cancel the actor's own registration before the event starts: body `{ clientOpId }`. Every valid ticket of it is
 * cancelled by one conditional update and the type's `issued` drops by the rows that update changed. If any ticket is
 * already checked in: 409 `checked_in`, nothing changes. A registration that is already cancelled answers 200 with
 * `changed: false` (a second cancel, or a void that got there first, releases nothing twice). After the start: 409
 * `event_started`. Someone else's or a missing registration: 404. The same op id replays the first result.
 */
export async function cancelRegistration(actor: Actor | null, rawId: string, input: unknown) {
  assertCan(actor, "event:register");
  const out = await writeTx(actor, "event:register", async (tx) => {
    const regId = idArg.parse(rawId);
    const { clientOpId } = opInput.parse(input);
    return withOp(tx, actor.id, { kind: "registration-cancel", clientOpId, payload: regId }, async () => {
      const [reg] = await tx.select({ id: R.id, eventId: R.eventId, status: R.status }).from(R).where(and(eq(R.id, regId), eq(R.userId, actor.id)));
      if (!reg) throw new NotFoundError();
      // The event FOR SHARE: an organiser's edit, cancel or void (FOR UPDATE) and this cancel serialise.
      const [ev] = await tx
        .select({ id: E.id, started: sql<boolean>`now() >= ${E.startsAt}` })
        .from(E)
        .where(eq(E.id, reg.eventId))
        .for("share");
      if (!ev) throw new NotFoundError();
      // The ticket rows, in id order: a scan or a void racing this waits here and then re-reads the row.
      const rows = await tx
        .select({ id: K.id, status: K.status, checkedInAt: K.checkedInAt })
        .from(K)
        .where(eq(K.registrationId, reg.id))
        .orderBy(asc(K.id))
        .for("update");
      if (rows.some((r) => r.status === "valid" && r.checkedInAt)) {
        throw new CodedConflictError("checked_in", "A ticket in this registration is already checked in, so it can't be cancelled.");
      }
      const current = await tx.select({ status: R.status }).from(R).where(eq(R.id, reg.id));
      if (current[0]?.status !== "active" && !rows.some((r) => r.status === "valid")) {
        return { registrationId: reg.id, eventId: reg.eventId, changed: false, released: 0 };
      }
      if (ev.started) throw new CodedConflictError("event_started", "This event has started, so the registration can't be cancelled.");

      const cancelled = await tx
        .update(K)
        .set({ status: "cancelled" })
        .where(and(eq(K.registrationId, reg.id), eq(K.status, "valid"), sql`${K.checkedInAt} is null`))
        .returning({ id: K.id, ticketTypeId: K.ticketTypeId });
      await releaseSeats(tx, cancelled);
      const done = await tx
        .update(R)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(and(eq(R.id, reg.id), eq(R.status, "active")))
        .returning({ id: R.id });
      return { registrationId: reg.id, eventId: reg.eventId, changed: cancelled.length > 0 || done.length > 0, released: cancelled.length };
    });
  });
  if (!out.replayed && out.result.changed) log.info("registration.cancelled", { actorId: actor.id, eventId: out.result.eventId, released: out.result.released });
  return { registrationId: out.result.registrationId, cancelled: true, changed: out.result.changed, released: out.result.released, replayed: out.replayed };
}

/**
 * Give seats back: `issued = issued - n` per ticket type, where `n` is the number of rows the caller's conditional
 * update (`status = 'valid' and checked_in_at is null`) actually changed, never the number it asked for.
 */
export async function releaseSeats(tx: Tx, changed: { ticketTypeId: string }[]): Promise<void> {
  const perType = new Map<string, number>();
  for (const r of changed) perType.set(r.ticketTypeId, (perType.get(r.ticketTypeId) ?? 0) + 1);
  for (const [typeId, n] of [...perType].sort(([a], [b]) => (a < b ? -1 : 1))) {
    await tx.update(T).set({ issued: sql`${T.issued} - ${n}` }).where(eq(T.id, typeId));
  }
}
