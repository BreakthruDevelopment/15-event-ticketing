"use client";

import { useEffect, useRef, useState } from "react";
import { VIDEO_ELEMENT_ATTRS } from "@/lib/scanner/camera";
import { createJsQrWorker, type WorkerLike } from "@/lib/scanner/frame-loop";
import {
  createScannerController,
  type ScannerController,
  type ScannerControllerOptions,
  type ScannerState,
} from "@/lib/scanner/use-scanner";

/** What a test asks the harness to build. Every field has a default, so `{}` is the happy path. */
export interface SelfTestScenario {
  /** `real`: the production worker. `drop-first`: real worker, first `dropCount` replies swallowed. `drop-all`: all swallowed. `throw`: createWorker throws. */
  worker?: "real" | "drop-first" | "drop-all" | "throw";
  dropCount?: number;
  /** `null-ctx`: the canvas hands back a null 2d context (iOS under memory pressure). */
  canvas?: "real" | "null-ctx";
  /** What the check-in callback does: succeed, throw on the first call only, or always throw. */
  onScan?: "ok" | "throw-first" | "throw-always";
  decodeTimeoutMs?: number;
  /** Pretend there is no native BarcodeDetector (iOS Safari), which is the only way to reach the worker. */
  forceJsQr?: boolean;
  /** Delay, in ms, added to each successive `getUserMedia` call: `[600, 0]` makes the second of two starts get its camera first. */
  gumDelays?: number[];
}

export interface SelfTestLog {
  scanAttempts: number[];
  scanTokens: string[];
  posts: number;
  replies: number;
  unhandled: string[];
  workerTerminated: boolean;
  startedAt: number;
  states: ScannerState[];
}

declare global {
  interface Window {
    __selfTest?: {
      streams: MediaStream[];
      log: SelfTestLog;
      workerRoundTrip(matrix: boolean[][], timeoutMs: number): Promise<{ ok: boolean; text: string | null; ms: number; errors: number }>;
      start(scenario: SelfTestScenario): Promise<{ started: boolean; ms: number }>;
      /** Two overlapping `start()` calls (a double-tap on "Start scanning"). */
      startTwice(scenario: SelfTestScenario): Promise<{ first: boolean; second: boolean }>;
      submitManual(input: string): Promise<unknown>;
      controller(): ScannerController | null;
      state(): ScannerState | null;
    };
  }
}

/** Draws a QR module matrix onto a 640x640 RGBA frame with a quiet zone: the same frame shape the frame loop sends. */
function frameFromMatrix(matrix: boolean[][], size = 640): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  const quiet = 4;
  const cell = Math.floor(size / (matrix.length + quiet * 2));
  const offset = Math.floor((size - cell * matrix.length) / 2);
  ctx.fillStyle = "#000";
  matrix.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) ctx.fillRect(offset + x * cell, offset + y * cell, cell, cell);
    }),
  );
  return ctx.getImageData(0, 0, size, size);
}

/** Wraps the real worker to count posts and terminate calls, and optionally swallow replies (the dropped-reply case). */
function wrapWorker(kind: "pass" | "drop-first" | "drop-all", dropCount: number, log: SelfTestLog): WorkerLike {
  const real = createJsQrWorker();
  let handler: WorkerLike["onmessage"] = null;
  let swallowed = 0;
  real.onmessage = (event) => {
    log.replies++;
    if (kind === "drop-all" || swallowed < dropCount) {
      swallowed++;
      return;
    }
    handler?.(event);
  };
  return {
    get onmessage() {
      return handler;
    },
    set onmessage(h) {
      handler = h;
    },
    get onerror() {
      return real.onerror ?? null;
    },
    set onerror(h) {
      real.onerror = h;
    },
    postMessage(message, transfer) {
      log.posts++;
      real.postMessage(message, transfer);
    },
    terminate() {
      log.workerTerminated = true;
      real.terminate?.();
    },
  };
}

