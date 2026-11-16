import { type NextRequest, NextResponse } from "next/server";

/**
 * Content Security Policy for the two pages that show or scan tickets: `/tickets/*` (the holder's QR) and `/door/*`
 * (the scanner). Next 16 calls middleware "proxy". A fresh nonce per request goes into the policy; Next reads it from
 * the request's `Content-Security-Policy` header and stamps it on its own scripts, so those pages are rendered
 * dynamically (they read the session anyway). `'strict-dynamic'` lets those scripts load their chunks.
 *
 * Production is strict. `next dev` needs `'unsafe-eval'` (React rebuilds server stacks with eval), so it is added to
 * `script-src` only when `NODE_ENV !== "production"`; a test checks the production header has none.
 * `worker-src 'self'` and `connect-src 'self'` are what the scanner worker (15.4) and the PNG export (15.8) run under:
 * no remote script, worker, request or frame. `Referrer-Policy: no-referrer` keeps ticket URLs out of other sites' logs.
 */
export function buildCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "worker-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, process.env.NODE_ENV !== "production");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const config = {
  matcher: [
    {
      source: "/(tickets|door)/:path*",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
    {
      source: "/(tickets|door)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
