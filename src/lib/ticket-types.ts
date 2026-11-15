import "server-only";
import { and, count, eq, ne, sql } from "drizzle-orm";
import { assertCan } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { schema } from "@/lib/db";
import { CodedConflictError, NotFoundError, VersionConflictError } from "@/lib/errors";
import { LIMITS, idParam, newTicketTypeInput, updateTicketTypeInput } from "@/lib/event-schema";
import { lockOwnEvent } from "@/lib/events";
import { type Tx } from "@/lib/usage";
import { writeTx } from "@/lib/write-tx";

/**
 * Ticket types and capacity (organiser only). Every write locks, in the order of `lockActor`: user, allowance, the
 * event row FOR UPDATE, then the ticket type rows. Registration (15.2) locks the event FOR SHARE and then bumps
 * `issued`, so a capacity edit and a registration serialise on the event row and `issued <= capacity` always holds.
 *
 * Names are E4 in the FAQ bot's event block, so adding, deleting or renaming a type bumps `event.faq_version`
 * (capacity and position don't: the prompt carries no seat counts).
 */

const T = schema.ticketType;
const E = schema.event;

const serialize = (t: typeof T.$inferSelect) => ({
  id: t.id,
  name: t.name,
  capacity: t.capacity,
  issued: t.issued,
  seatsLeft: t.capacity - t.issued,
  position: t.position,
  version: t.version,
});

async function bumpFaq(tx: Tx, eventId: string) {
  await tx.update(E).set({ faqVersion: sql`${E.faqVersion} + 1`, updatedAt: new Date() }).where(eq(E.id, eventId));
}

async function otherCapacity(tx: Tx, eventId: string, exceptTypeId?: string): Promise<number> {
  const [{ total }] = await tx
    .select({ total: sql<number>`coalesce(sum(${T.capacity}), 0)::int` })
    .from(T)
    .where(exceptTypeId ? and(eq(T.eventId, eventId), ne(T.id, exceptTypeId)) : eq(T.eventId, eventId));
  return total;
}

const notCancelled = (status: string) => {
  if (status === "cancelled") throw new CodedConflictError("event_cancelled", "A cancelled event can't be changed.");
};

/** Add a ticket type: at most 5 per event, capacity at most 5,000 per type and 10,000 per event, names unique per event. */
export async function createTicketType(actor: Actor | null, rawEventId: string, input: unknown) {
  assertCan(actor, "event:manage");
  const data = newTicketTypeInput.parse(input);
  const row = await writeTx(actor, "event:manage", async (tx) => {
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    notCancelled(ev.status);
    const [{ n }] = await tx.select({ n: count() }).from(T).where(eq(T.eventId, ev.id));
    if (n >= LIMITS.typesPerEvent) throw new CodedConflictError("type_limit", `An event can have at most ${LIMITS.typesPerEvent} ticket types.`);
    if ((await otherCapacity(tx, ev.id)) + data.capacity > LIMITS.capacityPerEvent) {
      throw new CodedConflictError("capacity_limit", `An event can hold at most ${LIMITS.capacityPerEvent} tickets in total.`);
    }
    // The event row lock serialises every ticket type write of this event, so this check can't race another create.
    const [created] = await tx
      .insert(T)
      .values({ eventId: ev.id, name: data.name, capacity: data.capacity, position: data.position ?? n })
      .onConflictDoNothing({ target: [T.eventId, T.name] })
      .returning();
    if (!created) throw new CodedConflictError("name_taken", "This event already has a ticket type with that name.");
    await bumpFaq(tx, ev.id);
    return created;
  });
  return { ticketType: serialize(row) };
}

/** Rename, resize or move a ticket type. A stale `version` is 409; capacity below `issued` is 409 `capacity_below_issued`. */
export async function updateTicketType(actor: Actor | null, rawEventId: string, rawTypeId: string, input: unknown) {
  assertCan(actor, "event:manage");
  const data = updateTicketTypeInput.parse(input);
  const typeId = idParam.parse(rawTypeId);
  const row = await writeTx(actor, "event:manage", async (tx) => {
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    notCancelled(ev.status);
    const [cur] = await tx.select().from(T).where(and(eq(T.id, typeId), eq(T.eventId, ev.id))).for("update");
    if (!cur) throw new NotFoundError();
    if (cur.version !== data.version) throw new VersionConflictError({ ticketType: serialize(cur) });
    const name = data.name ?? cur.name;
    const capacity = data.capacity ?? cur.capacity;
    if (capacity < cur.issued) throw new CodedConflictError("capacity_below_issued", `${cur.issued} tickets are already issued: capacity can't go below that.`);
    if ((await otherCapacity(tx, ev.id, cur.id)) + capacity > LIMITS.capacityPerEvent) {
      throw new CodedConflictError("capacity_limit", `An event can hold at most ${LIMITS.capacityPerEvent} tickets in total.`);
    }
    if (name !== cur.name) {
      const [dup] = await tx.select({ id: T.id }).from(T).where(and(eq(T.eventId, ev.id), eq(T.name, name)));
      if (dup) throw new CodedConflictError("name_taken", "This event already has a ticket type with that name.");
    }
    const [updated] = await tx
      .update(T)
      .set({ name, capacity, position: data.position ?? cur.position, version: sql`${T.version} + 1`, updatedAt: new Date() })
      .where(eq(T.id, cur.id))
      .returning();
    if (name !== cur.name) await bumpFaq(tx, ev.id);
    return updated;
  });
  return { ticketType: serialize(row) };
}

/** Delete a ticket type that has issued nothing. The last type of a published event can't go (it would leave nothing to register for). */
export async function deleteTicketType(actor: Actor | null, rawEventId: string, rawTypeId: string): Promise<{ deleted: true }> {
  assertCan(actor, "event:manage");
  const typeId = idParam.parse(rawTypeId);
  await writeTx(actor, "event:manage", async (tx) => {
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    notCancelled(ev.status);
    const [cur] = await tx.select().from(T).where(and(eq(T.id, typeId), eq(T.eventId, ev.id))).for("update");
    if (!cur) throw new NotFoundError();
    if (cur.issued > 0) throw new CodedConflictError("has_tickets", "Tickets were already issued for this type. Void or cancel them first, or keep the type.");
    if (ev.status === "published") {
      const [{ n }] = await tx.select({ n: count() }).from(T).where(eq(T.eventId, ev.id));
      if (n <= 1) throw new CodedConflictError("last_ticket_type", "A published event needs at least one ticket type.");
    }
    await tx.delete(T).where(eq(T.id, cur.id));
    await bumpFaq(tx, ev.id);
  });
  return { deleted: true };
}