export function ScannerSelfTest() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<ScannerState | null>(null);

  useEffect(() => {
    const log: SelfTestLog = {
      scanAttempts: [],
      scanTokens: [],
      posts: 0,
      replies: 0,
      unhandled: [],
      workerTerminated: false,
      startedAt: 0,
      states: [],
    };
    const streams: MediaStream[] = [];
    let controller: ScannerController | null = null;
    let unsubscribe: (() => void) | null = null;

    // Record every stream the page asks for, so a test can check each track ended.
    const md = navigator.mediaDevices;
    const realGetUserMedia = md?.getUserMedia?.bind(md);
    let gumCalls = 0;
    const gumDelays: { current: number[] } = { current: [] };
    if (md && realGetUserMedia) {
      md.getUserMedia = async (constraints) => {
        const delay = gumDelays.current[gumCalls++] ?? 0;
        const stream = await realGetUserMedia(constraints);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        streams.push(stream);
        return stream;
      };
    }

    const onRejection = (e: PromiseRejectionEvent) => {
      log.unhandled.push(String(e.reason));
    };
    window.addEventListener("unhandledrejection", onRejection);

    window.__selfTest = {
      streams,
      log,
      async workerRoundTrip(matrix, timeoutMs) {
        const worker = createJsQrWorker();
        const frame = frameFromMatrix(matrix);
        const t0 = performance.now();
        let errors = 0;
        const result = await new Promise<{ ok: boolean; text: string | null }>((resolve) => {
          const timer = setTimeout(() => resolve({ ok: false, text: null }), timeoutMs);
          worker.onerror = () => {
            errors++;
          };
          worker.onmessage = (event) => {
            clearTimeout(timer);
            const data = event.data as { text?: string | null };
            resolve({ ok: true, text: data?.text ?? null });
          };
          worker.postMessage({ id: 1, data: frame.data, width: frame.width, height: frame.height }, [frame.data.buffer]);
        });
        worker.terminate?.();
        return { ...result, ms: Math.round(performance.now() - t0), errors };
      },
      async startTwice(scenario) {
        gumCalls = 0;
        gumDelays.current = scenario.gumDelays ?? [];
        build(scenario);
        log.startedAt = performance.now();
        const first = controller!.start(videoRef.current);
        const second = controller!.start(videoRef.current);
        return { first: await first, second: await second };
      },
      async start(scenario) {
        gumCalls = 0;
        gumDelays.current = [];
        build(scenario);
        log.startedAt = performance.now();
        const started = await controller!.start(videoRef.current);
        return { started, ms: Math.round(performance.now() - log.startedAt) };
      },
      submitManual: (input) => controller!.submitManual(input),
      controller: () => controller,
      state: () => controller?.getState() ?? null,
    };

    function build(scenario: SelfTestScenario) {
        controller?.stop("manual");
        unsubscribe?.();
        let thrown = false;
        const options: ScannerControllerOptions = {
          onScan: async (qr) => {
            log.scanAttempts.push(Math.round(performance.now() - log.startedAt));
            log.scanTokens.push(qr);
            const mode = scenario.onScan ?? "ok";
            if (mode === "throw-always" || (mode === "throw-first" && !thrown)) {
              thrown = true;
              throw new Error("network down");
            }
          },
          resultDisplayMs: 1_500,
          decodeTimeoutMs: scenario.decodeTimeoutMs,
          // The `jsqr` path is only reachable when there is no native detector, as on iOS.
          detectorScope: scenario.forceJsQr === false ? undefined : {},
          createWorker:
            scenario.worker === "throw"
              ? () => {
                  throw new Error("worker constructor failed");
                }
              : () => wrapWorker(scenario.worker === "drop-first" || scenario.worker === "drop-all" ? scenario.worker : "pass", scenario.dropCount ?? 1, log),
          createCanvas:
            scenario.canvas === "null-ctx"
              ? () => ({ width: 0, height: 0, getContext: () => null })
              : undefined,
        };
        controller = createScannerController(options);
        unsubscribe = controller.subscribe((s) => {
          log.states.push(s);
          setState(s);
        });
    }

    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      unsubscribe?.();
      controller?.stop("unmount");
      delete window.__selfTest;
    };
  }, []);

  return (
    <main className="mx-auto max-w-md min-w-0 p-4">
      <h1 className="text-lg font-semibold">Scanner self-test</h1>
      <video
        ref={videoRef}
        {...VIDEO_ELEMENT_ATTRS}
        className="aspect-video w-full rounded bg-black"
        data-testid="video"
      />
      <p data-testid="status" className="mt-2 wrap-anywhere">
        {state?.status ?? "idle"}
      </p>
      {state?.cameraError ? (
        <div data-testid="camera-error" role="alert" className="mt-2 wrap-anywhere">
          <p>{state.cameraError.message}</p>
          <p className="text-sm">{state.cameraError.browserHint}</p>
        </div>
      ) : null}
      {state?.banner ? (
        <p data-testid="banner" data-tone={state.banner.tone} role="status" className="mt-2 wrap-anywhere">
          {state.banner.message}
        </p>
      ) : null}
      <pre data-testid="state-dump" className="mt-2 text-xs break-all whitespace-pre-wrap">
        {JSON.stringify(state)}
      </pre>
    </main>
  );
}
