import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse } from "@/lib/http";
import { revokeInvite } from "@/lib/staff";

export const dynamic = "force-dynamic";

/** DELETE /api/organizer/events/:id/staff/invites/:inviteId : revoke an open invite. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string; inviteId: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    const { id, inviteId } = await ctx.params;
    return Response.json(await revokeInvite(user, id, inviteId), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
