import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { beforeAll, describe, expect, it, vi } from "vitest";
import nextConfig from "../../../next.config";
import { buildCsp } from "../../proxy";
import { qrSvg } from "../tickets/qr";
import {
  CAMERA_CONSTRAINTS,
  describeCameraError,
  startCamera,
  supportsTrackTorch,
} from "./camera";
import { createScanDedupe, DEDUPE_WINDOW_MS } from "./dedupe";
import {
  chooseDecoderKind,
  createNativeQrDetector,
  supportsNativeQrDetector,
} from "./detect";
import {
  createJsQrWorker,
  SCAN_CANVAS_SIZE,
  startFrameLoop,
  transferImageDataToWorker,
  type WorkerLike,
} from "./frame-loop";
import { attachWorkerScope, type WorkerMessageScope } from "./jsqr.worker";
import {
  formatDoorCode,
  isTicketQrText,
  normalizeDoorCode,
  parseManualEntry,
  validateScannedQr,
} from "./manual";
import { createScannerController } from "./use-scanner";

/**
 * Rasterises an inline SVG returned by 15.2's `qrSvg(text)` into a square RGBA
 * `ImageData`-compatible pixel buffer (`Uint8ClampedArray`) of `targetSize x targetSize`.
 * Parses the SVG `<svg viewBox="0 0 W H">` and `<path d="M...h...v1h-...z"/>` runs directly.
 */
function rasteriseQrSvg(
  svg: string,
  targetSize: number = SCAN_CANVAS_SIZE,
): { data: Uint8ClampedArray; width: number; height: number } {
  const vbMatch = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!vbMatch) throw new Error("missing viewBox in qrSvg output");
  const gridW = Number(vbMatch[1]);
  const gridH = Number(vbMatch[2]);

  const dark = Array.from({ length: gridH }, () => new Uint8Array(gridW));
  const runRegex = /M(\d+) (\d+)h(\d+)v1h-\d+z/g;
  for (const match of svg.matchAll(runRegex)) {
    const x0 = Number(match[1]);
    const y0 = Number(match[2]);
    const w = Number(match[3]);
    for (let dx = 0; dx < w; dx++) {
      if (y0 >= 0 && y0 < gridH && x0 + dx >= 0 && x0 + dx < gridW) {
        dark[y0][x0 + dx] = 1;
      }
    }
  }

  const data = new Uint8ClampedArray(targetSize * targetSize * 4);
  for (let py = 0; py < targetSize; py++) {
    const gy = Math.min(gridH - 1, Math.floor((py * gridH) / targetSize));
    const row = dark[gy];
    for (let px = 0; px < targetSize; px++) {
      const gx = Math.min(gridW - 1, Math.floor((px * gridW) / targetSize));
      const color = row[gx] ? 0 : 255;
      const idx = (py * targetSize + px) * 4;
      data[idx] = color;
      data[idx + 1] = color;
      data[idx + 2] = color;
      data[idx + 3] = 255;
    }
  }

  return { data, width: targetSize, height: targetSize };
}

/**
 * Wraps a Node `MessageChannel` as a browser-compatible `WorkerLike` backed by `attachWorkerScope`.
 * Transferring `[img.data.buffer]` across `port1.postMessage` genuinely detaches the sender's `ArrayBuffer`.
 */
function createMessageChannelWorker(): { worker: WorkerLike; cleanup: () => void } {
  const { port1, port2 } = new MessageChannel();

  const workerScope: WorkerMessageScope = {
    onmessage: null,
    postMessage(msg) {
      port2.postMessage(msg);
    },
  };
  attachWorkerScope(workerScope);
  port2.on("message", (data) => {
    workerScope.onmessage?.({ data });
  });

  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown, transfer?: Transferable[]) {
      port1.postMessage(message, transfer as unknown as import("node:worker_threads").TransferListItem[]);
    },
    terminate() {
      port1.close();
      port2.close();
    },
  };

  port1.on("message", (data) => {
    worker.onmessage?.({ data });
  });

  return {
    worker,
    cleanup: () => {
      port1.close();
      port2.close();
    },
  };
}

