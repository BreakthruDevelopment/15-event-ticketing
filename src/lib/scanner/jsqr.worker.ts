import { handleWorkerMessage } from "./jsqr-core";

/**
 * Web Worker entry for decoding QR codes with `jsqr` 1.4.0 when native `BarcodeDetector` (`qr_code`) is not
 * available (iOS Safari, so every iPhone).
 *
 * Loaded via `new Worker(new URL("./jsqr.worker.ts", import.meta.url))` so Next.js serves it from `'self'`,
 * complying with 15.2's `worker-src 'self'` CSP (no `blob:` or `unsafe-eval`).
 *
 * This file has NO exports and NO environment guard on purpose. Turbopack evaluates `typeof window` for the browser
 * target at build time (it is "object"), so the previous `typeof window === "undefined"` guard was compiled out and
 * the worker never attached a handler. The listener below is a plain top-level side effect: the file is only ever
 * evaluated as a worker entry. `e2e/scanner.e2e.test.ts` runs the production build in a real browser to prove it.
 */
self.addEventListener("message", (event: MessageEvent) => {
  self.postMessage(handleWorkerMessage(event.data));
});
