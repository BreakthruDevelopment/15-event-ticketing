import { requireUser } from "@/lib/auth/session";
import { NO_STORE, errorResponse } from "@/lib/http";
import { getMyTicket } from "@/lib/tickets";

export const dynamic = "force-dynamic";

/**
 * GET /api/tickets/:id : one ticket with `qrText` and `doorCode` (null once cancelled). 404 for anyone but the holder,
 * a missing id included. `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`: the QR text lives only here
 * and on the holder's own page.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const out = await getMyTicket(await requireUser(), (await ctx.params).id);
    return Response.json(out, { headers: { ...NO_STORE, "Referrer-Policy": "no-referrer" } });
  } catch (err) {
    return errorResponse(err);
  }
}
