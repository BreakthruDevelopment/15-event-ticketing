/**
 * Suppresses repeated decodes of the same QR text within a 3-second window,
 * because the camera sees the same ticket across many consecutive frames.
 */

export const DEDUPE_WINDOW_MS = 3_000;

export interface ScanDedupe {
  /** Returns `true` if `text` has not been accepted in the last `windowMs`, recording the timestamp. */
  shouldAccept(text: string, atMs?: number): boolean;
  /** Removes a specific text from the suppression window. */
  forget(text: string): void;
  /** Clears all remembered scans. */
  reset(): void;
}

export function createScanDedupe(
  windowMs: number = DEDUPE_WINDOW_MS,
  now: () => number = () => Date.now(),
): ScanDedupe {
  const seen = new Map<string, number>();

  function prune(currentMs: number): void {
    for (const [key, ts] of seen) {
      if (currentMs - ts >= windowMs) {
        seen.delete(key);
      }
    }
  }

  return {
    shouldAccept(text: string, atMs: number = now()): boolean {
      if (!text) return false;
      const prev = seen.get(text);
      if (prev !== undefined && atMs - prev >= 0 && atMs - prev < windowMs) {
        return false;
      }
      prune(atMs);
      seen.set(text, atMs);
      return true;
    },
    forget(text: string): void {
      seen.delete(text);
    },
    reset(): void {
      seen.clear();
    },
  };
}
