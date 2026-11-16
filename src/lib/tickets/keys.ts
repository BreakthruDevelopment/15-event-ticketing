import "server-only";
import { hkdfSync } from "node:crypto";
import { env } from "@/lib/env";

/**
 * The one place keys are derived from `BETTER_AUTH_SECRET` (HKDF-SHA256, fixed salt, one distinct `info` per use, so
 * a key for one purpose is useless for another). Add a new purpose here, never derive inline. Rotating the secret
 * invalidates everything derived from it: open staff-invite links stop working (the token is re-derived from the key
 * and no longer matches the stored digest); the organiser creates new invites; EVERY ticket QR and door code stops
 * verifying (attendees reissue; the README says so).
 *
 * Ticket purposes (src/lib/tickets/token.ts): `ticket-qr:v1` signs the QR token, `door-code:v1` derives the typed
 * door code, `door-index:v1` keys the digest the door looks codes up by (so a database dump alone can't be used to
 * brute-force the 50-bit codes offline).
 */
const SALT = "breakthru:15-event-ticketing";

export type KeyPurpose = "staff-invite:v1" | "ticket-qr:v1" | "door-code:v1" | "door-index:v1";

const cache = new Map<string, Buffer>();

/** A 32-byte key for the purpose, derived once per process. */
export function deriveKey(purpose: KeyPurpose): Buffer {
  let k = cache.get(purpose);
  if (!k) {
    k = Buffer.from(hkdfSync("sha256", env().BETTER_AUTH_SECRET, SALT, purpose, 32));
    cache.set(purpose, k);
  }
  return k;
}
