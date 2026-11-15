import "server-only";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { assertCan } from "@/lib/access";
import { type Actor, toRole } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { ORGANIZER_REVOKED, hideInput, idParam } from "@/lib/event-schema";
import { log } from "@/lib/log";
import { withOp } from "@/lib/op-ledger";
import { dailyCount } from "@/lib/usage";
import { writeTx } from "@/lib/write-tx";

/** The FAQ bot's cap per event per day (spec "Rate limits and caps"); enforced by the FAQ route (15.5), shown here. */
export const FAQ_ASKS_PER_EVENT_PER_DAY = 300;

const startOfUtcDay = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/**
 * Counts only. No names, emails, titles, attendee lists, tickets or questions: admins see how the system is doing,
 * not what its users did.
 */
export async function adminStats(actor: Actor | null) {
  assertCan(actor, "admin:stats");
  const d = db();
  const E = schema.event;
  const byStatus = await d.select({ status: E.status, n: count() }).from(E).groupBy(E.status);
  const [{ hidden }] = await d.select({ hidden: count() }).from(E).where(sql`${E.hiddenAt} is not null`);
  const [{ issued }] = await d.select({ issued: count() }).from(schema.ticket).where(eq(schema.ticket.status, "valid"));
  const since = startOfUtcDay();
  const [{ checkins }] = await d
    .select({ checkins: count() })
    .from(schema.checkinEvent)
    .where(and(eq(schema.checkinEvent.outcome, "checked_in"), gte(schema.checkinEvent.at, since)));
  const [{ asks }] = await d.select({ asks: count() }).from(schema.faqAsk).where(gte(schema.faqAsk.createdAt, since));
  const roleRows = await d.select({ role: schema.user.role, n: count() }).from(schema.user).groupBy(schema.user.role);
  const users = { user: 0, organizer: 0, admin: 0 };
  for (const r of roleRows) users[toRole(r.role)] += r.n;
  const events = { draft: 0, published: 0, cancelled: 0 };
  for (const r of byStatus) events[r.status] = r.n;

  return {
    events: { byStatus: events, hidden },
    tickets: { issued },
    checkinsToday: checkins,
    faq: { asksToday: asks, modelCallsToday: await dailyCount("ai"), dailyCap: env().AI_DAILY_CAP, perEventDailyCap: FAQ_ASKS_PER_EVENT_PER_DAY },
    users,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Hide a published event with a reason (it leaves the list and its page 404s; check-in closes), or unhide it.
 * Hiding over an `organizer_revoked` hide replaces that reason with the admin's, so a later re-grant of `organizer`
 * does not unhide it; hiding an already admin-hidden event changes nothing. An event hidden because its organiser was
 * revoked can't be unhidden here: grant the role again. Unhiding is refused while the owner isn't an organiser.
 * Hiding doesn't change the event's `version`. `clientOpId` is required (`op_ledger`): a late retry of an unhide returns
 * the first result and doesn't clear a newer hide by another admin.
 *
 * Lock order (see `lockActor`): the admin's row FOR SHARE, the admin's allowance, the owner's row FOR SHARE (so an
 * unhide can't race a revoke: either the revoke committed first and we see `user`, or it waits for us and then hides
 * the event), then the event row FOR UPDATE.
 */
export async function hideEvent(actor: Actor | null, rawId: string, input: unknown) {
  assertCan(actor, "admin:hide");
  const id = idParam.parse(rawId);
  const data = hideInput.parse(input);
  const { hidden, reason } = data;
  const E = schema.event;
  const out = await writeTx(actor, "admin:hide", (tx) =>
    withOp(tx, actor.id, { kind: "hide", clientOpId: data.clientOpId, payload: `${id}\n${data.hidden}\n${data.reason ?? ""}` }, async () => {
    const [peek] = await tx.select({ organizerId: E.organizerId }).from(E).where(eq(E.id, id));
    if (!peek) throw new NotFoundError();
    const [owner] = await tx.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, peek.organizerId)).for("share");
    const [row] = await tx
      .select({ id: E.id, status: E.status, hiddenAt: E.hiddenAt, hiddenReason: E.hiddenReason })
      .from(E)
      .where(eq(E.id, id))
      .for("update");
    if (!row) throw new NotFoundError();
    if (hidden) {
      if (row.status !== "published") throw new ConflictError("Only a published event can be hidden.");
      if (row.hiddenAt && row.hiddenReason !== ORGANIZER_REVOKED) return { id, hidden: true, changed: false };
      await tx.update(E).set({ hiddenAt: row.hiddenAt ?? new Date(), hiddenReason: reason }).where(eq(E.id, id));
      return { id, hidden: true, changed: true };
    }
    if (!row.hiddenAt) return { id, hidden: false, changed: false };
    if (row.hiddenReason === ORGANIZER_REVOKED) throw new ConflictError("Hidden because the organiser's role was revoked. Grant the organizer role again to unhide it.");
    // Never expose an event whose owner is no longer an organiser.
    if (!owner || toRole(owner.role) !== "organizer") throw new ConflictError("This event's owner is no longer an organiser.");
    await tx.update(E).set({ hiddenAt: null, hiddenReason: null }).where(eq(E.id, id));
    return { id, hidden: false, changed: true };
    }),
  );
  const result = out.result;
  if (!out.replayed && result.changed) log.info(result.hidden ? "event.hidden" : "event.unhidden", { actorId: actor.id, eventId: id });
  return { ...result, replayed: out.replayed };
}

