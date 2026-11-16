"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CameraErrorInfo,
  type CameraSession,
  type CameraStopReason,
  describeCameraError,
  type StartCameraOptions,
  startCamera,
  VIDEO_ELEMENT_ATTRS,
} from "./camera";
import { createScanDedupe, DEDUPE_WINDOW_MS, type ScanDedupe } from "./dedupe";
import type { BarcodeDetectorScope, DecoderKind } from "./detect";
import {
  type CanvasElementLike,
  type FrameLoopHandle,
  SCAN_CANVAS_SIZE,
  SCAN_INTERVAL_MS,
  startFrameLoop,
  type VideoSourceLike,
  type WorkerLike,
} from "./frame-loop";
import {
  MANUAL_INPUT_ATTRS,
  type ManualEntryResult,
  NOT_A_TICKET_MESSAGE,
  parseManualEntry,
} from "./manual";

/**
 * React hook (`useScanner`) and framework-free controller (`createScannerController`)
 * for the `/door/[eventId]` phone-browser QR scanner.
 */

export const RESULT_DISPLAY_MS = 1_500;

export type ScannerStatus = "idle" | "starting" | "scanning" | "paused" | "error";

export type ScannerFeedbackTone = "success" | "warning" | "error";

export type ScannedEntry =
  | { method: "qr"; qr: string }
  | { method: "code"; code: string; formatted: string };

export interface ScannerBanner {
  tone: ScannerFeedbackTone;
  message: string;
}

export interface ScannerState {
  status: ScannerStatus;
  scanning: boolean;
  busy: boolean;
  decoderKind: DecoderKind | null;
  torchSupported: boolean;
  torchEnabled: boolean;
  cameraError: CameraErrorInfo | null;
  banner: ScannerBanner | null;
  lastScan: string | null;
}

export interface ScannerControllerOptions {
  /** Called when a valid, non-duplicate `ET1:` QR code is decoded. */
  onScan?: (qr: string) => void | Promise<void>;
  /** Called when a valid 10-character door code is submitted manually. */
  onDoorCode?: (code: string) => void | Promise<void>;
  /** Unified callback for either a valid QR scan or manual door code / wedge scan. */
  onEntry?: (entry: ScannedEntry) => void | Promise<void>;
  /** Called when a scanned QR code is rejected locally (not matching `ET1:`). */
  onInvalidQr?: (rawValue: string, message: string) => void;
  /** Called when an identical `ET1:` QR code is ignored within the 3 s dedupe window. */
  onDuplicate?: (qr: string) => void;
  /** Called when the camera stops (e.g. `"visibilitychange"`, `"pagehide"`, `"manual"`). */
  onCameraStop?: (reason: CameraStopReason) => void;
  dedupeWindowMs?: number;
  intervalMs?: number;
  canvasSize?: number;
  resultDisplayMs?: number;
  now?: () => number;
  detectorScope?: BarcodeDetectorScope;
  createWorker?: () => WorkerLike;
  createCanvas?: (size: number) => CanvasElementLike;
  cameraOptions?: Omit<StartCameraOptions, "video" | "onStop">;
  userAgent?: string;
}

export interface ScannerController {
  getState(): ScannerState;
  subscribe(listener: (state: ScannerState) => void): () => void;
  start(video?: HTMLVideoElement | VideoSourceLike | null): Promise<boolean>;
  stop(reason?: CameraStopReason): void;
  stepFrame(): Promise<void>;
  setTorch(enabled: boolean): Promise<boolean>;
  toggleTorch(): Promise<boolean>;
  submitManual(input: string): Promise<ManualEntryResult>;
  showBanner(tone: ScannerFeedbackTone, message: string, autoClearMs?: number): void;
  dismissBanner(): void;
  playFeedback(tone: ScannerFeedbackTone): void;
  resetDedupe(): void;
}

