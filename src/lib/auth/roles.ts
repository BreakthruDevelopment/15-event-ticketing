import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { assertCan } from "@/lib/access";
import { type Actor, type Role, toRole } from "@/lib/auth/rbac";
import { schema } from "@/lib/db";
import { ConflictError, NotFoundError, VersionConflictError } from "@/lib/errors";
import { ORGANIZER_REVOKED, roleInput } from "@/lib/event-schema";
import { log } from "@/lib/log";
import { withOp } from "@/lib/op-ledger";
import { writeTx } from "@/lib/write-tx";

export type RoleChange = {
  userId: string;
  role: Role;
  /** The role the user had before this change (equal to `role` when nothing changed). */
  previous: Role;
  changed: boolean;
  hidden: number;
  unhidden: number;
};

/**
 * The only way a role changes (`POST /api/admin/roles`): Better Auth's own set-role, create-user, update-user and
 * remove-user are disabled, so nothing can skip the hide/unhide below.
 *
 * Body `{ userId, role: "user" | "organizer", from, clientOpId }`. All four are required.
 *  - `from` is the role the admin saw when they decided. It is applied only if the user still has that role;
 *    otherwise 409 `version_conflict` with `current: { userId, role }`, so a stale tab or a retry can't silently undo
 *    someone else's change.
 *  - `clientOpId` is a replay ledger (`op_ledger`, unique per admin). It is required because `from` alone can't stop
 *    a delayed retry of "grant" after a later "revoke" (the `from` check would pass again). An exact retry returns the
 *    first result with `replayed: true` and changes nothing, even after the role moved since; the same id with a
 *    different request is 409 `op_id_reused`. The ledger row and the result commit with the change, so a parallel duplicate waits for the first.
 *
 * Revoking `organizer` hides that organiser's `published` events that aren't already hidden
 * (`hidden_reason = 'organizer_revoked'`), so an admin's own hide and its reason are never overwritten. Granting
 * `organizer` again unhides only the events stamped `organizer_revoked`. The role write and the hide/unhide share one
 * transaction. Lock order (see `lockActor`): the admin's row FOR SHARE, the admin's write allowance, the target's row
 * FOR UPDATE (which also makes any organiser write in flight finish first, since they lock it FOR SHARE), then events.
 *
 * Admins' roles are not changed here (an admin is made out of band), and only `user` and `organizer` can be granted.
 */
export async function setUserRole(actor: Actor | null, input: unknown): Promise<RoleChange & { replayed: boolean }> {
  assertCan(actor, "admin:roles");
  const data = roleInput.parse(input);
  const out = await writeTx(actor, "admin:roles", (tx) =>
    withOp(tx, actor.id, { kind: "role", clientOpId: data.clientOpId, payload: `${data.userId}\n${data.role}\n${data.from}` }, async () => {
    // An admin's role never changes in this app, so a plain read can refuse an admin target without locking its row
    // (locking admins would let two admins deadlock on each other's rows).
    const [peek] = await tx.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, data.userId));
    if (!peek) throw new NotFoundError("User not found");
    if (toRole(peek.role) === "admin") throw new ConflictError("An admin's role can't be changed here.");
    const [target] = await tx.select({ id: schema.user.id, role: schema.user.role }).from(schema.user).where(eq(schema.user.id, data.userId)).for("update");
    if (!target) throw new NotFoundError("User not found");
    const previous = toRole(target.role);
    if (previous === "admin") throw new ConflictError("An admin's role can't be changed here.");
    // Compare-and-set: a request made against an older view must not silently undo a newer change.
    if (previous !== data.from) throw new VersionConflictError({ userId: target.id, role: previous });

    const result: RoleChange = { userId: target.id, role: data.role, previous, changed: false, hidden: 0, unhidden: 0 };
    if (previous !== data.role) {
      result.changed = true;
      await tx.update(schema.user).set({ role: data.role, updatedAt: new Date() }).where(eq(schema.user.id, target.id));
      const E = schema.event;
      if (data.role === "user") {
        const rows = await tx
          .update(E)
          .set({ hiddenAt: new Date(), hiddenReason: ORGANIZER_REVOKED })
          .where(and(eq(E.organizerId, target.id), eq(E.status, "published"), isNull(E.hiddenAt)))
          .returning({ id: E.id });
        result.hidden = rows.length;
      } else {
        const rows = await tx
          .update(E)
          .set({ hiddenAt: null, hiddenReason: null })
          .where(and(eq(E.organizerId, target.id), eq(E.hiddenReason, ORGANIZER_REVOKED)))
          .returning({ id: E.id });
        result.unhidden = rows.length;
      }
    }
    return result;
    }),
  );
  if (!out.replayed && out.result.changed) {
    log.info("role.changed", { actorId: actor.id, userId: out.result.userId, from: out.result.previous, to: out.result.role, hidden: out.result.hidden, unhidden: out.result.unhidden });
  }
  return { ...out.result, replayed: out.replayed };
}
