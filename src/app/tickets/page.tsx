import type { Metadata } from "next";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { type Column, DataList, PageIntro, Panel, StatusBadge, type Status } from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { errorInfo } from "@/lib/http";
import { listMyTickets } from "@/lib/tickets";
import { formatEventWhen, splitTicketsByNow } from "./format";

export const metadata: Metadata = { title: "My tickets" };
export const dynamic = "force-dynamic";

type Row = Awaited<ReturnType<typeof listMyTickets>>["tickets"][number];

function ticketBadge(row: Row): { status: Status; label: string } {
  if (row.status === "cancelled") return { status: "blocked", label: "Cancelled" };
  if (row.checkedIn) return { status: "passed", label: "Checked in" };
  return { status: "live", label: "Valid" };
}

const columns: Column<Row>[] = [
  {
    key: "event",
    header: "Event",
    primary: true,
    cell: (row) => (
      <Link href={`/tickets/${row.id}`} className="inline-flex min-h-11 min-w-0 items-center font-semibold break-words [overflow-wrap:anywhere] hover:text-accent">
        {row.event.title}
      </Link>
    ),
  },
  {
    key: "when",
    header: "When",
    cell: (row) => <span className="break-words">{formatEventWhen(row.event.startsAt, row.event.endsAt, row.event.timeZone)}</span>,
  },
  {
    key: "holder",
    header: "Holder",
    cell: (row) => (
      <span className="break-words [overflow-wrap:anywhere]">
        {row.holderName}
        {row.guestLabel ? <span className="text-muted"> · {row.guestLabel}</span> : null}
      </span>
    ),
  },
  {
    key: "type",
    header: "Type",
    cell: (row) => <span className="break-words [overflow-wrap:anywhere]">{row.ticketTypeName}</span>,
  },
  {
    key: "status",
    header: "Status",
    cell: (row) => {
      const badge = ticketBadge(row);
      return (
        <span className="inline-flex flex-wrap justify-end gap-2">
          <StatusBadge status={badge.status} label={badge.label} />
          {row.event.status === "cancelled" && <StatusBadge status="blocked" label="Event cancelled" />}
        </span>
      );
    },
  },
  {
    key: "open",
    header: "Open",
    srOnlyHeader: true,
    hideLabel: true,
    cell: (row) => (
      <Link href={`/tickets/${row.id}`} className={`${buttonSecondary} w-full sm:w-auto`}>
        View ticket
      </Link>
    ),
  },
];

function TicketGroup({ title, rows, empty }: { title: string; rows: Row[]; empty: string }) {
  return (
    <Panel title={title} count={rows.length}>
      <DataList caption={title} rows={rows} rowKey={(row) => row.id} columns={columns} empty={empty} />
    </Panel>
  );
}

export default async function TicketsPage() {
  const user = await requireUserOrRedirect();
  let tickets: Row[];
  try {
    tickets = (await listMyTickets(user)).tickets;
  } catch (err) {
    unstable_rethrow(err);
    const info = errorInfo(err);
    return (
      <>
        <PageIntro section="Tickets" title="My tickets" description="Upcoming and past tickets for your account." />
        <p className="text-sm font-medium text-danger" role="alert">
          {info.status >= 500 ? "Your tickets couldn't be loaded. Try again in a minute." : info.body.error}
        </p>
      </>
    );
  }

  const { upcoming, past } = splitTicketsByNow(tickets);

  return (
    <>
      <PageIntro section="Tickets" title="My tickets" description="Upcoming and past tickets. They stay on this page: nothing is emailed." />
      {tickets.length === 0 ? (
        <Panel title="Your tickets">
          <div className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">You do not have any tickets yet.</div>
        </Panel>
      ) : (
        <>
          <TicketGroup title="Upcoming" rows={upcoming} empty="No upcoming tickets." />
          <TicketGroup title="Past" rows={past} empty="No past tickets." />
        </>
      )}
    </>
  );
}
