import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { createInvite } from "@/lib/staff";

export const dynamic = "force-dynamic";

/**
 * POST /api/organizer/events/:id/staff/invites : body `{ clientOpId }`. A single-use invite for 72 hours. Returns
 * `{ id, expiresAt, link, replayed }`: 201 for a new invite, 200 with the same link when the same `clientOpId` is sent
 * again. A retry after the invite was used, revoked or expired is 409 `invite_closed`.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    const out = await createInvite(user, (await ctx.params).id, await readJson(request));
    return Response.json(out, { status: out.replayed ? 200 : 201, headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
