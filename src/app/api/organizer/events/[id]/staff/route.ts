import { requireRole } from "@/lib/auth/session";
import { NO_STORE, errorResponse } from "@/lib/http";
import { listStaff } from "@/lib/staff";

export const dynamic = "force-dynamic";

/** GET /api/organizer/events/:id/staff : door staff (name, email) and open invites (never their tokens). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole("organizer");
    return Response.json(await listStaff(user, (await ctx.params).id), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
