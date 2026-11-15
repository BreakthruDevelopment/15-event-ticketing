import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse } from "@/lib/http";
import { createInvite } from "@/lib/staff";

export const dynamic = "force-dynamic";

/** POST /api/organizer/events/:id/staff/invites : a single-use invite for 72 hours. Returns `{ id, expiresAt, link }`; the link is shown once. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    return Response.json(await createInvite(user, (await ctx.params).id), { status: 201, headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
