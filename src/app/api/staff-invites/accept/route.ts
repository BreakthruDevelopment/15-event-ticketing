import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { acceptInvite } from "@/lib/staff";

export const dynamic = "force-dynamic";

/**
 * POST /api/staff-invites/accept : body `{ token }` (the token comes from the link's URL fragment). Makes the signed-in
 * user door staff for the invite's event. An unknown, used or expired token is the same 404.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return Response.json(await acceptInvite(user, await readJson(request)), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
