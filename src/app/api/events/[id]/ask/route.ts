import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { askFaq } from "@/lib/faq-ask";
import { NO_STORE, errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/events/:id/ask : the FAQ bot. Signed in (`user` or `organizer`; admin is 403). Body `{ question (1 to 300 chars),
 * clientOpId }`, the op id kept by `opFor` until the server answers. 200 with
 * `{ status: "answered" | "not_in_faq" | "off_topic", mode: "model" | "quoted" | "lookup" | "cached", answerMode, text,
 * citations: [{ id: "F3" | "E1".., kind: "faq" | "event", refNo, label }], demo, replayed }`. Render `text` as plain text; link a
 * `faq` citation to `#F<refNo>` and an `event` one to the details section; badge `quoted`, `lookup`, `cached` and `demo`.
 * A retry with the same `clientOpId` returns the first answer (`replayed: true`) and costs nothing. 409: `event_cancelled`,
 * `op_id_reused`, `retry` (the first request is still running: wait). 429: 10 asks per hour, 300 per event per day, the app's
 * daily cap; a cached answer and a refused request cost no ask. 404: missing, draft or hidden event. 502: the model failed.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return Response.json(await askFaq(user, (await ctx.params).id, await readJson(request)), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
