import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { cancelRegistration } from "@/lib/registrations";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/registrations/:id : body `{ clientOpId }`. Cancels the caller's own registration before the event starts.
 * 200 `{ registrationId, cancelled: true, changed, released, replayed }` (`changed: false` when it was already cancelled).
 * 409 `checked_in` when a ticket was already scanned, `event_started` after the start. 404 for anyone else's.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return Response.json(await cancelRegistration(user, (await ctx.params).id, await readJson(request)), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
