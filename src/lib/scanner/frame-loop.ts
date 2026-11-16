import { createScanDedupe, DEDUPE_WINDOW_MS, type ScanDedupe } from "./dedupe";
import {
  type BarcodeDetectorLike,
  type BarcodeDetectorScope,
  createNativeQrDetector,
  type DecoderKind,
} from "./detect";
import type { JsQrWorkerResponse } from "./jsqr-core";
import { validateScannedQr } from "./manual";

/**
 * Main-thread frame loop for `/door/[eventId]`:
 * - Uses native `BarcodeDetector` when `qr_code` is supported.
 * - Otherwise draws video frames onto a 640x640 canvas on the main thread, reads pixels
 *   with `getImageData(0, 0, 640, 640)`, and transfers `img.data.buffer` to the `jsqr`
 *   Web Worker (`worker.postMessage(img.data, [img.data.buffer])`) at ~8 fps (125 ms).
 * - Rejects non-`ET1:` QR codes locally ("Not a ticket") before anything is sent.
 * - Ignores the same `ET1:` text within 3 seconds.
 */

export const SCAN_CANVAS_SIZE = 640;
export const SCAN_FPS = 8;
export const SCAN_INTERVAL_MS = Math.round(1000 / SCAN_FPS); // 125 ms
/** A worker that has not answered a frame within this long is treated as having dropped it. */
export const DECODE_TIMEOUT_MS = 1_000;
/** This many frames in a row with no answer (or a worker error) and the decoder is declared unavailable. */
export const MAX_CONSECUTIVE_DECODE_FAILURES = 3;

export type DecoderFailureReason =
  /** The `jsqr` worker could not be created. */
  | "worker_unavailable"
  /** The 2d canvas context was null (iOS Safari under memory pressure). */
  | "no_canvas"
  /** Several frames in a row got no reply from the worker. */
  | "worker_timeout"
  /** The worker kept raising `error` events. */
  | "worker_error";

/** Thrown by `startFrameLoop` when the decoder cannot be set up. The camera is already running by then. */
export class DecoderStartError extends Error {
  readonly reason: DecoderFailureReason;
  constructor(reason: DecoderFailureReason, options?: { cause?: unknown }) {
    super(`Decoder could not start: ${reason}`, options);
    this.name = "DecoderStartError";
    this.reason = reason;
  }
}

export interface WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate?: () => void;
}

export interface Canvas2DContextLike {
  drawImage(
    image: unknown,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number,
  ): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  };
}

export interface CanvasElementLike {
  width: number;
  height: number;
  getContext(contextId: "2d", options?: { willReadFrequently?: boolean }): Canvas2DContextLike | null;
}

export interface VideoSourceLike {
  readyState?: number;
  videoWidth?: number;
  videoHeight?: number;
}

export interface FrameDecodeHandlers {
  dedupe?: ScanDedupe;
  now?: () => number;
  onTicketQr: (qr: string) => void;
  onInvalidQr?: (rawValue: string, message: string) => void;
  onDuplicateQr?: (qr: string) => void;
}

export interface StartFrameLoopOptions extends FrameDecodeHandlers {
  video: VideoSourceLike;
  intervalMs?: number;
  canvasSize?: number;
  detectorScope?: BarcodeDetectorScope;
  nativeDetector?: BarcodeDetectorLike | null;
  createWorker?: () => WorkerLike;
  createCanvas?: (size: number) => CanvasElementLike;
  isPaused?: () => boolean;
  /** Per-frame reply deadline for the `jsqr` worker. Default `DECODE_TIMEOUT_MS`. */
  decodeTimeoutMs?: number;
  /** Consecutive failed frames before giving up. Default `MAX_CONSECUTIVE_DECODE_FAILURES`. */
  maxDecodeFailures?: number;
  /** Called once, after the loop has stopped itself because the decoder stopped working. */
  onDecoderFailed?: (reason: DecoderFailureReason) => void;
}

