import type { Metadata } from "next";
import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { PageIntro } from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { errorInfo } from "@/lib/http";
import { qrSvg } from "@/lib/tickets/qr";
import { getMyTicket } from "@/lib/tickets";
import { formatEventWhen, formatWhere, hasEventStarted } from "../format";
import { type TicketModel } from "./model";
import { TICKET_PRINT_CSS } from "./print-css";
import { TicketScreen } from "./ticket-screen";

export const metadata: Metadata = { title: "Ticket", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default async function TicketPage({ params }: PageProps<"/tickets/[id]">) {
  const user = await requireUserOrRedirect();
  const { id } = await params;
  let model: TicketModel;
  try {
    const ticket = await getMyTicket(user, id);
    const svg = ticket.qrText ? qrSvg(ticket.qrText) : null;
    model = {
      id: ticket.id,
      status: ticket.status,
      holderName: ticket.holderName,
      guestLabel: ticket.guestLabel,
      ticketTypeName: ticket.ticketTypeName,
      checkedIn: ticket.checkedInAt !== null,
      doorCode: ticket.doorCode,
      svg,
      registrationId: ticket.registrationId,
      registrationActive: ticket.registrationStatus === "active",
      eventStarted: hasEventStarted(ticket.event.startsAt),
      eventTitle: ticket.event.title,
      eventStatus: ticket.event.status,
      when: formatEventWhen(ticket.event.startsAt, ticket.event.endsAt, ticket.event.timeZone),
      where: formatWhere(ticket.event.venueName, ticket.event.address),
    };
  } catch (err) {
    unstable_rethrow(err);
    const info = errorInfo(err);
    if (info.status === 404 || info.status === 400) notFound();
    return (
      <>
        <PageIntro section="Tickets" title="Ticket" description="This ticket couldn't be opened." />
        <p className="text-sm font-medium text-danger" role="alert">
          {info.status >= 500 ? "Your ticket couldn't be loaded. Try again in a minute." : info.body.error}
        </p>
      </>
    );
  }

  return (
    <>
      <style>{TICKET_PRINT_CSS}</style>
      <p className="no-print mb-4">
        <Link href="/tickets" className={buttonSecondary}>
          My tickets
        </Link>
      </p>
      <TicketScreen model={model} />
    </>
  );
}
