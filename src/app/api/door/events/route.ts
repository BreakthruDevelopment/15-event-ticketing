import { requireUser } from "@/lib/auth/session";
import { NO_STORE, errorResponse } from "@/lib/http";
import { listDoorEvents } from "@/lib/staff";

export const dynamic = "force-dynamic";

/** GET /api/door/events : events the signed-in user can open the door for (as organiser or invited staff), today and the next 7 days. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json(await listDoorEvents(user), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
