import { setUserRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/roles : body `{ userId, role: "user" | "organizer", from: <the role the admin saw>, clientOpId }` (all required)
 * -> `{ userId, role, previous, changed, hidden, unhidden, replayed }`. Applied only if the user's role still equals
 * `from`; otherwise 409 `{ error, code: "version_conflict", current: { userId, role } }`. An exact retry with the same
 * `clientOpId` returns the first result (`replayed: true`) and changes nothing. The only way a role changes; admin
 * accounts can't be changed (409). Revoking `organizer` hides that organiser's published events in the same transaction.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("admin");
    return Response.json(await setUserRole(user, await readJson(request)), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
