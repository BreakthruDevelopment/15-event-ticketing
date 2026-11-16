"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { errorInfo } from "@/lib/http";
import { cancelRegistration } from "@/lib/registrations";
import { reissueMyTicket } from "@/lib/tickets";

export type TicketActionResult = { ok: true; message: string } | { ok: false; error: string };

/** Known failures become a sentence. A 500 is thrown so the client keeps its op id and can retry the same one. */
function answered(err: unknown): TicketActionResult {
  const info = errorInfo(err);
  if (info.status >= 500) throw new Error("request failed");
  return { ok: false, error: info.body.error };
}

export async function reissueTicketAction(ticketId: string, clientOpId: string): Promise<TicketActionResult> {
  try {
    const user = await requireUser();
    const out = await reissueMyTicket(user, ticketId, { clientOpId });
    revalidatePath(`/tickets/${out.ticket.id}`);
    revalidatePath("/tickets");
    return {
      ok: true,
      message: out.replayed
        ? "This ticket was already reissued. The QR code on the page is the current one."
        : "New QR code and door code are ready. The old ones no longer work.",
    };
  } catch (err) {
    return answered(err);
  }
}

export async function cancelRegistrationAction(registrationId: string, clientOpId: string): Promise<TicketActionResult> {
  try {
    const user = await requireUser();
    const out = await cancelRegistration(user, registrationId, { clientOpId });
    revalidatePath("/tickets");
    return {
      ok: true,
      message: out.changed ? "Registration cancelled." : "This registration was already cancelled.",
    };
  } catch (err) {
    return answered(err);
  }
}
