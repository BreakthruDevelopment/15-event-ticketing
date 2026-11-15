import "server-only";
import { type Capability, lockActor, rolesFor } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { LIMITS, TOO_MANY_READS, TOO_MANY_WRITES } from "@/lib/event-schema";
import { type Tx, consumeRate } from "@/lib/usage";

/**
 * Run a mutation in one short transaction, with the lock order every write in this app follows (see `lockActor`):
 * the acting user's row FOR SHARE (current role and ban re-read from the database), then the actor's `api_write`
 * allowance (300 per hour, 429 over it), then whatever rows `work` locks. EVERY write spends one attempt, admin writes
 * and staff-invite accepts included; a failed mutation rolls the attempt back with everything else, so a refused
 * request costs nothing.
 */
export function writeTx<T>(actor: Actor, capability: Capability, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await lockActor(tx, actor, rolesFor(capability));
    await consumeRate(tx, actor.id, "api_write", LIMITS.writesPerHour, TOO_MANY_WRITES);
    return work(tx);
  });
}

/**
 * Spend one of the actor's signed-in read allowance (`api_read`, 1200 per hour, 429 over it) before an organiser or
 * admin read touches the database. Its own short transaction: reads take no other locks.
 */
export function spendRead(actor: Actor): Promise<void> {
  return db().transaction((tx) => consumeRate(tx, actor.id, "api_read", LIMITS.readsPerHour, TOO_MANY_READS));
}
