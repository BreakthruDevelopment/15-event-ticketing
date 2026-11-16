import type { Metadata } from "next";
import { headers } from "next/headers";
import { PageIntro, Panel } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth/session";
import { allowPublicRequest, clientIpFromHeaders } from "@/lib/ip-limit";
import { AcceptInvite } from "./accept-invite";

export const metadata: Metadata = {
  title: "Staff invite",
  referrer: "no-referrer",
  description: "Accept a door-team invite. The invite code stays in the link after the #.",
};
export const dynamic = "force-dynamic";

export default async function StaffInvitePage() {
  // This page is public: a signed-out visitor signs in or up here so the URL fragment (the invite code) is never
  // navigated away from. Public means the per-IP limit applies. The check comes first and never looks at the token
  // (the server never sees it), so the limited screen is identical for every invite, valid or not.
  if (!allowPublicRequest(clientIpFromHeaders(await headers()))) {
    return (
      <>
        <PageIntro section="Door team" title="Staff invite" description="Too many requests from your network just now." />
        <Panel title="Please wait a minute">
          <p className="text-sm" role="status">
            Wait about a minute, then reload this page and try again.
          </p>
        </Panel>
      </>
    );
  }
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
