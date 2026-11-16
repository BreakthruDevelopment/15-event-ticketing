/**
 * Browser camera lifecycle for `/door/[eventId]`:
 * - `getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false })`
 * - Configures `<video playsinline muted autoplay>`
 * - Detects hardware torch support via `track.getCapabilities().torch` (Android Chrome)
 * - Stops tracks immediately on `visibilitychange` (when hidden), `pagehide`, or manual `stop()`
 * - Maps permission/hardware errors to per-browser recovery instructions while manual entry stays active
 */

export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1280 },
  },
  audio: false,
};

export const VIDEO_ELEMENT_ATTRS = {
  playsInline: true,
  muted: true,
  autoPlay: true,
} as const;

export type CameraErrorKind =
  | "denied"
  | "not_found"
  | "in_use"
  | "insecure_context"
  | "unsupported"
  | "unknown";

export interface CameraErrorInfo {
  kind: CameraErrorKind;
  message: string;
  browserHint: string;
}

export type CameraStopReason = "manual" | "visibilitychange" | "pagehide" | "unmount";

export interface CameraSession {
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack | null;
  readonly torchSupported: boolean;
  readonly torchEnabled: boolean;
  setTorch(enabled: boolean): Promise<boolean>;
  stop(reason?: CameraStopReason): void;
  isStopped(): boolean;
}

export interface StartCameraOptions {
  video?: HTMLVideoElement | null;
  mediaDevices?: Pick<MediaDevices, "getUserMedia"> | null;
  document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> | null;
  window?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
  onStop?: (reason: CameraStopReason) => void;
}

/**
 * Configures a `<video>` element for inline, muted, autoplay camera preview (required by iOS Safari).
 */
export function configureVideoElement(
  video: HTMLVideoElement,
  stream: MediaStream | null,
): void {
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  if (typeof video.setAttribute === "function") {
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");
    video.setAttribute("autoplay", "");
  }
  video.srcObject = stream;
}

/**
 * Returns `true` only when the video track exposes `getCapabilities().torch === true` (e.g. Android Chrome).
 */
export function supportsTrackTorch(track: MediaStreamTrack | null | undefined): boolean {
  if (!track || typeof track.getCapabilities !== "function") {
    return false;
  }
  try {
    const caps = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
    return Boolean(caps && caps.torch === true);
  } catch {
    return false;
  }
}

/**
 * Toggles the camera torch when supported by the video track.
 */
