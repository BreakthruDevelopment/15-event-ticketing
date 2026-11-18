import { requireRole } from "@/lib/auth/session";
import { listQuestions } from "@/lib/faq-ask";
import { NO_STORE, errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/organizer/events/:id/questions[?unanswered=1] : what attendees asked the FAQ bot in the last 30 days, newest first,
 * grouped by day in the event's time zone: `{ days: [{ day: "2026-11-15", questions: [{ question, status, mode, citations }] }],
 * unansweredCount, retentionDays }`. At most 200 questions. `unanswered=1` keeps `not_in_faq` and `off_topic`. The questions are
 * anonymous (no user, no time of day). Spends one read. 404 for another organiser's event.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole("organizer");
    const query = Object.fromEntries(new URL(request.url).searchParams);
    return Response.json(await listQuestions(user, (await ctx.params).id, query), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
