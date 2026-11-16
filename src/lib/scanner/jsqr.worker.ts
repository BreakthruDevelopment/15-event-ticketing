import jsQR from "jsqr";

/**
 * Web Worker entry for decoding QR codes with `jsqr` 1.4.0 when native
 * `BarcodeDetector` (`qr_code`) is not available (e.g. iOS Safari).
 *
 * Loaded via `new Worker(new URL("./jsqr.worker.ts", import.meta.url))` so Next.js
 * serves it from `'self'`, complying with 15.2's `worker-src 'self'` CSP (no `blob:`
 * or `unsafe-eval`).
 *
 * Accepts either:
 * - a transferred `Uint8ClampedArray` / `ArrayBuffer` directly (`postMessage(img.data, [img.data.buffer])`)
 *   for a square frame (e.g. 640 x 640), or
 * - `{ id?, data, width, height }` with `[img.data.buffer]` transferred.
 */

export interface JsQrWorkerRequest {
  id?: number;
  data: Uint8ClampedArray | ArrayBuffer;
  width?: number;
  height?: number;
}

export interface JsQrWorkerResponse {
  id?: number;
  text: string | null;
  data: string | null;
}

export interface WorkerMessageScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: (message: JsQrWorkerResponse) => void;
}

/**
 * Extracts `{ id, pixels, width, height }` from a worker message payload.
 */
export function unpackWorkerRequest(payload: unknown): {
  id?: number;
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
} | null {
  if (payload instanceof Uint8ClampedArray) {
    const side = Math.round(Math.sqrt(payload.length / 4));
    if (side <= 0 || side * side * 4 !== payload.length) return null;
    return { pixels: payload, width: side, height: side };
  }
  if (payload instanceof ArrayBuffer) {
    const pixels = new Uint8ClampedArray(payload);
    const side = Math.round(Math.sqrt(pixels.length / 4));
    if (side <= 0 || side * side * 4 !== pixels.length) return null;
    return { pixels, width: side, height: side };
  }
  if (typeof payload === "object" && payload !== null && "data" in payload) {
    const req = payload as JsQrWorkerRequest;
    let pixels: Uint8ClampedArray | null = null;
    if (req.data instanceof Uint8ClampedArray) {
      pixels = req.data;
    } else if (req.data instanceof ArrayBuffer) {
      pixels = new Uint8ClampedArray(req.data);
    }
    if (!pixels || pixels.length === 0) return null;
    const width = typeof req.width === "number" && req.width > 0 ? Math.floor(req.width) : Math.round(Math.sqrt(pixels.length / 4));
    const height = typeof req.height === "number" && req.height > 0 ? Math.floor(req.height) : width;
    if (width <= 0 || height <= 0 || width * height * 4 !== pixels.length) return null;
    return { id: req.id, pixels, width, height };
  }
  return null;
}

/**
 * Runs `jsQR` over RGBA pixel data and returns the decoded QR string or `null`.
 */
export function decodeFrameWithJsQr(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  if (width <= 0 || height <= 0 || pixels.length !== width * height * 4) {
    return null;
  }
  const code = jsQR(pixels, width, height, { inversionAttempts: "dontInvert" });
  return code ? code.data : null;
}

/**
 * Processes a single worker message payload and returns the response to post back.
 */
export function handleWorkerMessage(payload: unknown): JsQrWorkerResponse {
  const unpacked = unpackWorkerRequest(payload);
  if (!unpacked) {
    const id =
      typeof payload === "object" && payload !== null && "id" in payload && typeof (payload as { id?: unknown }).id === "number"
        ? (payload as { id: number }).id
        : undefined;
    return { id, text: null, data: null };
  }
  const decoded = decodeFrameWithJsQr(unpacked.pixels, unpacked.width, unpacked.height);
  return { id: unpacked.id, text: decoded, data: decoded };
}

/**
 * Binds the `jsqr` message handler to a Web Worker global scope or `MessagePort`.
 */
export function attachWorkerScope(scope: WorkerMessageScope): void {
  scope.onmessage = (event: { data: unknown }) => {
    const response = handleWorkerMessage(event.data);
    scope.postMessage(response);
  };
}

// Automatically attach when executed inside a dedicated Web Worker context.
if (
  typeof self !== "undefined" &&
  typeof (self as unknown as WorkerMessageScope).postMessage === "function" &&
  typeof window === "undefined"
) {
  attachWorkerScope(self as unknown as WorkerMessageScope);
}
