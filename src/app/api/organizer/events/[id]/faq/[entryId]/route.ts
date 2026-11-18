import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { deleteFaqEntry, updateFaqEntry } from "@/lib/faq";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; entryId: string }> };

/**
 * PATCH /api/organizer/events/:id/faq/:entryId : body `{ question?, answer?, position?, version, clientOpId }`, `version` being the
 * entry's version the editor loaded. 200 with `{ entry, changed, budget, faqVersion, nextRefNo, replayed }`. 409 `version_conflict`
 * carries `current: { entry }`; also `faq_budget`, `event_cancelled`, `op_id_reused`. 404 for an unknown entry or event.
 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    const { id, entryId } = await ctx.params;
    return Response.json(await updateFaqEntry(user, id, entryId, await readJson(request)), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/organizer/events/:id/faq/:entryId : body `{ version, clientOpId }`. 200 with `{ deleted: true, budget, faqVersion,
 * nextRefNo, replayed }`. The entry's `F<n>` is never reused. A stale version is 409 `version_conflict`; a retry with the same
 * `clientOpId` answers `deleted: true` again.
 */
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    const { id, entryId } = await ctx.params;
    return Response.json(await deleteFaqEntry(user, id, entryId, await readJson(request)), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
