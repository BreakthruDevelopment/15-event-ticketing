import { getCurrentUser } from "@/lib/auth/session";
import { TooManyRequestsError } from "@/lib/errors";
import { readFaq } from "@/lib/faq";
import { NO_STORE, errorResponse } from "@/lib/http";
import { allowPublicRequest, clientIp } from "@/lib/ip-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/events/:id/faq : the FAQ of an event, in order.
 *  - Anyone (signed in or not) for a published or cancelled, not hidden event: `{ view: "public", entries: [{ refNo, question,
 *    answer }] }`; anchor each entry `#F<refNo>`. A draft, a hidden event and an unknown id are all 404. 60 per minute per IP.
 *  - The event's own organiser, for any status: `{ view: "owner", entries: [{ id, refNo, question, answer, position, version,
 *    updatedAt }], budget: { entries, maxEntries, chars, maxChars }, faqVersion, nextRefNo }` (`nextRefNo` null when none is left).
 *    Spends one of the organiser's 1,200 reads per hour.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!allowPublicRequest(clientIp(request))) throw new TooManyRequestsError();
    const user = await getCurrentUser();
    return Response.json(await readFaq(user, (await ctx.params).id), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