export function getInitialScannerState(): ScannerState {
  return {
    status: "idle",
    scanning: false,
    busy: false,
    decoderKind: null,
    torchSupported: false,
    torchEnabled: false,
    cameraError: null,
    banner: null,
    lastScan: null,
  };
}

/**
 * Plays a short Web Audio feedback tone (unlocked by the user gesture that starts scanning)
 * and triggers `navigator.vibrate` where supported.
 */
export function triggerDeviceFeedback(
  tone: ScannerFeedbackTone,
  audioCtx?: AudioContext | null,
): void {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate(tone === "success" ? 40 : [60, 40, 60]);
    } catch {
      // Ignore vibration failures.
    }
  }
  if (!audioCtx) return;
  try {
    if (audioCtx.state === "suspended") {
      void audioCtx.resume().catch(() => {});
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = tone === "success" ? "sine" : "triangle";
    osc.frequency.value = tone === "success" ? 880 : tone === "warning" ? 440 : 260;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const t0 = audioCtx.currentTime;
    osc.start(t0);
    osc.stop(t0 + (tone === "success" ? 0.1 : 0.18));
  } catch {
    // Ignore Web Audio failures in unsupported or restricted environments.
  }
}

function unlockAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (typeof Ctor !== "function") return null;
  try {
    const ctx = new Ctor();
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    return ctx;
  } catch {
    return null;
  }
}

