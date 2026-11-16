import { requireUser } from "@/lib/auth/session";
import { NO_STORE, errorResponse } from "@/lib/http";
import { listMyTickets } from "@/lib/tickets";

export const dynamic = "force-dynamic";

/** GET /api/tickets : the caller's own tickets (id, status, holder, type, event brief, registration). No QR text and no door code in the list. */
export async function GET() {
  try {
    return Response.json(await listMyTickets(await requireUser()), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
