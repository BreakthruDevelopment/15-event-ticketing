import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { removeStaff } from "@/lib/staff";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/organizer/events/:id/staff/:userId : body `{ clientOpId }`. Removes a door staffer; their next door request
 * is a 404. A retry with the same `clientOpId` returns the first result (`replayed: true`) and removes nothing more.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string; userId: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    const { id, userId } = await ctx.params;
    return Response.json(await removeStaff(user, id, userId, await readJson(request)), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
