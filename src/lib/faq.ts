import "server-only";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { assertCan, publicEventPage } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { CodedConflictError, NotFoundError, VersionConflictError } from "@/lib/errors";
import { idParam } from "@/lib/event-schema";
import { lockOwnEvent } from "@/lib/events";
import { FAQ_LIMITS, deleteFaqEntryInput, entryChars, faqBudget, newFaqEntryInput, updateFaqEntryInput } from "@/lib/faq-schema";
import { withOp } from "@/lib/op-ledger";
import { idArg } from "@/lib/ticket-schema";
import { type Tx } from "@/lib/usage";
import { spendRead, writeTx } from "@/lib/write-tx";

/**
 * FAQ entries (spec "FAQ bot retrieval", 15.5). Every write runs in `writeTx` (user row, `api_write` allowance, then the
 * event row FOR UPDATE, then the entries), so the budget (40 entries, 8,500 characters) and `ref_no` allocation are exact
 * under concurrency: every FAQ write of an event serialises on its event row, and the counts are read after that lock.
 *
 *  - `ref_no` comes from `event.faq_next_ref`, which only ever increases: a deleted entry's `F<n>` is never reused
 *    (a stale citation can't silently point at a new entry), and the 9,999th is the last (409 `faq_refs_exhausted`).
 *  - Every write bumps `event.faq_version` in the same transaction, which is what the answer cache keys on.
 *  - Create, update and delete are idempotent through `op_ledger` (the op id plus a hash of the PARSED input): a retry
 *    returns the first result with `replayed: true` and changes nothing, even after the entry was edited or deleted since;
 *    the same op id for a different request is 409 `op_id_reused`.
 *  - Update and delete carry the entry's `version` (what the editor loaded): a stale one is 409 `version_conflict` with
 *    the current entry.
 *  - Input is parsed INSIDE the transaction, after the role and allowance locks, so a malformed body (400) costs one
 *    write attempt like every other refused write (see `writeTx`).
 *  - A cancelled event's FAQ is read-only (409 `event_cancelled`), as its ticket types are.
 */

const E = schema.event;
const F = schema.faqEntry;

export type FaqEntryView = { id: string; refNo: number; question: string; answer: string; position: number; version: number; updatedAt: string };
export type PublicFaqEntry = { refNo: number; question: string; answer: string };

const entryView = (r: typeof F.$inferSelect): FaqEntryView => ({
  id: r.id,
  refNo: r.refNo,
  question: r.question,
  answer: r.answer,
  position: r.position,
  version: r.version,
  updatedAt: r.updatedAt.toISOString(),
});

const order = [asc(F.position), asc(F.refNo)];

async function ownerState(reader: Pick<ReturnType<typeof db>, "select">, eventId: string) {
  const entries = await reader.select().from(F).where(eq(F.eventId, eventId)).orderBy(...order);
  const [ev] = await reader.select({ faqVersion: E.faqVersion, faqNextRef: E.faqNextRef }).from(E).where(eq(E.id, eventId));
  return {
    entries: entries.map(entryView),
    budget: faqBudget(entries),
    faqVersion: ev?.faqVersion ?? 0,
    // Informational for the editor: the next entry will be F<nextRefNo>, or null when none is left.
    nextRefNo: ev && ev.faqNextRef <= FAQ_LIMITS.maxRefNo ? ev.faqNextRef : null,
  };
}

export type OwnerFaq = Awaited<ReturnType<typeof ownerState>>;

/**
 * Is this event the actor's own, AND does the actor hold the `organizer` role in the database right now (not just in the
 * session)? Reads of an organiser's drafts and of the questions asked use this, so a revoked or banned organiser loses
 * them at once, as they lose the door.
 */
export async function ownsEventNow(actor: Actor, eventId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: E.id })
    .from(E)
    .innerJoin(schema.user, eq(schema.user.id, E.organizerId))
    .where(and(eq(E.id, eventId), eq(E.organizerId, actor.id), eq(schema.user.role, "organizer"), eq(schema.user.banned, false)));
  return !!row;
}

