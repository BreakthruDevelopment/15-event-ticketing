import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCamera } from "./camera";
import { createScanDedupe } from "./dedupe";
import { truncateRaw } from "./manual";
import { processDecodedRawText, startFrameLoop, type WorkerLike } from "./frame-loop";
import { createScannerController, type ScannerControllerOptions } from "./use-scanner";

/**
 * Logic-level tests for the failure paths (review 5923130892, findings 2-5). They use fakes, so they prove the
 * branching only; the proof that each one holds in a real browser with a real Worker is `e2e/scanner.e2e.test.ts`.
 */

const TOKEN = `ET1:${"0123456789ABCDEFGHJKMNPQRSTVWXYZ".repeat(2).slice(0, 56)}`;

function fakeTrack() {
  return { stop: vi.fn(), getCapabilities: () => ({}) } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
}
function fakeStream(track: MediaStreamTrack) {
  return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}
const okCanvas = (size: number) => ({
  width: size,
  height: size,
  getContext: () => ({
    drawImage: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(size * size * 4), width: size, height: size }),
  }),
});

function controllerWith(extra: ScannerControllerOptions, track = fakeTrack()) {
  const ctrl = createScannerController({
    detectorScope: {},
    intervalMs: 60_000,
    createCanvas: okCanvas,
    cameraOptions: {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(fakeStream(track)) },
      document: null,
      window: null,
    },
    ...extra,
  });
  return { ctrl, track };
}

