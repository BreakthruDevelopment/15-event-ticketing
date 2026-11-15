import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { createTicketType } from "@/lib/ticket-types";

export const dynamic = "force-dynamic";

/** POST /api/organizer/events/:id/ticket-types : body `{ name, capacity, position? }`. At most 5 types, 5,000 per type, 10,000 per event. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    return Response.json(await createTicketType(user, (await ctx.params).id, await readJson(request)), { status: 201, headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