/**
 * GET /api/events/[id]/faq. One route, two views:
 *  - the event's own organiser (role `organizer`, `organizer_id` = actor) sees every entry with ids, versions and the
 *    budget, for an event in any status; this spends one `api_read` (1,200 per hour);
 *  - everyone else (signed in or not) sees the entries of a published or cancelled, not hidden event: `refNo`, question
 *    and answer only. A draft, a hidden event and a missing id are the same 404. The route applies the per-IP limit.
 */
export async function readFaq(actor: Actor | null, rawEventId: string): Promise<({ view: "owner" } & OwnerFaq) | { view: "public"; entries: PublicFaqEntry[] }> {
  const id = idParam.parse(rawEventId);
  if (actor && actor.role === "organizer") {
    if (await ownsEventNow(actor, id)) {
      assertCan(actor, "event:manage");
      await spendRead(actor);
      return { view: "owner", ...(await ownerState(db(), id)) };
    }
  }
  const [ev] = await db().select({ id: E.id }).from(E).where(and(eq(E.id, id), publicEventPage()));
  if (!ev) throw new NotFoundError();
  const rows = await db().select().from(F).where(eq(F.eventId, id)).orderBy(...order);
  return { view: "public", entries: rows.map((r) => ({ refNo: r.refNo, question: r.question, answer: r.answer })) };
}

const notCancelled = (status: string) => {
  if (status === "cancelled") throw new CodedConflictError("event_cancelled", "A cancelled event's FAQ can't be changed.");
};

async function bumpVersion(tx: Tx, eventId: string) {
  await tx.update(E).set({ faqVersion: sql`${E.faqVersion} + 1`, updatedAt: new Date() }).where(eq(E.id, eventId));
}

/**
 * POST /api/organizer/events/[id]/faq: body `{ question, answer, position?, clientOpId }`. 201 with
 * `{ entry, budget, faqVersion, nextRefNo, replayed }`; a retry with the same op id is 200 `replayed: true`.
 * Refused (each costs one write attempt): 409 `faq_entry_limit` (a 41st entry), 409 `faq_budget` (an entry that would
 * take the FAQ past 8,500 characters; the message says how many are left), 409 `faq_refs_exhausted`.
 */
export async function createFaqEntry(actor: Actor | null, rawEventId: string, input: unknown) {
  assertCan(actor, "event:manage");
  const out = await writeTx(actor, "event:manage", async (tx) => {
    const data = newFaqEntryInput.parse(input);
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    const op = await withOp(
      tx,
      actor.id,
      { kind: "faq-create", clientOpId: data.clientOpId, payload: JSON.stringify([ev.id, data.question, data.answer, data.position ?? null]) },
      async () => {
        notCancelled(ev.status);
        const rows = await tx.select({ refNo: F.refNo, question: F.question, answer: F.answer }).from(F).where(eq(F.eventId, ev.id));
        if (rows.length >= FAQ_LIMITS.maxEntries) {
          throw new CodedConflictError("faq_entry_limit", `An FAQ can have at most ${FAQ_LIMITS.maxEntries} entries.`);
        }
        // The counter moves only here, under the event lock; it never goes back, so a ref_no is never reused. A rolled-back
        // transaction (the budget check below) restores it, so refused creates don't burn numbers either.
        const [next] = await tx
          .update(E)
          .set({ faqNextRef: sql`${E.faqNextRef} + 1`, faqVersion: sql`${E.faqVersion} + 1`, updatedAt: new Date() })
          .where(and(eq(E.id, ev.id), lte(E.faqNextRef, FAQ_LIMITS.maxRefNo)))
          .returning({ refNo: sql<number>`${E.faqNextRef} - 1` });
        if (!next) throw new CodedConflictError("faq_refs_exhausted", "This event has used all its FAQ reference numbers.");
        const used = faqBudget(rows).chars;
        const cost = entryChars(next.refNo, data.question, data.answer);
        if (used + cost > FAQ_LIMITS.maxChars) {
          const left = Math.max(0, FAQ_LIMITS.maxChars - used);
          throw new CodedConflictError("faq_budget", `That entry is ${cost} characters and the FAQ has ${left} left (the limit is ${FAQ_LIMITS.maxChars}).`);
        }
        const [row] = await tx
          .insert(F)
          .values({ eventId: ev.id, refNo: next.refNo, question: data.question, answer: data.answer, position: data.position ?? rows.length })
          .returning();
        return { entry: entryView(row) };
      },
    );
    return { entry: op.result.entry, replayed: op.replayed, ...pick(await ownerState(tx, ev.id)) };
  });
  return out;
}

