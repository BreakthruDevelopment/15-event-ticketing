import "server-only";
import { ZodError } from "zod";
import { type Capability, lockActor, rolesFor } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { LIMITS, TOO_MANY_READS, TOO_MANY_WRITES } from "@/lib/event-schema";
import { type Tx, consumeRate } from "@/lib/usage";

/**
 * Run a mutation in one short transaction, with the lock order every write in this app follows (see `lockActor`):
 * the acting user's row FOR SHARE (current role and ban re-read from the database), then the actor's `api_write`
 * allowance (300 per hour, 429 over it), then whatever rows `work` locks. EVERY write spends one attempt, admin writes
 * and staff-invite accepts included.
 *
 * A request the rules refuse (400, 404, 409, 422: a stale version, a foreign id, a bad invite token) still costs one
 * attempt: the main transaction rolls back, and after it has closed (no locks held, so the lock order is unchanged) the
 * attempt is spent in its own short transaction and the error is rethrown. If that spend is over the limit the answer is
 * 429 instead. So probing ids or tokens, or reading through a conflict's body, can't be done without limit. Refusals
 * for authorisation (401/403) and for rate (429) are not charged again, and a server fault (500) is not the caller's.
 *
 * A malformed body or id is a refusal too: `work` parses its input (zod) AFTER the actor's role is re-read and the
 * allowance lock is held, so a `ZodError` (400) is charged like any other 400, while a caller who isn't allowed to
 * write at all (401/403) never gets that far.
 */
export async function writeTx<T>(actor: Actor, capability: Capability, work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db().transaction(async (tx) => {
      await lockActor(tx, actor, rolesFor(capability));
      await consumeRate(tx, actor.id, "api_write", LIMITS.writesPerHour, TOO_MANY_WRITES);
      return work(tx);
    });
  } catch (err) {
    if ((err instanceof HttpError && CHARGED_REFUSALS.has(err.status)) || err instanceof ZodError) {
      await db().transaction((tx) => consumeRate(tx, actor.id, "api_write", LIMITS.writesPerHour, TOO_MANY_WRITES));
    }
    throw err;
  }
}

const CHARGED_REFUSALS = new Set([400, 404, 409, 422]);

/**
 * Spend one of the actor's signed-in read allowance (`api_read`, 1200 per hour, 429 over it) before an organiser or
 * admin read touches the database. Its own short transaction: reads take no other locks.
 */
export function spendRead(actor: Actor): Promise<void> {
  return db().transaction((tx) => consumeRate(tx, actor.id, "api_read", LIMITS.readsPerHour, TOO_MANY_READS));
}
