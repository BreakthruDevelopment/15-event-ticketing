import "server-only";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@/lib/db";
import { CodedConflictError } from "@/lib/errors";
import type { Tx } from "@/lib/usage";

/**
 * Replay ledger for mutations that are not safe to repeat blindly: a retry after a lost response must return the first
 * result and change nothing, even when someone else changed the state in between (an unhide that succeeded, another
 * admin hid the event again, and the late retry of the first unhide must not clear the newer hide).
 *
 * `op_ledger` is unique per (actor, client op id). Call this inside `writeTx`, which already holds the actor's
 * allowance lock, so parallel duplicates run one at a time and the second sees the first's row and result. The row and
 * its result commit with the mutation; a mutation that throws rolls the row back, so the retry runs fresh.
 *  - Same op id, same `kind` and `payload`, stored result: returns it with `replayed: true`.
 *  - Same op id for a different request: 409 `op_id_reused`.
 * `payload` is anything that identifies the request (ids and the wanted state); only its hash is stored.
 * The result must be JSON (ids, flags, counts), since a replay returns it after a round trip through jsonb.
 */
export async function withOp<T extends Record<string, unknown>>(
  tx: Tx,
  actorId: string,
  op: { kind: string; clientOpId: string; payload: string },
  work: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const L = schema.opLedger;
  const hash = createHash("sha256").update(`${op.kind}\n${op.payload}`).digest("hex");
  const [mine] = await tx
    .insert(L)
    .values({ actorId, clientOpId: op.clientOpId, kind: op.kind, payloadHash: hash })
    .onConflictDoNothing()
    .returning({ id: L.clientOpId });
  if (!mine) {
    const [first] = await tx.select().from(L).where(and(eq(L.actorId, actorId), eq(L.clientOpId, op.clientOpId)));
    if (first && (first.kind !== op.kind || first.payloadHash !== hash)) {
      throw new CodedConflictError("op_id_reused", "That request id was already used for a different change.");
    }
    if (first?.result) return { result: first.result as unknown as T, replayed: true };
    throw new CodedConflictError("retry", "That change is still running. Try again.");
  }
  const result = await work();
  await tx.update(L).set({ result }).where(and(eq(L.actorId, actorId), eq(L.clientOpId, op.clientOpId)));
  return { result, replayed: false };
}
