import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";
import { deleteTicketType, updateTicketType } from "@/lib/ticket-types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; typeId: string }> };

/** PATCH /api/organizer/events/:id/ticket-types/:typeId : body `{ version, name?, capacity?, position? }`. Capacity can't go below `issued`. */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    const { id, typeId } = await ctx.params;
    return Response.json(await updateTicketType(user, id, typeId, await readJson(request)), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/organizer/events/:id/ticket-types/:typeId : only while `issued = 0`. */
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    const { id, typeId } = await ctx.params;
    return Response.json(await deleteTicketType(user, id, typeId), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
