import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { reissueMyTicket } from "@/lib/tickets";

export const dynamic = "force-dynamic";

/**
 * POST /api/tickets/:id/reissue : body `{ clientOpId }`. The holder gets a new QR and door code; the old ones answer
 * `invalid` at the door from then on. 200 `{ ticket (as GET /api/tickets/:id), replayed }`. 5 a day, 19 ever (409
 * `reissue_limit_day`, `reissue_limit`); 409 `ticket_cancelled`. 404 for anyone but the holder.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const out = await reissueMyTicket(user, (await ctx.params).id, await readJson(request));
    return Response.json(out, { headers: { ...NO_STORE, "Referrer-Policy": "no-referrer" } });
  } catch (err) {
    return errorResponse(err);
  }
}
