import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveKey } from "@/lib/tickets/keys";

/**
 * The signed ticket QR and the typed door code (spec "Tickets and QR codes").
 *
 * QR payload: bytes `0x01 || ticketId (16 bytes) || qr_epoch (uint16 BE)`, then
 * `mac = HMAC-SHA256(kQr, "ET1" || bytes)` cut to 16 bytes (128 bits). Text = `ET1:` + Crockford base32 of
 * `bytes || mac` (35 bytes = 280 bits = exactly 56 characters, no padding), 60 characters, every one in the QR
 * alphanumeric set. No name, email, event id or URL: a stranger who photographs the code learns nothing, and
 * nothing personal lands in a log or a browser history.
 *
 * A valid MAC proves only that THIS server minted the ticket id and epoch. Whether the ticket may be used (its event,
 * status, current epoch, already checked in) is decided by the database on every scan, so revocation is instant.
 * Never log a token or a door code.
 */

const VERSION = 0x01;
const PREFIX = "ET1:";
const MAC_BYTES = 16;
/** Crockford base32: no I, L, O or U. Uppercase, so the whole text stays inside the QR alphanumeric set. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN_RE = /^ET1:[0-9A-HJKMNP-TV-Z]{56}$/;
const DOOR_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Crockford base32 of `bytes` (no padding; callers pass lengths that fill whole characters or accept the zero-padded tail). */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** Inverse of `base32Encode` for strings whose length fills whole bytes (56 characters = 35 bytes). Null on any other character. */
export function base32Decode(text: string): Buffer | null {
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

function idBytes(ticketId: string): Buffer {
  const id = ticketId.toLowerCase();
  if (!UUID_RE.test(id)) throw new Error("ticket id must be a uuid");
  return Buffer.from(id.replaceAll("-", ""), "hex");
}

function idString(bytes: Uint8Array): string {
  const h = Buffer.from(bytes).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function epochBytes(epoch: number): Buffer {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > 0xffff) throw new Error("epoch out of range");
  const b = Buffer.alloc(2);
  b.writeUInt16BE(epoch);
  return b;
}

const mac = (payload: Buffer) => createHmac("sha256", deriveKey("ticket-qr:v1")).update("ET1").update(payload).digest().subarray(0, MAC_BYTES);

/** The QR text for a ticket at an epoch: 60 characters, `ET1:` + base32. */
export function signTicket(ticketId: string, epoch: number): string {
  const payload = Buffer.concat([Buffer.from([VERSION]), idBytes(ticketId), epochBytes(epoch)]);
  return PREFIX + base32Encode(Buffer.concat([payload, mac(payload)]));
}

/** Does this look like a ticket token (the strict shape check the scanner and the door route apply before anything else)? */
export const looksLikeTicketToken = (text: string): boolean => TOKEN_RE.test(text);

/**
 * Check a scanned text. Returns the ticket id and epoch it was minted for, or null for anything else (wrong shape,
 * wrong version, bad MAC). The MAC compare is constant-time. The caller must still check the database: this proves
 * only that the server signed it.
 */
export function verifyTicketToken(text: unknown): { ticketId: string; epoch: number } | null {
  if (typeof text !== "string" || !TOKEN_RE.test(text)) return null;
  const raw = base32Decode(text.slice(PREFIX.length));
  if (!raw || raw.length !== 1 + 16 + 2 + MAC_BYTES) return null;
  const payload = raw.subarray(0, 19);
  const given = raw.subarray(19);
  const ok = timingSafeEqual(mac(payload), given);
  if (!ok || payload[0] !== VERSION) return null;
  return { ticketId: idString(payload.subarray(1, 17)), epoch: payload.readUInt16BE(17) };
}

/** The raw 10-character door code: the first 50 bits of `HMAC-SHA256(kDoor, ticketId || epoch)`, Crockford base32. */
export function doorCodeFor(ticketId: string, epoch: number): string {
  const h = createHmac("sha256", deriveKey("door-code:v1")).update(idBytes(ticketId)).update(epochBytes(epoch)).digest();
  return base32Encode(h.subarray(0, 7)).slice(0, 10);
}

/** `XXXXX-XXXXX`, as shown under the QR. */
export const formatDoorCode = (code: string): string => `${code.slice(0, 5)}-${code.slice(5)}`;

/**
 * What a person typed, as a raw door code: case folded, spaces and hyphens dropped, `O` read as 0 and `I`/`L` as 1.
 * Null when what is left isn't ten characters of the alphabet.
 */
export function normalizeDoorCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const folded = input.toUpperCase().replace(/[\s-]/g, "").replaceAll("O", "0").replaceAll("I", "1").replaceAll("L", "1");
  return DOOR_CODE_RE.test(folded) ? folded : null;
}

/** What the database stores and the door looks codes up by: `HMAC-SHA256(kDoorIdx, code)` over the raw code (keyed, never a bare hash). */
export function doorCodeDigest(code: string): Buffer {
  return createHmac("sha256", deriveKey("door-index:v1")).update(code).digest();
}

/** Both door values for a ticket at an epoch: the code to show and the digest to store. */
export function doorFor(ticketId: string, epoch: number): { code: string; digest: Buffer } {
  const code = doorCodeFor(ticketId, epoch);
  return { code, digest: doorCodeDigest(code) };
}
