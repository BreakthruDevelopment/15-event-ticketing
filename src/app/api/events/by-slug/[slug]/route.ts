import { TooManyRequestsError } from "@/lib/errors";
import { getPublicEventBySlug } from "@/lib/events";
import { errorResponse } from "@/lib/http";
import { allowPublicRequest, clientIp } from "@/lib/ip-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/events/by-slug/:slug : one published (or cancelled, not hidden) event with its ticket types and seats left.
 * A static `by-slug` segment, so `/api/events/[id]/...` keeps a single dynamic name. Drafts, hidden events and unknown
 * slugs are all 404. Public; 60 requests per minute per IP.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    if (!allowPublicRequest(clientIp(request))) throw new TooManyRequestsError();
    return Response.json(await getPublicEventBySlug((await ctx.params).slug));
  } catch (err) {
    return errorResponse(err);
  }
}
