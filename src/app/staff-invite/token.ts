/**
 * The invite token lives in the URL fragment (`/staff-invite#t=<token>`). A fragment is never sent to the server,
 * so request logs and referrers cannot see it. A path or a query string is ignored on purpose.
 */

export type FragmentToken = { status: "missing" } | { status: "invalid" } | { status: "ok"; token: string };

/** Read `t` from a fragment (`#t=...`). Anything that is not a fragment is missing, including `?t=` and a path. */
export function tokenFromHash(hash: string): FragmentToken {
  if (!hash.startsWith("#")) return { status: "missing" };
  const params = new URLSearchParams(hash.slice(1));
  if (!params.has("t")) return { status: "missing" };
  const token = params.get("t") ?? "";
  if (token.length < 1 || token.length > 200 || token.includes("\0")) return { status: "invalid" };
  return { status: "ok", token };
}

/** The same URL with the fragment removed, so the token leaves the address bar. */
export function hrefWithoutHash(href: string): string {
  const url = new URL(href, "http://local.invalid");
  return `${url.pathname}${url.search}`;
}