describe("frame loop: a dropped worker reply does not wedge it", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("times a frame out, posts again, and gives up after three silent frames", async () => {
    const posts: unknown[] = [];
    const terminate = vi.fn();
    const worker: WorkerLike = { onmessage: null, onerror: null, postMessage: (m) => void posts.push(m), terminate };
    const failed = vi.fn();
    const loop = await startFrameLoop({
      video: { readyState: 4 },
      nativeDetector: null,
      createWorker: () => worker,
      createCanvas: okCanvas,
      intervalMs: 100,
      decodeTimeoutMs: 300,
      onTicketQr: () => {},
      onDecoderFailed: failed,
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(posts.length).toBeGreaterThan(1); // inFlight was released by the timeout
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(failed).toHaveBeenCalledWith("worker_timeout");
    expect(failed).toHaveBeenCalledTimes(1);
    expect(loop.isStopped()).toBe(true);
    expect(terminate).toHaveBeenCalled();
  });

  it("a late reply to an abandoned frame is still decoded but does not release the current frame", async () => {
    const posts: { id: number }[] = [];
    const worker: WorkerLike = {
      onmessage: null,
      postMessage: (m) => void posts.push(m as { id: number }),
      terminate: () => {},
    };
    const seen: string[] = [];
    await startFrameLoop({
      video: { readyState: 4 },
      nativeDetector: null,
      createWorker: () => worker,
      createCanvas: okCanvas,
      intervalMs: 100,
      decodeTimeoutMs: 300,
      onTicketQr: (qr) => void seen.push(qr),
    });
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(300); // frame 1 times out, frame 2 is posted
    expect(posts.length).toBe(2);
    worker.onmessage?.({ data: { id: posts[0].id, text: TOKEN, data: TOKEN } });
    expect(seen).toEqual([TOKEN]);
    await vi.advanceTimersByTimeAsync(150);
    expect(posts.length).toBe(2); // frame 2 is still in flight: no second post yet
  });

  it("a null 2d context is a decoder start failure and terminates the worker it created", async () => {
    const terminate = vi.fn();
    await expect(
      startFrameLoop({
        video: { readyState: 4 },
        nativeDetector: null,
        createWorker: () => ({ onmessage: null, postMessage: () => {}, terminate }),
        createCanvas: (size) => ({ width: size, height: size, getContext: () => null }),
        onTicketQr: () => {},
      }),
    ).rejects.toMatchObject({ name: "DecoderStartError", reason: "no_canvas" });
    expect(terminate).toHaveBeenCalled();
  });
});

describe("controller: the camera never outlives a failed start", () => {
  it("stops the track and blames the decoder when the worker cannot be created", async () => {
    const { ctrl, track } = controllerWith({
      createWorker: () => {
        throw new Error("no worker");
      },
    });
    expect(await ctrl.start({ readyState: 4 } as HTMLVideoElement)).toBe(false);
    expect(track.stop).toHaveBeenCalledTimes(1);
    const s = ctrl.getState();
    expect(s.status).toBe("error");
    expect(s.cameraError?.kind).toBe("decoder");
    expect(s.cameraError?.message).not.toMatch(/could not start the camera/i);
  });

  it("stops the track on a null 2d context", async () => {
    const terminate = vi.fn();
    const { ctrl, track } = controllerWith({
      createWorker: () => ({ onmessage: null, postMessage: () => {}, terminate }),
      createCanvas: (size) => ({ width: size, height: size, getContext: () => null }),
    });
    expect(await ctrl.start({ readyState: 4 } as HTMLVideoElement)).toBe(false);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalled();
    expect(ctrl.getState().cameraError?.kind).toBe("decoder");
  });

  it("startCamera releases the stream when attaching it to the video throws", async () => {
    const track = fakeTrack();
    const video = {
      play: async () => {},
      setAttribute: () => {},
      set srcObject(_v: unknown) {
        throw new Error("cannot attach");
      },
    } as unknown as HTMLVideoElement;
    await expect(
      startCamera({
        video,
        mediaDevices: { getUserMedia: async () => fakeStream(track) },
        document: null,
        window: null,
      }),
    ).rejects.toThrow("cannot attach");
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
});

describe("controller: a failing check-in is not silent", () => {
  it("shows an error banner, reports the error, and accepts the same ticket again inside the dedupe window", async () => {
    const attempts: string[] = [];
    const onScanError = vi.fn();
    let t = 0;
    const { ctrl } = controllerWith({
      now: () => t,
      onScan: async (qr) => {
        attempts.push(qr);
        throw new Error("network down");
      },
      onScanError,
    });
    const first = await ctrl.submitManual(TOKEN); // must not reject
    expect(first.kind).toBe("qr");
    expect(attempts).toHaveLength(1);
    expect(onScanError).toHaveBeenCalledTimes(1);
    expect(ctrl.getState().banner).toMatchObject({ tone: "error" });
    expect(ctrl.getState().busy).toBe(false);
    t = 1_000; // inside the 3 s window
    await ctrl.submitManual(TOKEN);
    expect(attempts).toHaveLength(2);
  });

  it("does not keep the ticket token in state", async () => {
    const { ctrl } = controllerWith({ onScan: async () => {} });
    await ctrl.submitManual(TOKEN);
    expect(JSON.stringify(ctrl.getState())).not.toContain("ET1:");
  });
});

// Review 5923731525.
describe("controller: overlapping start() calls (B1)", () => {
  it("a stale session's stop cannot tear down the live session or orphan its stream", async () => {
    const trackA = fakeTrack();
    const trackB = fakeTrack();
    let resolveA!: (s: MediaStream) => void;
    let resolveB!: (s: MediaStream) => void;
    const getUserMedia = vi
      .fn()
      .mockReturnValueOnce(new Promise<MediaStream>((r) => (resolveA = r)))
      .mockReturnValueOnce(new Promise<MediaStream>((r) => (resolveB = r)));
    const ctrl = createScannerController({
      detectorScope: {},
      intervalMs: 60_000,
      createCanvas: okCanvas,
      createWorker: () => ({ onmessage: null, postMessage: () => {}, terminate: () => {} }),
      cameraOptions: { mediaDevices: { getUserMedia }, document: null, window: null },
    });
    // Both calls share one element, as the door page's single <video> does.
    const video = { readyState: 4, srcObject: null as unknown, play: async () => {}, pause: () => {} } as unknown as HTMLVideoElement;
    const streamB = fakeStream(trackB);
    const first = ctrl.start(video); // a double-tap on "Start scanning"
    const second = ctrl.start(video);
    resolveB(streamB); // the second request's camera arrives first
    const secondStarted = await second;
    resolveA(fakeStream(trackA));
    const firstStarted = await first;
    expect(secondStarted).toBe(true);
    expect(firstStarted).toBe(false);
    expect(trackA.stop).toHaveBeenCalled(); // the superseded stream is released
    expect(ctrl.getState().status).toBe("scanning"); // and did not take the live session down with it
    expect(trackB.stop).not.toHaveBeenCalled();
    // What the staffer sees: the preview shows the live session's stream, not nothing (review 5924084602, B3).
    expect(video.srcObject).toBe(streamB);
    ctrl.stop("manual");
    expect(trackB.stop).toHaveBeenCalled(); // an explicit stop reaches the live camera
    expect(ctrl.getState().status).toBe("idle");
    expect(video.srcObject).toBeNull(); // and the preview is released with it
  });
});

describe("controller: an entry submitted while busy (B2)", () => {
  it("is refused visibly, not consumed, and the retry goes through", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const T2 = `ET1:${"Z".repeat(56)}`;
    const { ctrl } = controllerWith({
      onScan: (qr) => {
        calls.push(qr);
        return calls.length === 1 ? new Promise<void>((r) => (release = r)) : undefined;
      },
    });
    const first = ctrl.submitManual(TOKEN); // in flight
    const second = await ctrl.submitManual(T2); // staffer taps again meanwhile
    expect(second).toMatchObject({ kind: "invalid", reason: "busy" }); // not reported as accepted
    expect(ctrl.getState().banner).toMatchObject({ tone: "warning" });
    expect(calls).toEqual([TOKEN]);
    release();
    await first;
    const retry = await ctrl.submitManual(T2);
    expect(retry.kind).toBe("qr");
    expect(calls).toEqual([TOKEN, T2]); // not swallowed as a 3 s duplicate
  });
});

describe("camera hidden while the permission prompt was open", () => {
  it("stops the stream as soon as it is acquired", async () => {
    const track = fakeTrack();
    const onStop = vi.fn();
    const doc = { visibilityState: "hidden" as DocumentVisibilityState, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const session = await startCamera({
      mediaDevices: { getUserMedia: async () => fakeStream(track) },
      document: doc as unknown as Document,
      window: null,
      onStop,
    });
    expect(session.isStopped()).toBe(true);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith("visibilitychange");
  });
});

describe("onInvalidQr never hands out an unbounded raw string", () => {
  it("truncates and strips control characters", async () => {
    const seen: string[] = [];
    const { ctrl } = controllerWith({ onInvalidQr: (raw) => void seen.push(raw) });
    await ctrl.submitManual(`http://x\nFORGED LOG LINE: ${"x".repeat(5_000)}`);
    expect(seen).toHaveLength(1);
    expect(Array.from(seen[0]).length).toBeLessThanOrEqual(65);
    expect(seen[0]).not.toMatch(/[\u0000-\u001f\u0080-\u009f\u2028\u2029]/);
    const camera: string[] = [];
    processDecodedRawText(`WIFI:S:${"y".repeat(5_000)}`, {
      dedupe: createScanDedupe(),
      now: () => 0,
      onTicketQr: () => {},
      onInvalidQr: (raw) => void camera.push(raw),
    });
    expect(camera).toHaveLength(1);
    expect(Array.from(camera[0]).length).toBeLessThanOrEqual(65);
  });

  it("never cuts a surrogate pair in half, and scrubs C1 controls and line separators", () => {
    const cut = truncateRaw(`${"a".repeat(63)}\u{1F600}tail:`);
    expect(cut.isWellFormed()).toBe(true);
    expect(cut.startsWith("a".repeat(63))).toBe(true);
    const scrubbed = truncateRaw("x\u0085y\u2028z\u2029w\u007f");
    expect(scrubbed).toBe("x?y?z?w?");
  });
});
