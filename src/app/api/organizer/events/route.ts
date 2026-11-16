import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { createEvent, listMyEvents } from "@/lib/events";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/organizer/events : the organiser's own events (at most 20), newest first. */
export async function GET() {
  try {
    const user = await requireRole("organizer");
    return Response.json({ events: await listMyEvents(user) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/organizer/events : create a draft. Body `{ title, venueName, timeZone, startsAt, endsAt, clientOpId, slug?,
 * description?, address?, doorsAt?, registrationClosesAt?, checkinOpensAt?, maxPerRegistration?, contactEmail? }`.
 * 201 `{ event, created: true }`; a retry with the same `clientOpId` answers 200 with the first event and `created: false`.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    const { event, created } = await createEvent(user, await readJson(request));
    return Response.json({ event, created }, { status: created ? 201 : 200, headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
