import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { createFaqEntry } from "@/lib/faq";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/organizer/events/:id/faq : body `{ question (1 to 200), answer (1 to 800), position?, clientOpId }`. 201 with
 * `{ entry, budget, faqVersion, nextRefNo, replayed: false }`; the same `clientOpId` again is 200 with `replayed: true`.
 * 409 codes: `faq_entry_limit` (40 entries), `faq_budget` (8,500 characters), `faq_refs_exhausted`, `event_cancelled`, `op_id_reused`.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("organizer");
    const out = await createFaqEntry(user, (await ctx.params).id, await readJson(request));
    return Response.json(out, { status: out.replayed ? 200 : 201, headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
