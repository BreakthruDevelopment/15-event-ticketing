import { beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_LIMIT_PER_MINUTE, resetPublicLimiter } from "@/lib/ip-limit";

const current = vi.hoisted(() => ({
  user: null as null | { id: string },
  ip: "198.51.100.1",
  lookups: 0,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": `203.0.113.250, ${current.ip}` }),
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: async () => {
    current.lookups += 1;
    return current.user;
  },
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

/** Every string in the rendered tree, to compare the limited screen across requests. */
function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const el = node as { props?: Record<string, unknown> };
  const own = Object.values(el.props ?? {}).filter((v): v is string => typeof v === "string");
  return [...own, ...[el.props?.children].flat().map(textOf)].join("|");
}

beforeEach(() => {
  resetPublicLimiter();
  current.user = null;
  current.ip = "198.51.100.1";
  current.lookups = 0;
});

describe("staff invite page", () => {
  it("renders in place for a signed-out visitor instead of redirecting, so the fragment survives", async () => {
    const tree = await StaffInvitePage();
    expect(signedInProp(tree)).toBe(false);
  });

  it("tells the client component a signed-in visitor is signed in", async () => {
    current.user = { id: "u1" };
    const tree = await StaffInvitePage();
    expect(signedInProp(tree)).toBe(true);
  });

  it("limits an unauthenticated burst per IP, shows a wait screen without the invite form, and skips the page-level session lookup", async () => {
    for (let i = 0; i < PUBLIC_LIMIT_PER_MINUTE; i++) expect(signedInProp(await StaffInvitePage())).toBe(false);
    const lookupsBefore = current.lookups;
    const limited = await StaffInvitePage();
    expect(signedInProp(limited)).toBeUndefined(); // no <AcceptInvite>, so no sign-in form
    expect(textOf(limited)).toContain("Wait about a minute");
    expect(current.lookups).toBe(lookupsBefore); // the page skips its own getCurrentUser(); the shared app shell still does its own lookup on every render
  });

  it("counts the last X-Forwarded-For entry (Cloud Run), so one client cannot dodge the limit by spoofing the first", async () => {
    for (let i = 0; i < PUBLIC_LIMIT_PER_MINUTE; i++) await StaffInvitePage();
    expect(signedInProp(await StaffInvitePage())).toBeUndefined();
    current.ip = "198.51.100.2"; // another client is unaffected
    expect(signedInProp(await StaffInvitePage())).toBe(false);
  });

  it("shows the same limited screen every time, and a signed-in visitor is limited too", async () => {
    for (let i = 0; i < PUBLIC_LIMIT_PER_MINUTE; i++) await StaffInvitePage();
    const first = textOf(await StaffInvitePage());
    current.user = { id: "u1" };
    const second = textOf(await StaffInvitePage());
    expect(second).toBe(first);
    expect(first).not.toMatch(/valid|token|used|expired/i);
  });
});