export interface FrameLoopHandle {
  readonly decoderKind: DecoderKind;
  /** Runs a single capture + decode cycle (also invoked automatically every ~125 ms). */
  step(): Promise<void>;
  stop(): void;
  isStopped(): boolean;
}

/**
 * Instantiates the `jsqr` Web Worker from a same-origin module URL (`worker-src 'self'`).
 */
export function createJsQrWorker(): WorkerLike {
  return new Worker(new URL("./jsqr.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}

function defaultCreateCanvas(size: number): CanvasElementLike {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas as unknown as CanvasElementLike;
}

/**
 * Transfers an `ImageData` pixel buffer to a `jsqr` worker using zero-copy transferable `ArrayBuffer`.
 */
export function transferImageDataToWorker(
  worker: WorkerLike,
  img: { data: Uint8ClampedArray; width: number; height: number },
  id?: number,
): void {
  if (id !== undefined) {
    // The id comes back in the reply, so a late answer to an abandoned frame can be told from the current one.
    worker.postMessage({ id, data: img.data, width: img.width, height: img.height }, [img.data.buffer]);
  } else if (img.width === img.height) {
    worker.postMessage(img.data, [img.data.buffer]);
  } else {
    worker.postMessage(
      { data: img.data, width: img.width, height: img.height },
      [img.data.buffer],
    );
  }
}

/**
 * Validates a raw decoded string against the strict `ET1:` format and the 3-second deduplicator.
 * Returns `"accepted"`, `"invalid"`, or `"duplicate"`.
 */
export function processDecodedRawText(
  rawValue: string,
  handlers: Required<Pick<FrameDecodeHandlers, "dedupe" | "now" | "onTicketQr">> &
    Pick<FrameDecodeHandlers, "onInvalidQr" | "onDuplicateQr">,
): "accepted" | "invalid" | "duplicate" {
  const check = validateScannedQr(rawValue);
  if (!check.ok) {
    handlers.onInvalidQr?.(rawValue, check.message);
    return "invalid";
  }
  const timestamp = handlers.now();
  if (!handlers.dedupe.shouldAccept(check.qr, timestamp)) {
    handlers.onDuplicateQr?.(check.qr);
    return "duplicate";
  }
  handlers.onTicketQr(check.qr);
  return "accepted";
}

/**
 * Starts the ~8 fps QR frame loop using native `BarcodeDetector` when `qr_code` is supported,
 * or the `jsqr` Web Worker with main-thread 640px canvas `getImageData` + buffer transfer otherwise.
 */
export async function startFrameLoop(
  options: StartFrameLoopOptions,
): Promise<FrameLoopHandle> {
  const now = options.now ?? (() => Date.now());
  const dedupe = options.dedupe ?? createScanDedupe(DEDUPE_WINDOW_MS, now);
  const intervalMs = options.intervalMs ?? SCAN_INTERVAL_MS;
  const canvasSize = options.canvasSize ?? SCAN_CANVAS_SIZE;

  const nativeDetector =
    options.nativeDetector !== undefined
      ? options.nativeDetector
      : await createNativeQrDetector(options.detectorScope);

  const decoderKind: DecoderKind = nativeDetector ? "native" : "jsqr";

  let worker: WorkerLike | null = null;
  let canvas: CanvasElementLike | null = null;
  let ctx: Canvas2DContextLike | null = null;
  let stopped = false;
  let inFlight = false;
  let pendingResolve: (() => void) | null = null;
  let decodeTimer: ReturnType<typeof setTimeout> | null = null;
  let currentFrameId = 0;
  let consecutiveFailures = 0;
  const decodeTimeoutMs = options.decodeTimeoutMs ?? DECODE_TIMEOUT_MS;
  const maxFailures = options.maxDecodeFailures ?? MAX_CONSECUTIVE_DECODE_FAILURES;

  const clearDecodeTimer = () => {
    if (decodeTimer !== null) {
      clearTimeout(decodeTimer);
      decodeTimer = null;
    }
  };

  /** Ends the in-flight frame (reply, error or timeout): clears the deadline and releases `step()`. */
  const settleFrame = () => {
    clearDecodeTimer();
    inFlight = false;
    const done = pendingResolve;
    pendingResolve = null;
    done?.();
  };

  /** One frame got no usable answer. Enough in a row and the loop stops itself and says why. */
  const frameFailed = (reason: DecoderFailureReason) => {
    if (stopped) return;
    settleFrame();
    consecutiveFailures++;
    if (consecutiveFailures >= maxFailures) {
      stop();
      options.onDecoderFailed?.(reason);
    }
  };

  const handleDecoded = (text: string | null | undefined) => {
    if (stopped || !text) return;
    if (options.isPaused?.()) return;
    processDecodedRawText(text, {
      dedupe,
      now,
      onTicketQr: options.onTicketQr,
      onInvalidQr: options.onInvalidQr,
      onDuplicateQr: options.onDuplicateQr,
    });
  };

  if (!nativeDetector) {
    try {
      const makeWorker = options.createWorker ?? createJsQrWorker;
      worker = makeWorker();
      const makeCanvas = options.createCanvas ?? defaultCreateCanvas;
      canvas = makeCanvas(canvasSize);
      ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new DecoderStartError("no_canvas");
    } catch (err) {
      // Nothing is running yet except the worker, if it got that far; the caller owns the camera.
      try {
        worker?.terminate?.();
      } catch {
        // already gone
      }
      worker = null;
      throw err instanceof DecoderStartError ? err : new DecoderStartError("worker_unavailable", { cause: err });
    }

    worker.onmessage = (event: { data: unknown }) => {
      const payload = event?.data as JsQrWorkerResponse | string | null | undefined;
      const replyId = payload && typeof payload === "object" ? payload.id : undefined;
      // A reply of any age proves the worker is alive.
      consecutiveFailures = 0;
      // An answer to a frame we already gave up on is still a valid decode, but it must not release the current one.
      const stale = typeof replyId === "number" && replyId !== currentFrameId;
      if (!stale) settleFrame();
      const decoded =
        typeof payload === "string"
          ? payload
          : payload && typeof payload === "object"
            ? (payload.text ?? payload.data ?? null)
            : null;
      handleDecoded(decoded);
    };

    worker.onerror = () => {
      frameFailed("worker_error");
    };
  }

  async function step(): Promise<void> {
    if (stopped || inFlight || options.isPaused?.()) return;
    // Wait until the <video> has enough data when readyState is present (HAVE_CURRENT_DATA = 2).
    if (typeof options.video.readyState === "number" && options.video.readyState < 2) {
      return;
    }

    if (nativeDetector) {
      inFlight = true;
      try {
        const codes = await nativeDetector.detect(options.video);
        if (!stopped && Array.isArray(codes) && codes.length > 0) {
          const first = codes.find((c) => typeof c?.rawValue === "string" && c.rawValue.length > 0);
          if (first) {
            handleDecoded(first.rawValue);
          }
        }
      } catch {
        // Ignore transient frame detection errors.
      } finally {
        inFlight = false;
      }
      return;
    }

    if (!worker || !ctx) return;
    inFlight = true;
    try {
      ctx.drawImage(options.video, 0, 0, canvasSize, canvasSize);
      const img = ctx.getImageData(0, 0, canvasSize, canvasSize);
      const frameId = ++currentFrameId;
      await new Promise<void>((resolve) => {
        pendingResolve = resolve;
        // If the worker never answers, this releases the loop instead of wedging it for good.
        decodeTimer = setTimeout(() => {
          decodeTimer = null;
          frameFailed("worker_timeout");
        }, decodeTimeoutMs);
        transferImageDataToWorker(worker!, img, frameId);
      });
    } catch {
      // A thrown draw/read/post is a failed frame like any other.
      frameFailed("worker_error");
    }
  }

  const timer = setInterval(() => {
    void step();
  }, intervalMs);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    settleFrame();
    if (worker) {
      worker.onmessage = null;
      worker.terminate?.();
      worker = null;
    }
  }

  return {
    decoderKind,
    step,
    stop,
    isStopped() {
      return stopped;
    },
  };
}
