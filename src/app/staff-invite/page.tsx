import type { Metadata } from "next";
import { PageIntro, Panel } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth/session";
import { AcceptInvite } from "./accept-invite";

export const metadata: Metadata = {
  title: "Staff invite",
  referrer: "no-referrer",
  description: "Accept a door-team invite. The invite code stays in the link after the #.",
};
export const dynamic = "force-dynamic";

export default async function StaffInvitePage() {
  // No redirect to /sign-in: sign-in and sign-up happen on this page so the URL fragment (the invite code) is never navigated away from.
  const user = await getCurrentUser();
  return (
    <>
      <PageIntro
        section="Door team"
        title="Staff invite"
        description="Invite links open this page. The code stays in your browser and is not part of the address the server sees."
      />
      <Panel title="Invite">
        <AcceptInvite signedIn={user !== null} />
      </Panel>
    </>
  );
}