export function createScannerController(
  options: ScannerControllerOptions = {},
): ScannerController {
  const now = options.now ?? (() => Date.now());
  const dedupe: ScanDedupe = createScanDedupe(
    options.dedupeWindowMs ?? DEDUPE_WINDOW_MS,
    now,
  );
  const resultDisplayMs = options.resultDisplayMs ?? RESULT_DISPLAY_MS;

  let state: ScannerState = getInitialScannerState();
  const listeners = new Set<(s: ScannerState) => void>();

  let cameraSession: CameraSession | null = null;
  let frameLoop: FrameLoopHandle | null = null;
  let bannerTimer: ReturnType<typeof setTimeout> | null = null;
  let audioCtx: AudioContext | null = null;
  let activeVideo: HTMLVideoElement | VideoSourceLike | null = null;
  let startGeneration = 0;

  function updateState(patch: Partial<ScannerState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener(state);
    }
  }

  function clearBannerTimer(): void {
    if (bannerTimer !== null) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
    }
  }

  function showBanner(
    tone: ScannerFeedbackTone,
    message: string,
    autoClearMs: number = resultDisplayMs,
  ): void {
    clearBannerTimer();
    updateState({ banner: { tone, message } });
    if (autoClearMs > 0) {
      bannerTimer = setTimeout(() => {
        bannerTimer = null;
        updateState({ banner: null });
      }, autoClearMs);
    }
  }

  function dismissBanner(): void {
    clearBannerTimer();
    if (state.banner !== null) {
      updateState({ banner: null });
    }
  }

  async function dispatchEntry(entry: ScannedEntry): Promise<void> {
    if (state.busy) return;
    updateState({
      busy: true,
      lastScan: entry.method === "qr" ? entry.qr : entry.code,
    });
    try {
      if (entry.method === "qr") {
        await options.onScan?.(entry.qr);
      } else {
        await options.onDoorCode?.(entry.code);
      }
      await options.onEntry?.(entry);
    } finally {
      updateState({ busy: false });
    }
  }

  async function start(video?: HTMLVideoElement | VideoSourceLike | null): Promise<boolean> {
    const gen = ++startGeneration;
    stop("manual");
    startGeneration = gen;

    if (video !== undefined) {
      activeVideo = video;
    }
    if (!audioCtx) {
      audioCtx = unlockAudioContext();
    }

    updateState({
      status: "starting",
      scanning: false,
      cameraError: null,
      banner: null,
    });

    try {
      const session = await startCamera({
        ...options.cameraOptions,
        video: (activeVideo as HTMLVideoElement | null) ?? null,
        onStop: (reason) => {
          if (frameLoop) {
            frameLoop.stop();
            frameLoop = null;
          }
          cameraSession = null;
          updateState({
            status: "idle",
            scanning: false,
            torchSupported: false,
            torchEnabled: false,
          });
          options.onCameraStop?.(reason);
        },
      });

      if (gen !== startGeneration) {
        session.stop("manual");
        return false;
      }

      cameraSession = session;

      const loop = await startFrameLoop({
        video: activeVideo ?? { readyState: 4 },
        dedupe,
        now,
        intervalMs: options.intervalMs ?? SCAN_INTERVAL_MS,
        canvasSize: options.canvasSize ?? SCAN_CANVAS_SIZE,
        detectorScope: options.detectorScope,
        createWorker: options.createWorker,
        createCanvas: options.createCanvas,
        isPaused: () => state.busy,
        onTicketQr: (qr) => {
          void dispatchEntry({ method: "qr", qr });
        },
        onInvalidQr: (rawValue, message) => {
          showBanner("warning", message, resultDisplayMs);
          triggerDeviceFeedback("warning", audioCtx);
          options.onInvalidQr?.(rawValue, message);
        },
        onDuplicateQr: (qr) => {
          options.onDuplicate?.(qr);
        },
      });

      if (gen !== startGeneration || session.isStopped()) {
        loop.stop();
        session.stop("manual");
        return false;
      }

      frameLoop = loop;
      updateState({
        status: "scanning",
        scanning: true,
        decoderKind: loop.decoderKind,
        torchSupported: session.torchSupported,
        torchEnabled: session.torchEnabled,
        cameraError: null,
      });
      return true;
    } catch (err) {
      const info = describeCameraError(err, options.userAgent);
      updateState({
        status: "error",
        scanning: false,
        torchSupported: false,
        torchEnabled: false,
        cameraError: info,
      });
      return false;
    }
  }

  function stop(reason: CameraStopReason = "manual"): void {
    startGeneration++;
    clearBannerTimer();
    if (frameLoop) {
      frameLoop.stop();
      frameLoop = null;
    }
    if (cameraSession) {
      const s = cameraSession;
      cameraSession = null;
      s.stop(reason);
    } else {
      updateState({
        status: "idle",
        scanning: false,
        torchSupported: false,
        torchEnabled: false,
      });
    }
  }

  async function stepFrame(): Promise<void> {
    if (!frameLoop) return;
    await frameLoop.step();
  }

  async function setTorch(enabled: boolean): Promise<boolean> {
    if (!cameraSession) return false;
    const ok = await cameraSession.setTorch(enabled);
    if (ok) {
      updateState({ torchEnabled: cameraSession.torchEnabled });
    }
    return ok;
  }

  async function toggleTorch(): Promise<boolean> {
    return setTorch(!state.torchEnabled);
  }

  async function submitManual(input: string): Promise<ManualEntryResult> {
    const parsed = parseManualEntry(input);
    if (parsed.kind === "invalid") {
      const msg = parsed.reason === "not_a_ticket" ? NOT_A_TICKET_MESSAGE : parsed.message;
      showBanner("warning", msg, resultDisplayMs);
      triggerDeviceFeedback("warning", audioCtx);
      if (parsed.reason === "not_a_ticket") {
        options.onInvalidQr?.(input, msg);
      }
      return parsed;
    }
    if (parsed.kind === "qr") {
      if (!dedupe.shouldAccept(parsed.qr, now())) {
        options.onDuplicate?.(parsed.qr);
        return parsed;
      }
      await dispatchEntry({ method: "qr", qr: parsed.qr });
      return parsed;
    }
    await dispatchEntry({ method: "code", code: parsed.code, formatted: parsed.formatted });
    return parsed;
  }

  return {
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop,
    stepFrame,
    setTorch,
    toggleTorch,
    submitManual,
    showBanner,
    dismissBanner,
    playFeedback(tone) {
      triggerDeviceFeedback(tone, audioCtx);
    },
    resetDedupe() {
      dedupe.reset();
    },
  };
}

