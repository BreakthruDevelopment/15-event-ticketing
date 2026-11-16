import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { voidTicket } from "@/lib/tickets";

export const dynamic = "force-dynamic";

/** POST /api/organizer/events/:id/tickets/:ticketId/void : body `{ clientOpId }`. 200 `{ ticketId, voided, registrationCancelled, replayed }`; 409 `ticket_not_voidable` when already cancelled or checked in. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string; ticketId: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    const { id, ticketId } = await ctx.params;
    return Response.json(await voidTicket(user, id, ticketId, await readJson(request)), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
