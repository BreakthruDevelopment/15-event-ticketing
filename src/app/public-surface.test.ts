import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A page or route that does not authenticate is a public surface, and public surfaces get the per-IP limit
 * (`allowPublicRequest`). The staff invite page became public by dropping its redirect, and nothing noticed it had
 * left the limit behind. This lists every unauthenticated page and route handler, so making another one public
 * fails here until it either calls `allowPublicRequest` or is added below with the reason it needs none.
 */
const NO_APP_LIMIT: Record<string, string> = {
  "api/auth/[...all]/route.ts": "Better Auth applies its own per-IP limits to sign-in and sign-up",
  "api/health/route.ts": "health check called by every cloud's probe; must not be refused",
  "door/scanner-selftest/page.tsx": "404s unless SCANNER_SELFTEST=1; never set in a deploy",
  "page.tsx": "static marketing page, no data",
  "sign-in/page.tsx": "static form, no data",
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

describe("public surfaces", () => {
  const root = path.resolve(__dirname);
  const surfaces = files(root).filter((f) => /(^|\/)(page\.tsx|route\.ts)$/.test(f));

  it("finds the app's pages and routes", () => {
    expect(surfaces.length).toBeGreaterThan(30);
  });

  it("every page or route that does not require a user has a per-IP limit or a written exemption", () => {
    const unlimited: string[] = [];
    for (const file of surfaces) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      const src = readFileSync(file, "utf8");
      const authenticated = /\brequire(User|Role)(OrRedirect)?\(/.test(src);
      if (authenticated || src.includes("allowPublicRequest(") || rel in NO_APP_LIMIT) continue;
      unlimited.push(rel);
    }
    expect(unlimited).toEqual([]);
  });

  it("keeps the exemption list honest: every entry still exists and still has no auth", () => {
    for (const rel of Object.keys(NO_APP_LIMIT)) {
      const src = readFileSync(path.join(root, rel), "utf8");
      expect(src, rel).not.toMatch(/\brequire(User|Role)(OrRedirect)?\(/);
    }
  });
});
