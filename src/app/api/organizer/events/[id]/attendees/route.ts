import { requireRole } from "@/lib/auth/session";
import { NO_STORE, errorResponse } from "@/lib/http";
import { listAttendees } from "@/lib/tickets";

export const dynamic = "force-dynamic";

/** GET /api/organizer/events/:id/attendees?page=1&status=valid|cancelled : 50 tickets a page (name, label, email, type, status, check-in time). Never a QR text or door code. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole("organizer");
    const query = Object.fromEntries(new URL(request.url).searchParams);
    return Response.json(await listAttendees(user, (await ctx.params).id, query), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
