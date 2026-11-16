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

/**
 * The invite this page holds, given the one it held and the fragment it sees now. A fragment with no `t` at all
 * (`#main` from the shell's "Skip to content" link, an in-page anchor) means the user moved within the page, not that
 * the invite was withdrawn, so the held invite stays. A fragment that does carry `t` is a new invite link, valid or
 * not, and replaces it. Returns `held` itself when nothing changed so callers can compare by identity.
 */
export function keepToken(held: FragmentToken, seen: FragmentToken): FragmentToken {
  if (seen.status === "missing") return held;
  if (held.status === "ok" && seen.status === "ok" && held.token === seen.token) return held;
  if (held.status === "invalid" && seen.status === "invalid") return held;
  return seen;
}

/**
 * Accept, then clear the fragment, and only on success: a failed accept (rejected or thrown) leaves the token in the
 * address bar so a transient error can be retried.
 */
export async function acceptThenClear<R extends { ok: boolean }>(accept: () => Promise<R>, clearFragment: () => void): Promise<R> {
  const result = await accept();
  if (result.ok) clearFragment();
  return result;
}
