/**
 * Client-safe parsing and validation for scanned QR payloads (`ET1:...`) and
 * manually entered 10-character Crockford base32 door codes (`XXXXX-XXXXX`).
 *
 * Kept free of `server-only` and Node crypto so it can run in the browser and worker.
 */

export const TICKET_QR_RE = /^ET1:[0-9A-HJKMNP-TV-Z]{56}$/;
export const DOOR_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

export const NOT_A_TICKET_MESSAGE = "Not a ticket";
export const INVALID_DOOR_CODE_MESSAGE = "Enter a 10-character door code (XXXXX-XXXXX)";

/** Recommended HTML attributes for the manual door-code / wedge-scanner input field. */
export const MANUAL_INPUT_ATTRS = {
  autoCapitalize: "characters",
  autoComplete: "off",
  enterKeyHint: "go",
} as const;

export type ManualEntryResult =
  | { kind: "qr"; qr: string }
  | { kind: "code"; code: string; formatted: string }
  | { kind: "invalid"; reason: "empty" | "not_a_ticket" | "invalid_code"; message: string };

export type ScannedQrValidation =
  | { ok: true; qr: string }
  | { ok: false; reason: "empty" | "not_a_ticket"; message: string };

/** Strict check for a 60-character `ET1:` Crockford base32 ticket QR token. */
export function isTicketQrText(text: unknown): text is string {
  return typeof text === "string" && TICKET_QR_RE.test(text);
}

/** Alias matching `src/lib/tickets/token.ts`. */
export const looksLikeTicketToken = isTicketQrText;

/**
 * Validates a decoded QR string from the camera before anything is sent to the server.
 * Non-`ET1:` QR codes are rejected locally with `"Not a ticket"`.
 */
export function validateScannedQr(raw: unknown): ScannedQrValidation {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "empty", message: NOT_A_TICKET_MESSAGE };
  }
  if (!TICKET_QR_RE.test(raw)) {
    return { ok: false, reason: "not_a_ticket", message: NOT_A_TICKET_MESSAGE };
  }
  return { ok: true, qr: raw };
}

/**
 * Normalises a manually typed door code: folds case to uppercase, strips spaces and hyphens,
 * and maps `O -> 0` and `I`/`L -> 1`. Returns `null` if the result is not 10 Crockford base32 chars.
 */
export function normalizeDoorCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64 || input.includes("\0")) return null;
  const folded = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replaceAll("O", "0")
    .replaceAll("I", "1")
    .replaceAll("L", "1");
  return DOOR_CODE_RE.test(folded) ? folded : null;
}

/** Formats a normalised 10-character door code as `XXXXX-XXXXX`. */
export function formatDoorCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * Parses input from the manual entry field, which accepts either a 10-character door code
 * (`XXXXX-XXXXX`) or a full `ET1:` token typed by a USB/Bluetooth wedge scanner.
 */
export function parseManualEntry(input: unknown): ManualEntryResult {
  if (typeof input !== "string" || input.includes("\0")) {
    return { kind: "invalid", reason: "empty", message: INVALID_DOOR_CODE_MESSAGE };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return { kind: "invalid", reason: "empty", message: INVALID_DOOR_CODE_MESSAGE };
  }
  if (TICKET_QR_RE.test(trimmed)) {
    return { kind: "qr", qr: trimmed };
  }
  if (trimmed.includes(":") || /^ET[0-9]:/i.test(trimmed)) {
    return { kind: "invalid", reason: "not_a_ticket", message: NOT_A_TICKET_MESSAGE };
  }
  const code = normalizeDoorCode(trimmed);
  if (code) {
    return { kind: "code", code, formatted: formatDoorCode(code) };
  }
  return { kind: "invalid", reason: "invalid_code", message: INVALID_DOOR_CODE_MESSAGE };
}
