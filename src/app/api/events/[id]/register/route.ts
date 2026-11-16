import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { registerForEvent } from "@/lib/registrations";

export const dynamic = "force-dynamic";

/**
 * POST /api/events/:id/register : body `{ ticketTypeId, quantity, clientOpId }`. Free tickets. 201 with
 * `{ registration, tickets, replayed: false }`; 200 with `replayed: true` when the same `clientOpId` is sent again
 * (same tickets, nothing new). The tickets carry ids, names and status, never the QR text (that is `GET /api/tickets/:id`).
 * 409 codes: `sold_out`, `already_registered`, `registration_closed`, `event_cancelled`, `op_id_reused`. 404 for a missing,
 * draft or hidden event.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const out = await registerForEvent(user, (await ctx.params).id, await readJson(request));
    return Response.json(out, { status: out.replayed ? 200 : 201, headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
