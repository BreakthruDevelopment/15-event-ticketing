import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { reissueTicketAsOrganizer } from "@/lib/tickets";

export const dynamic = "force-dynamic";

/** POST /api/organizer/events/:id/tickets/:ticketId/reissue : body `{ clientOpId }`. 200 `{ ticketId, qrEpoch, status, replayed }`, plus `qrText` and `doorCode` for a guest-list ticket only. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string; ticketId: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    const { id, ticketId } = await ctx.params;
    return Response.json(await reissueTicketAsOrganizer(user, id, ticketId, await readJson(request)), { headers: { ...NO_STORE, "Referrer-Policy": "no-referrer" } });
  } catch (err) {
    return errorResponse(err);
  }
}
