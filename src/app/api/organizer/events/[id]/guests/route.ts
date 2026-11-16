import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { addGuests } from "@/lib/tickets";

export const dynamic = "force-dynamic";

/**
 * POST /api/organizer/events/:id/guests : body `{ ticketTypeId, guests: [{ name, label? }] (1 to 20), clientOpId }`.
 * Guest-list tickets, counted against capacity (500 a day per event). 201 `{ tickets: [{ id, holderName, guestLabel,
 * status, ticketTypeName, qrText, doorCode }], replayed }` (200 on a replay). The organiser hands the QR on.
 * 409 codes: `sold_out`, `guest_limit`, `not_open`, `event_cancelled`.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    const out = await addGuests(user, (await ctx.params).id, await readJson(request));
    return Response.json(out, { status: out.replayed ? 200 : 201, headers: { ...NO_STORE, "Referrer-Policy": "no-referrer" } });
  } catch (err) {
    return errorResponse(err);
  }
}
