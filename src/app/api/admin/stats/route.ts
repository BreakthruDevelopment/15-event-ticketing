import { adminStats } from "@/lib/admin";
import { requireRole } from "@/lib/auth/session";
import { NO_STORE, errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/stats : counts only (events by status, tickets issued, check-ins today, FAQ asks against caps, users by role). */
export async function GET() {
  try {
    const user = await requireRole("admin");
    return Response.json(await adminStats(user), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
