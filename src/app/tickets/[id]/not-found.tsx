import Link from "next/link";
import { PageIntro } from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";

export default function TicketNotFound() {
  return (
    <>
      <PageIntro section="Tickets" title="Ticket not found" description="That ticket isn't yours, or it doesn't exist." />
      <Link href="/tickets" className={buttonSecondary}>
        My tickets
      </Link>
    </>
  );
}