describe("phone-browser QR scanner module (15.4)", () => {
  let TokenMod: typeof import("../tickets/token");
  const TICKET_ID_A = "0b9d5a52-3f0e-4c5c-8a7e-2f6f3d9c1e44";
  const TICKET_ID_B = "91e08a24-7b8c-44d3-9f1a-6c5d4e3f2a10";
  let qrTextA: string;
  let qrTextB: string;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "s".repeat(48);
    process.env.DATABASE_URL ??= "postgres://unused@localhost/unused";
    TokenMod = await import("../tickets/token");
    qrTextA = TokenMod.signTicket(TICKET_ID_A, 1);
    qrTextB = TokenMod.signTicket(TICKET_ID_B, 2);
  });

  describe("detect.ts: BarcodeDetector feature check", () => {
    it("chooses the native path ONLY when BarcodeDetector.getSupportedFormats() includes qr_code", async () => {
      // 1. Missing BarcodeDetector (e.g. iOS Safari)
      expect(await supportsNativeQrDetector({})).toBe(false);
      expect(await chooseDecoderKind({})).toBe("jsqr");
      expect(await createNativeQrDetector({})).toBeNull();

      // 2. BarcodeDetector without getSupportedFormats
      class NoFormatsDetector {
        async detect() {
          return [];
        }
      }
      expect(await supportsNativeQrDetector({ BarcodeDetector: NoFormatsDetector })).toBe(false);
      expect(await chooseDecoderKind({ BarcodeDetector: NoFormatsDetector })).toBe("jsqr");

      // 3. BarcodeDetector where getSupportedFormats() omits qr_code
      class NonQrDetector {
        static async getSupportedFormats() {
          return ["ean_13", "code_128", "pdf417"];
        }
        async detect() {
          return [];
        }
      }
      expect(await supportsNativeQrDetector({ BarcodeDetector: NonQrDetector })).toBe(false);
      expect(await chooseDecoderKind({ BarcodeDetector: NonQrDetector })).toBe("jsqr");
      expect(await createNativeQrDetector({ BarcodeDetector: NonQrDetector })).toBeNull();

      // 4. BarcodeDetector where getSupportedFormats() rejects
      class ThrowingDetector {
        static async getSupportedFormats(): Promise<string[]> {
          throw new Error("not implemented");
        }
        async detect() {
          return [];
        }
      }
      expect(await supportsNativeQrDetector({ BarcodeDetector: ThrowingDetector })).toBe(false);
      expect(await chooseDecoderKind({ BarcodeDetector: ThrowingDetector })).toBe("jsqr");

      // 5. BarcodeDetector with qr_code supported -> chooses native path and passes { formats: ["qr_code"] }
      const ctorFormats: string[][] = [];
      class MockQrBarcodeDetector {
        static async getSupportedFormats() {
          return ["ean_13", "qr_code"];
        }
        constructor(opts?: { formats?: string[] }) {
          if (opts?.formats) ctorFormats.push(opts.formats);
        }
        async detect() {
          return [{ rawValue: qrTextA, format: "qr_code" }];
        }
      }
      expect(await supportsNativeQrDetector({ BarcodeDetector: MockQrBarcodeDetector })).toBe(true);
      expect(await chooseDecoderKind({ BarcodeDetector: MockQrBarcodeDetector })).toBe("native");
      const detector = await createNativeQrDetector({ BarcodeDetector: MockQrBarcodeDetector });
      expect(detector).not.toBeNull();
      expect(ctorFormats).toEqual([["qr_code"]]);
    });
  });

  describe("jsqr.worker.ts & frame-loop.ts: rasterised 15.2 qrSvg decoding from a transferred ImageData buffer", () => {
    it("decodes a QR rendered by 15.2's qrSvg from a transferred ImageData ArrayBuffer over MessageChannel", async () => {
      const svg = qrSvg(qrTextA);
      const img = rasteriseQrSvg(svg, SCAN_CANVAS_SIZE);
      expect(img.data.byteLength).toBe(SCAN_CANVAS_SIZE * SCAN_CANVAS_SIZE * 4);

      const { worker, cleanup } = createMessageChannelWorker();
      try {
        const decodedPromise = new Promise<string | null>((resolvePromise) => {
          worker.onmessage = (event) => {
            const res = event.data as { text: string | null };
            resolvePromise(res.text);
          };
        });

        transferImageDataToWorker(worker, img);

        // The underlying ArrayBuffer must be detached on the sender thread after transfer.
        expect(img.data.buffer.byteLength).toBe(0);

        const decoded = await decodedPromise;
        expect(decoded).toBe(qrTextA);
        expect(TokenMod.verifyTicketToken(decoded)).toEqual({
          ticketId: TICKET_ID_A,
          epoch: 1,
        });
      } finally {
        cleanup();
      }
    });

    it("also decodes when sent as { data, width, height } with transferred buffer at 370x370", async () => {
      const svg = qrSvg(qrTextB);
      const img = rasteriseQrSvg(svg, 370);
      const { worker, cleanup } = createMessageChannelWorker();
      try {
        const decodedPromise = new Promise<{ id?: number; text: string | null }>((resolvePromise) => {
          worker.onmessage = (event) => {
            resolvePromise(event.data as { id?: number; text: string | null });
          };
        });

        worker.postMessage(
          { id: 42, data: img.data, width: img.width, height: img.height },
          [img.data.buffer],
        );
        expect(img.data.buffer.byteLength).toBe(0);

        const response = await decodedPromise;
        expect(response.id).toBe(42);
        expect(response.text).toBe(qrTextB);
      } finally {
        cleanup();
      }
    });

    it("loads and runs under 15.2's production CSP (worker-src 'self', no unsafe-eval, no blob:)", () => {
      const csp = buildCsp("test-nonce-12345", false);
      expect(csp).toContain("worker-src 'self'");
      expect(csp).not.toContain("unsafe-eval");
      expect(csp).not.toMatch(/worker-src[^;]*blob:/);

      // Verify createJsQrWorker uses a same-origin module URL (never blob: or data:)
      const captured: { url: string; options?: WorkerOptions }[] = [];
      const OriginalWorker = globalThis.Worker;
      class SpyWorker {
        onmessage = null;
        constructor(scriptURL: string | URL, options?: WorkerOptions) {
          captured.push({ url: String(scriptURL), options });
        }
        postMessage() {}
        terminate() {}
      }
      globalThis.Worker = SpyWorker as unknown as typeof Worker;
      try {
        createJsQrWorker();
        expect(captured).toHaveLength(1);
        expect(captured[0].url).toContain("jsqr.worker.ts");
        expect(captured[0].url.startsWith("blob:")).toBe(false);
        expect(captured[0].url.startsWith("data:")).toBe(false);
        expect(captured[0].options).toEqual({ type: "module" });
      } finally {
        globalThis.Worker = OriginalWorker;
      }

      // Verify neither jsqr.worker.ts nor jsqr's bundle contains eval / Function / remote fetches
      const workerSource = readFileSync(resolve(__dirname, "jsqr.worker.ts"), "utf8");
      const jsqrBundle = readFileSync(
        resolve(__dirname, "../../../node_modules/jsqr/dist/jsQR.js"),
        "utf8",
      );
      for (const src of [workerSource, jsqrBundle]) {
        expect(src).not.toMatch(/\beval\s*\(/);
        expect(src).not.toMatch(/\bnew\s+Function\s*\(/);
        expect(src).not.toMatch(/\bimportScripts\s*\(/);
      }
    });
  });

  describe("manual.ts & local rejection of non-ET1 codes", () => {
    it("rejects non-ET1 QR codes locally with 'Not a ticket' and never forwards them to onTicketQr", async () => {
      for (const nonTicket of [
        "https://example.com/tickets/123",
        "WIFI:S:VenueWiFi;T:WPA;P:secret;;",
        "ET2:" + qrTextA.slice(4),
        qrTextA.toLowerCase(),
        qrTextA.slice(0, -1),
        "HELLO WORLD",
      ]) {
        expect(isTicketQrText(nonTicket), nonTicket).toBe(false);
        const res = validateScannedQr(nonTicket);
        expect(res).toEqual({
          ok: false,
          reason: "not_a_ticket",
          message: "Not a ticket",
        });
      }

      // Test in startFrameLoop with a mocked BarcodeDetector returning a non-ET1 QR followed by a valid ET1 QR
      const validScans: string[] = [];
      const invalidScans: Array<{ raw: string; message: string }> = [];
      let nextBarcodes = [{ rawValue: "HTTPS://EXAMPLE.COM/NOT-A-TICKET" }];

      class MockBarcodeDetector {
        static async getSupportedFormats() {
          return ["qr_code"];
        }
        async detect() {
          return nextBarcodes;
        }
      }

      const loop = await startFrameLoop({
        video: { readyState: 4 },
        detectorScope: { BarcodeDetector: MockBarcodeDetector },
        intervalMs: 60_000,
        onTicketQr: (qr) => validScans.push(qr),
        onInvalidQr: (raw, message) => invalidScans.push({ raw, message }),
      });

      try {
        expect(loop.decoderKind).toBe("native");
        await loop.step();
        expect(validScans).toEqual([]);
        expect(invalidScans).toEqual([
          { raw: "HTTPS://EXAMPLE.COM/NOT-A-TICKET", message: "Not a ticket" },
        ]);

        nextBarcodes = [{ rawValue: qrTextA }];
        await loop.step();
        expect(validScans).toEqual([qrTextA]);
      } finally {
        loop.stop();
      }
    });

    it("parses manual door codes (case, spaces, hyphens, O->0, I/L->1) and wedge-scanner ET1: tokens", () => {
      const code = TokenMod.doorCodeFor(TICKET_ID_A, 1);
      const formatted = formatDoorCode(code);
      expect(normalizeDoorCode(formatted.toLowerCase())).toBe(code);
      expect(normalizeDoorCode("o0i1l-abcde")).toBe("00111ABCDE");

      expect(parseManualEntry(`  ${formatted.toLowerCase()} `)).toEqual({
        kind: "code",
        code,
        formatted,
      });

      expect(parseManualEntry(`  ${qrTextA}\n`)).toEqual({
        kind: "qr",
        qr: qrTextA,
      });

      expect(parseManualEntry("https://bad.example")).toEqual({
        kind: "invalid",
        reason: "not_a_ticket",
        message: "Not a ticket",
      });

      expect(parseManualEntry("ET2:0123456789")).toEqual({
        kind: "invalid",
        reason: "not_a_ticket",
        message: "Not a ticket",
      });

      expect(parseManualEntry("SHORT")).toEqual({
        kind: "invalid",
        reason: "invalid_code",
        message: "Enter a 10-character door code (XXXXX-XXXXX)",
      });
    });
  });

  describe("dedupe.ts: 3-second duplicate suppression", () => {
    it("ignores the same text within 3 s and accepts it again at >= 3 s without blocking a different ticket", async () => {
      expect(DEDUPE_WINDOW_MS).toBe(3_000);
      let nowMs = 10_000;
      const dedupe = createScanDedupe(3_000, () => nowMs);

      const accepted: string[] = [];
      const duplicates: string[] = [];

      class MockBarcodeDetector {
        static async getSupportedFormats() {
          return ["qr_code"];
        }
        async detect() {
          return [{ rawValue: currentQr }];
        }
      }

      let currentQr = qrTextA;
      const loop = await startFrameLoop({
        video: { readyState: 4 },
        detectorScope: { BarcodeDetector: MockBarcodeDetector },
        dedupe,
        now: () => nowMs,
        intervalMs: 60_000,
        onTicketQr: (qr) => accepted.push(qr),
        onDuplicateQr: (qr) => duplicates.push(qr),
      });

      try {
        // t = 10_000: first scan of A -> accepted
        await loop.step();
        expect(accepted).toEqual([qrTextA]);
        expect(duplicates).toEqual([]);

        // t = 10_125 (+125ms), 11_500 (+1.5s), 12_999 (+2.999s): same QR A -> ignored
        for (const dt of [125, 1_500, 2_999]) {
          nowMs = 10_000 + dt;
          await loop.step();
        }
        expect(accepted).toEqual([qrTextA]);
        expect(duplicates).toEqual([qrTextA, qrTextA, qrTextA]);

        // t = 12_000: a different ticket B -> accepted immediately
        nowMs = 12_000;
        currentQr = qrTextB;
        await loop.step();
        expect(accepted).toEqual([qrTextA, qrTextB]);

        // t = 13_000 (exactly 3.0 s after A's first scan at 10_000): A accepted again
        nowMs = 13_000;
        currentQr = qrTextA;
        await loop.step();
        expect(accepted).toEqual([qrTextA, qrTextB, qrTextA]);
      } finally {
        loop.stop();
      }
    });
  });

  describe("camera.ts & use-scanner.ts: camera lifecycle, visibilitychange stop, and end-to-end controller", () => {
    it("starts rear camera at 1280px, configures inline muted autoplay video, and stops on visibilitychange", async () => {
      const stopTrackSpy = vi.fn();
      const applyConstraintsSpy = vi.fn().mockResolvedValue(undefined);
      const mockTrack = {
        stop: stopTrackSpy,
        getCapabilities: () => ({ torch: true }),
        applyConstraints: applyConstraintsSpy,
      } as unknown as MediaStreamTrack;

      const mockStream = {
        getVideoTracks: () => [mockTrack],
        getTracks: () => [mockTrack],
      } as unknown as MediaStream;

      const getUserMediaSpy = vi.fn().mockResolvedValue(mockStream);

      const listeners = new Map<string, Set<() => void>>();
      const mockDoc = {
        visibilityState: "visible" as DocumentVisibilityState,
        addEventListener: vi.fn((evt: string, fn: () => void) => {
          if (!listeners.has(evt)) listeners.set(evt, new Set());
          listeners.get(evt)!.add(fn);
        }),
        removeEventListener: vi.fn((evt: string, fn: () => void) => {
          listeners.get(evt)?.delete(fn);
        }),
      };

      const videoEl = {
        playsInline: false,
        muted: false,
        autoplay: false,
        srcObject: null as MediaStream | null,
        setAttribute: vi.fn(),
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
      } as unknown as HTMLVideoElement;

      const stopReasons: string[] = [];
      const session = await startCamera({
        video: videoEl,
        mediaDevices: { getUserMedia: getUserMediaSpy },
        document: mockDoc as unknown as Document,
        window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        onStop: (reason) => stopReasons.push(reason),
      });

      expect(getUserMediaSpy).toHaveBeenCalledWith(CAMERA_CONSTRAINTS);
      expect(videoEl.playsInline).toBe(true);
      expect(videoEl.muted).toBe(true);
      expect(videoEl.autoplay).toBe(true);
      expect(videoEl.srcObject).toBe(mockStream);
      expect(session.torchSupported).toBe(true);

      expect(await session.setTorch(true)).toBe(true);
      expect(session.torchEnabled).toBe(true);
      expect(applyConstraintsSpy).toHaveBeenCalledWith({
        advanced: [{ torch: true }],
      });

      // Simulate page hidden via visibilitychange -> camera stops automatically
      mockDoc.visibilityState = "hidden";
      for (const fn of listeners.get("visibilitychange") ?? []) fn();

      expect(stopTrackSpy).toHaveBeenCalledTimes(1);
      expect(videoEl.srcObject).toBeNull();
      expect(session.isStopped()).toBe(true);
      expect(stopReasons).toEqual(["visibilitychange"]);
    });

    it("scanner controller runs the jsQR worker path when BarcodeDetector lacks qr_code and stops on visibilitychange", async () => {
      const svg = qrSvg(qrTextA);
      const rasterised = rasteriseQrSvg(svg, SCAN_CANVAS_SIZE);

      const stopTrackSpy = vi.fn();
      const mockTrack = {
        stop: stopTrackSpy,
        getCapabilities: () => ({}),
      } as unknown as MediaStreamTrack;
      const mockStream = {
        getVideoTracks: () => [mockTrack],
        getTracks: () => [mockTrack],
      } as unknown as MediaStream;

      const listeners = new Map<string, Set<() => void>>();
      const mockDoc = {
        visibilityState: "visible" as DocumentVisibilityState,
        addEventListener: vi.fn((evt: string, fn: () => void) => {
          if (!listeners.has(evt)) listeners.set(evt, new Set());
          listeners.get(evt)!.add(fn);
        }),
        removeEventListener: vi.fn((evt: string, fn: () => void) => {
          listeners.get(evt)?.delete(fn);
        }),
      };

      const { worker, cleanup } = createMessageChannelWorker();
      const scannedQrs: string[] = [];

      const ctrl = createScannerController({
        detectorScope: {}, // No BarcodeDetector -> must choose jsqr worker
        intervalMs: 60_000,
        createWorker: () => worker,
        createCanvas: (size) => ({
          width: size,
          height: size,
          getContext: () => ({
            drawImage: () => {},
            getImageData: () => ({
              data: new Uint8ClampedArray(rasterised.data),
              width: size,
              height: size,
            }),
          }),
        }),
        cameraOptions: {
          mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(mockStream) },
          document: mockDoc as unknown as Document,
          window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        },
        onScan: (qr) => {
          scannedQrs.push(qr);
        },
      });

      try {
        const started = await ctrl.start({ readyState: 4 } as HTMLVideoElement);
        expect(started).toBe(true);
        expect(ctrl.getState().scanning).toBe(true);
        expect(ctrl.getState().decoderKind).toBe("jsqr");
        expect(ctrl.getState().torchSupported).toBe(false);

        await ctrl.stepFrame();
        expect(scannedQrs).toEqual([qrTextA]);

        // Hide document -> stops camera and resets scanning state
        mockDoc.visibilityState = "hidden";
        for (const fn of listeners.get("visibilitychange") ?? []) fn();
        expect(stopTrackSpy).toHaveBeenCalledTimes(1);
        expect(ctrl.getState().scanning).toBe(false);
        expect(ctrl.getState().status).toBe("idle");
      } finally {
        ctrl.stop();
        cleanup();
      }
    });

    it("surfaces browser-specific guidance when camera permission is denied or no camera exists", () => {
      const deniedIos = describeCameraError(
        { name: "NotAllowedError" },
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      );
      expect(deniedIos.kind).toBe("denied");
      expect(deniedIos.browserHint).toContain("Safari");
      expect(deniedIos.browserHint).toContain("Manual door-code entry");

      const deniedAndroid = describeCameraError(
        { name: "NotAllowedError" },
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/125.0",
      );
      expect(deniedAndroid.kind).toBe("denied");
      expect(deniedAndroid.browserHint).toContain("Android Chrome");

      const missing = describeCameraError({ name: "NotFoundError" });
      expect(missing.kind).toBe("not_found");
      expect(supportsTrackTorch(null)).toBe(false);
    });
  });

  describe("next.config.ts: Permissions-Policy headers", () => {
    it("sends camera=(self) ONLY under /door and camera=() everywhere else", async () => {
      expect(typeof nextConfig.headers).toBe("function");
      const rules = await nextConfig.headers!();

      // Next.js applies matching header rules in order; the last matching rule for a header key wins.
      function matchesSource(source: string, pathname: string): boolean {
        if (source === "/:path*") return pathname.startsWith("/");
        if (source === "/door") return pathname === "/door";
        if (source === "/door/:path*") {
          return pathname === "/door" || pathname.startsWith("/door/");
        }
        return false;
      }

      function effectivePermissionsPolicy(pathname: string): string | undefined {
        let value: string | undefined;
        for (const rule of rules) {
          if (matchesSource(rule.source, pathname)) {
            for (const h of rule.headers) {
              if (h.key.toLowerCase() === "permissions-policy") {
                value = h.value;
              }
            }
          }
        }
        return value;
      }

      for (const doorPath of ["/door", "/door/evt-123", "/door/evt-123/check"]) {
        expect(effectivePermissionsPolicy(doorPath), doorPath).toBe("camera=(self)");
      }

      for (const nonDoorPath of [
        "/",
        "/events",
        "/e/austin-meetup",
        "/tickets",
        "/tickets/t-123",
        "/organizer",
        "/organizer/events/1",
        "/admin",
        "/api/door/events",
        "/doorway",
        "/doors",
      ]) {
        expect(effectivePermissionsPolicy(nonDoorPath), nonDoorPath).toBe("camera=()");
      }
    });
  });
});
