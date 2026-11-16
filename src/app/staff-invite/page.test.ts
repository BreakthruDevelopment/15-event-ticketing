import { describe, expect, it, vi } from "vitest";

const current = vi.hoisted(() => ({ user: null as null | { id: string } }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: async () => current.user,
  // The old page called this. It redirects, which is what dropped the URL fragment (the invite code).
  requireUserOrRedirect: async () => {
    throw new Error("NEXT_REDIRECT /sign-in");
  },
}));

import StaffInvitePage from "./page";

/** Find the `signedIn` prop that the page hands to <AcceptInvite>. */
function signedInProp(node: unknown): boolean | undefined {
  if (!node || typeof node !== "object") return undefined;
  const el = node as { props?: Record<string, unknown> };
  if (el.props && typeof el.props.signedIn === "boolean") return el.props.signedIn;
  for (const child of [el.props?.children].flat()) {
    const found = signedInProp(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe("staff invite page", () => {
  it("renders in place for a signed-out visitor instead of redirecting, so the fragment survives", async () => {
    current.user = null;
    const tree = await StaffInvitePage();
    expect(signedInProp(tree)).toBe(false);
  });

  it("tells the client component a signed-in visitor is signed in", async () => {
    current.user = { id: "u1" };
    const tree = await StaffInvitePage();
    expect(signedInProp(tree)).toBe(true);
  });
});
