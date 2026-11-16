import { notFound } from "next/navigation";
import { ScannerSelfTest } from "./self-test";

// Read the env var per request: a build-time value would freeze the answer into the prerendered page.
export const dynamic = "force-dynamic";

/**
 * Browser harness for the scanner module (`e2e/scanner.e2e.test.ts`). It renders the real `createScannerController`,
 * the real `jsqr` Web Worker and a `<video>` in a real browser. It answers 404 unless `SCANNER_SELFTEST=1` is set on
 * the server, so a normal deploy never exposes it. It sits under `/door/*` so it runs under the same
 * `Permissions-Policy: camera=(self)` and CSP as the door page will.
 */
export default function ScannerSelfTestPage() {
  if (process.env.SCANNER_SELFTEST !== "1") notFound();
  return <ScannerSelfTest />;
}
