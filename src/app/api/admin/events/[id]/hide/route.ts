import { hideEvent } from "@/lib/admin";
import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/events/:id/hide : body `{ hidden: boolean, reason?: string }`. A reason is required to hide. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("admin");
    return Response.json(await hideEvent(user, (await ctx.params).id, await readJson(request)), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