export async function setTrackTorch(
  track: MediaStreamTrack | null | undefined,
  enabled: boolean,
): Promise<boolean> {
  if (!supportsTrackTorch(track) || !track || typeof track.applyConstraints !== "function") {
    return false;
  }
  try {
    await track.applyConstraints({
      advanced: [{ torch: enabled } as MediaTrackConstraintSet],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns per-browser guidance on how to enable camera access when denied or unavailable.
 */
export function browserCameraHelp(userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): string {
  const ua = userAgent.toLowerCase();
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")) {
    return "On iPhone/iPad Safari: tap the 'aA' or Page Settings icon in the address bar -> Website Settings -> Camera -> Allow, then tap Start scanning again. Manual door-code entry and name search remain available below.";
  }
  if (ua.includes("android")) {
    return "On Android Chrome: tap the tune/lock icon next to the URL -> Permissions -> Camera -> Allow, then tap Start scanning again. Manual door-code entry and name search remain available below.";
  }
  if (ua.includes("safari") && !ua.includes("chrome")) {
    return "In Safari: open Safari Settings -> Websites -> Camera -> Allow for this site, then tap Start scanning again. Manual door-code entry and name search remain available below.";
  }
  return "In your browser: click the site permissions icon in the address bar, allow Camera access, and tap Start scanning again. Manual door-code entry and name search remain available below.";
}

/**
 * Classifies a `getUserMedia` error into a structured `CameraErrorInfo` with browser-specific help.
 */
export function describeCameraError(
  err: unknown,
  userAgent?: string,
): CameraErrorInfo {
  const hint = browserCameraHelp(userAgent);
  const name =
    typeof err === "object" && err !== null && "name" in err && typeof (err as { name?: unknown }).name === "string"
      ? (err as { name: string }).name
      : "";

  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return {
      kind: "denied",
      message: "Camera access was denied.",
      browserHint: hint,
    };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return {
      kind: "not_found",
      message: "No camera was found on this device.",
      browserHint: "Use manual door-code entry or attendee name search below.",
    };
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return {
      kind: "in_use",
      message: "The camera is currently in use by another app or tab.",
      browserHint: "Close other apps using the camera and tap Start scanning again, or use manual entry below.",
    };
  }
  return {
    kind: "unknown",
    message: "Could not start the camera.",
    browserHint: hint,
  };
}

/**
 * Requests the rear camera stream, attaches it to `video` (if provided), and automatically
 * stops the stream on `visibilitychange` (when the document becomes hidden) or `pagehide`.
 */
export async function startCamera(options: StartCameraOptions = {}): Promise<CameraSession> {
  const mediaDevices =
    options.mediaDevices !== undefined
      ? options.mediaDevices
      : typeof navigator !== "undefined"
        ? navigator.mediaDevices
        : null;

  if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
    const isInsecure = typeof window !== "undefined" && window.isSecureContext === false;
    const error = new Error(
      isInsecure
        ? "Camera requires HTTPS."
        : "Camera API is not supported in this browser.",
    );
    error.name = isInsecure ? "SecurityError" : "NotSupportedError";
    throw error;
  }

  const stream = await mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
  const tracks = typeof stream.getVideoTracks === "function" ? stream.getVideoTracks() : [];
  const track = tracks[0] ?? null;
  const torchSupported = supportsTrackTorch(track);
  let torchEnabled = false;
  let stopped = false;

  const video = options.video ?? null;
  if (video) {
    configureVideoElement(video, stream);
    if (typeof video.play === "function") {
      try {
        await video.play();
      } catch {
        // Autoplay failure on mock or backgrounded element is non-fatal if tracks are live.
      }
    }
  }

  const doc =
    options.document !== undefined
      ? options.document
      : typeof document !== "undefined"
        ? document
        : null;
  const win =
    options.window !== undefined
      ? options.window
      : typeof window !== "undefined"
        ? window
        : null;

  const onVisibilityChange = () => {
    if (!doc || doc.visibilityState === "hidden") {
      stop("visibilitychange");
    }
  };

  const onPageHide = () => {
    stop("pagehide");
  };

  if (doc && typeof doc.addEventListener === "function") {
    doc.addEventListener("visibilitychange", onVisibilityChange);
  }
  if (win && typeof win.addEventListener === "function") {
    win.addEventListener("pagehide", onPageHide);
  }

  function stop(reason: CameraStopReason = "manual"): void {
    if (stopped) return;
    stopped = true;
    torchEnabled = false;

    if (doc && typeof doc.removeEventListener === "function") {
      doc.removeEventListener("visibilitychange", onVisibilityChange);
    }
    if (win && typeof win.removeEventListener === "function") {
      win.removeEventListener("pagehide", onPageHide);
    }

    const allTracks = typeof stream.getTracks === "function" ? stream.getTracks() : tracks;
    for (const t of allTracks) {
      try {
        t.stop();
      } catch {
        // Ignore errors stopping an already-ended track.
      }
    }

    if (video) {
      try {
        if (typeof video.pause === "function") video.pause();
        video.srcObject = null;
      } catch {
        // Ignore DOM cleanup errors.
      }
    }

    options.onStop?.(reason);
  }

  return {
    stream,
    track,
    torchSupported,
    get torchEnabled() {
      return torchEnabled;
    },
    async setTorch(enabled: boolean): Promise<boolean> {
      if (stopped) return false;
      const ok = await setTrackTorch(track, enabled);
      if (ok) {
        torchEnabled = enabled;
      }
      return ok;
    },
    stop,
    isStopped() {
      return stopped;
    },
  };
}
