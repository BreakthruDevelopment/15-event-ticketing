import { TooManyRequestsError } from "@/lib/errors";
import { listPublicEvents } from "@/lib/events";
import { errorResponse } from "@/lib/http";
import { allowPublicRequest, clientIp } from "@/lib/ip-limit";

export const dynamic = "force-dynamic";

/** GET /api/events?limit=&past= : published, not hidden events (upcoming first). Public; 60 requests per minute per IP. */
export async function GET(request: Request) {
  try {
    if (!allowPublicRequest(clientIp(request))) throw new TooManyRequestsError();
    const params = new URL(request.url).searchParams;
    const query: Record<string, string> = {};
    for (const k of ["limit", "past"]) {
      const v = params.get(k);
      if (v !== null) query[k] = v;
    }
    return Response.json(await listPublicEvents(query));
  } catch (err) {
    return errorResponse(err);
  }
}
