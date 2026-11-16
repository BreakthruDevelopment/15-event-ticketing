import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCsp, config, proxy } from "./proxy";

const csp = (res: Response) => res.headers.get("content-security-policy")!;
const nonceOf = (header: string) => /'nonce-([^']+)'/.exec(header)![1];

describe("proxy CSP for /tickets/* and /door/*", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("production: the spec's policy, a nonce, no unsafe-eval", () => {
    vi.stubEnv("NODE_ENV", "production");
    const header = csp(proxy(new NextRequest("http://localhost/tickets/abc")));
    const n = nonceOf(header);
    expect(n.length).toBeGreaterThan(20);
    expect(header).toBe(
      `default-src 'self'; script-src 'self' 'nonce-${n}' 'strict-dynamic'; worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
    expect(header).not.toContain("unsafe-eval");
  });

  it("development adds unsafe-eval to script-src and nothing else changes", () => {
    vi.stubEnv("NODE_ENV", "development");
    const header = csp(proxy(new NextRequest("http://localhost/door/abc")));
    expect(header).toMatch(/script-src [^;]*'unsafe-eval'/);
    expect(header.replace(" 'unsafe-eval'", "")).toBe(buildCsp(nonceOf(header), false));
  });

  it("a fresh nonce on every request, handed to the renderer on the request headers too", () => {
    vi.stubEnv("NODE_ENV", "production");
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const res = proxy(new NextRequest("http://localhost/door/x"));
      seen.add(nonceOf(csp(res)));
      // NextResponse.next({ request: { headers } }) forwards overridden request headers as x-middleware-request-*.
      expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(csp(res));
      expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonceOf(csp(res)));
    }
    expect(seen.size).toBe(20);
  });

  it("sends no-referrer, and never lets a caller-supplied nonce through", () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = proxy(new NextRequest("http://localhost/tickets/abc", { headers: { "x-nonce": "attacker", "content-security-policy": "default-src *" } }));
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(csp(res)).not.toContain("attacker");
    expect(csp(res)).not.toContain("default-src *");
  });

  it("matches /tickets, /tickets/*, /door and /door/* and nothing else, never prefetches", () => {
    const sources = config.matcher.map((m) => m.source);
    const matches = (path: string) => sources.some((s) => new RegExp(`^${s.replace("/:path*", "(?:/.*)?")}$`).test(path));
    for (const p of ["/tickets", "/tickets/abc", "/door", "/door/abc/x"]) expect(matches(p), p).toBe(true);
    for (const p of ["/", "/events", "/e/x", "/api/tickets", "/ticketsx", "/doorway", "/organizer"]) expect(matches(p), p).toBe(false);
    for (const m of config.matcher) expect(m.missing.map((h) => h.key)).toContain("next-router-prefetch");
  });
});