export interface UseScannerReturn extends ScannerState {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoAttrs: typeof VIDEO_ELEMENT_ATTRS;
  manualInputAttrs: typeof MANUAL_INPUT_ATTRS;
  start: (video?: HTMLVideoElement | null) => Promise<boolean>;
  stop: () => void;
  setTorch: (enabled: boolean) => Promise<boolean>;
  toggleTorch: () => Promise<boolean>;
  submitManual: (input: string) => Promise<ManualEntryResult>;
  showBanner: (tone: ScannerFeedbackTone, message: string, autoClearMs?: number) => void;
  dismissBanner: () => void;
  playFeedback: (tone: ScannerFeedbackTone) => void;
  resetDedupe: () => void;
}

/**
 * React hook for the `/door/[eventId]` QR scanner, manual door-code entry,
 * torch control, and visibility lifecycle.
 */
export function useScanner(options: ScannerControllerOptions = {}): UseScannerReturn {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const optionsRef = useRef<ScannerControllerOptions>(options);
  const controllerRef = useRef<ScannerController | null>(null);
  const [state, setState] = useState<ScannerState>(getInitialScannerState);

  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    const ctrl = createScannerController({
      ...optionsRef.current,
      onScan: (qr) => optionsRef.current.onScan?.(qr),
      onDoorCode: (code) => optionsRef.current.onDoorCode?.(code),
      onEntry: (entry) => optionsRef.current.onEntry?.(entry),
      onInvalidQr: (raw, msg) => optionsRef.current.onInvalidQr?.(raw, msg),
      onDuplicate: (qr) => optionsRef.current.onDuplicate?.(qr),
      onCameraStop: (reason) => optionsRef.current.onCameraStop?.(reason),
    });
    controllerRef.current = ctrl;
    const unsubscribe = ctrl.subscribe(setState);
    return () => {
      unsubscribe();
      ctrl.stop("unmount");
      controllerRef.current = null;
    };
  }, []);

  const start = useCallback(async (video?: HTMLVideoElement | null) => {
    const ctrl = controllerRef.current;
    if (!ctrl) return false;
    return ctrl.start(video ?? videoRef.current);
  }, []);

  const stop = useCallback(() => {
    controllerRef.current?.stop("manual");
  }, []);

  const setTorch = useCallback(async (enabled: boolean) => {
    const ctrl = controllerRef.current;
    if (!ctrl) return false;
    return ctrl.setTorch(enabled);
  }, []);

  const toggleTorch = useCallback(async () => {
    const ctrl = controllerRef.current;
    if (!ctrl) return false;
    return ctrl.toggleTorch();
  }, []);

  const submitManual = useCallback(async (input: string): Promise<ManualEntryResult> => {
    const ctrl = controllerRef.current;
    if (!ctrl) {
      return parseManualEntry(input);
    }
    return ctrl.submitManual(input);
  }, []);

  const showBanner = useCallback(
    (tone: ScannerFeedbackTone, message: string, autoClearMs?: number) => {
      controllerRef.current?.showBanner(tone, message, autoClearMs);
    },
    [],
  );

  const dismissBanner = useCallback(() => {
    controllerRef.current?.dismissBanner();
  }, []);

  const playFeedback = useCallback((tone: ScannerFeedbackTone) => {
    controllerRef.current?.playFeedback(tone);
  }, []);

  const resetDedupe = useCallback(() => {
    controllerRef.current?.resetDedupe();
  }, []);

  return {
    ...state,
    videoRef,
    videoAttrs: VIDEO_ELEMENT_ATTRS,
    manualInputAttrs: MANUAL_INPUT_ATTRS,
    start,
    stop,
    setTorch,
    toggleTorch,
    submitManual,
    showBanner,
    dismissBanner,
    playFeedback,
    resetDedupe,
  };
}