const pick = (s: OwnerFaq) => ({ budget: s.budget, faqVersion: s.faqVersion, nextRefNo: s.nextRefNo });

/**
 * PATCH /api/organizer/events/[id]/faq/[entryId]: body `{ question?, answer?, position?, version, clientOpId }`. A stale
 * `version` is 409 `version_conflict` with the current entry; a change that would pass the character budget is 409
 * `faq_budget`. A request that changes nothing (same values) is not a write: no version bump, `changed: false`.
 */
export async function updateFaqEntry(actor: Actor | null, rawEventId: string, rawEntryId: string, input: unknown) {
  assertCan(actor, "event:manage");
  return writeTx(actor, "event:manage", async (tx) => {
    const data = updateFaqEntryInput.parse(input);
    const entryId = idArg.parse(rawEntryId);
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    const op = await withOp(
      tx,
      actor.id,
      {
        kind: "faq-update",
        clientOpId: data.clientOpId,
        payload: JSON.stringify([ev.id, entryId, data.question ?? null, data.answer ?? null, data.position ?? null, data.version]),
      },
      async () => {
        notCancelled(ev.status);
        const rows = await tx.select().from(F).where(eq(F.eventId, ev.id));
        const cur = rows.find((r) => r.id === entryId);
        if (!cur) throw new NotFoundError();
        if (cur.version !== data.version) throw new VersionConflictError({ entry: entryView(cur) });
        const next = { question: data.question ?? cur.question, answer: data.answer ?? cur.answer, position: data.position ?? cur.position };
        if (next.question === cur.question && next.answer === cur.answer && next.position === cur.position) {
          return { entry: entryView(cur), changed: false };
        }
        const others = rows.filter((r) => r.id !== cur.id);
        const used = faqBudget(others).chars;
        const cost = entryChars(cur.refNo, next.question, next.answer);
        if (used + cost > FAQ_LIMITS.maxChars) {
          const left = Math.max(0, FAQ_LIMITS.maxChars - used);
          throw new CodedConflictError("faq_budget", `That entry is ${cost} characters and the FAQ has ${left} left for it (the limit is ${FAQ_LIMITS.maxChars}).`);
        }
        const [row] = await tx
          .update(F)
          .set({ ...next, version: sql`${F.version} + 1`, updatedAt: new Date() })
          .where(and(eq(F.id, cur.id), eq(F.eventId, ev.id)))
          .returning();
        await bumpVersion(tx, ev.id);
        return { entry: entryView(row), changed: true };
      },
    );
    return { entry: op.result.entry, changed: op.result.changed, replayed: op.replayed, ...pick(await ownerState(tx, ev.id)) };
  });
}

/**
 * DELETE /api/organizer/events/[id]/faq/[entryId]: body `{ version, clientOpId }`. The entry's `F<n>` is retired for good.
 * A stale version is 409; a missing or foreign entry is 404; a retry with the same op id answers `deleted: true` again.
 */
export async function deleteFaqEntry(actor: Actor | null, rawEventId: string, rawEntryId: string, input: unknown) {
  assertCan(actor, "event:manage");
  const out = await writeTx(actor, "event:manage", async (tx) => {
    const data = deleteFaqEntryInput.parse(input);
    const entryId = idArg.parse(rawEntryId);
    const ev = await lockOwnEvent(tx, actor, rawEventId);
    const op = await withOp(
      tx,
      actor.id,
      { kind: "faq-delete", clientOpId: data.clientOpId, payload: JSON.stringify([ev.id, entryId, data.version]) },
      async () => {
        notCancelled(ev.status);
        const [cur] = await tx.select().from(F).where(and(eq(F.id, entryId), eq(F.eventId, ev.id)));
        if (!cur) throw new NotFoundError();
        if (cur.version !== data.version) throw new VersionConflictError({ entry: entryView(cur) });
        await tx.delete(F).where(eq(F.id, cur.id));
        await bumpVersion(tx, ev.id);
        return { deleted: true as const };
      },
    );
    return { deleted: true as const, replayed: op.replayed, ...pick(await ownerState(tx, ev.id)) };
  });
  return out;
}
