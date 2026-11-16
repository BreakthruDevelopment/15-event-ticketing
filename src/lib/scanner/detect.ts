/**
 * Feature detection for the Web Shape Detection API (`BarcodeDetector`).
 *
 * The native path is chosen ONLY when `BarcodeDetector.getSupportedFormats()`
 * resolves to an array containing `"qr_code"`. On iOS Safari (all iPhone browsers)
 * and browsers where `qr_code` is absent or throws, the scanner falls back to the
 * `jsqr` Web Worker.
 */

export interface DetectedBarcode {
  rawValue: string;
  format?: string;
}

export interface BarcodeDetectorLike {
  detect(source: unknown): Promise<DetectedBarcode[]>;
}

export interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

export type DecoderKind = "native" | "jsqr";

export interface BarcodeDetectorScope {
  BarcodeDetector?: unknown;
}

/**
 * Checks whether `BarcodeDetector` is available and explicitly supports `"qr_code"`.
 */
export async function supportsNativeQrDetector(
  scope: BarcodeDetectorScope = globalThis as BarcodeDetectorScope,
): Promise<boolean> {
  try {
    const Ctor = scope?.BarcodeDetector as BarcodeDetectorConstructor | undefined;
    if (typeof Ctor !== "function" || typeof Ctor.getSupportedFormats !== "function") {
      return false;
    }
    const formats = await Ctor.getSupportedFormats();
    return Array.isArray(formats) && formats.includes("qr_code");
  } catch {
    return false;
  }
}

/**
 * Selects `"native"` only when `BarcodeDetector.getSupportedFormats()` includes `"qr_code"`,
 * otherwise `"jsqr"`.
 */
export async function chooseDecoderKind(
  scope: BarcodeDetectorScope = globalThis as BarcodeDetectorScope,
): Promise<DecoderKind> {
  return (await supportsNativeQrDetector(scope)) ? "native" : "jsqr";
}

/**
 * Instantiates `new BarcodeDetector({ formats: ["qr_code"] })` if and only if
 * `qr_code` is supported. Returns `null` when unsupported or if construction throws.
 */
export async function createNativeQrDetector(
  scope: BarcodeDetectorScope = globalThis as BarcodeDetectorScope,
): Promise<BarcodeDetectorLike | null> {
  if (!(await supportsNativeQrDetector(scope))) {
    return null;
  }
  try {
    const Ctor = scope.BarcodeDetector as BarcodeDetectorConstructor;
    return new Ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}
