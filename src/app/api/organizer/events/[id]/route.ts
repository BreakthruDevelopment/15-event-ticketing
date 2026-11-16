import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { deleteEvent, getMyEvent, updateEvent } from "@/lib/events";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/organizer/events/:id : the organiser's own event with its ticket types. Another organiser's id is a 404. */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const user = await requireRole("organizer");
    return Response.json({ event: await getMyEvent(user, (await ctx.params).id) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/organizer/events/:id : body `{ version, status?: "published" | "cancelled", ...any editable fact }`.
 * A stale `version` is a 409 with the current event; publishing needs a ticket type.
 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    return Response.json({ event: await updateEvent(user, (await ctx.params).id, await readJson(request)) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/organizer/events/:id : a draft or cancelled event, with everything attached to it. */
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    return Response.json(await deleteEvent(user, (await ctx.params).id), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
