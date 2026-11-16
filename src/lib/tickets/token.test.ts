import { createHash, createHmac, hkdfSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

const SECRET = "t".repeat(40);

describe("ticket token and door code", () => {
  let T: typeof import("./token");
  const id = "0b9d5a52-3f0e-4c5c-8a7e-2f6f3d9c1e44";

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = SECRET;
    process.env.DATABASE_URL ??= "postgres://unused@localhost/unused";
    T = await import("./token");
  });

  it("round-trips: 60 characters, ET1: prefix, alphanumeric alphabet only", () => {
    const text = T.signTicket(id, 7);
    expect(text).toHaveLength(60);
    expect(text).toMatch(/^ET1:[0-9A-HJKMNP-TV-Z]{56}$/);
    expect(text).toMatch(/^[0-9A-Z :]+$/);
    expect(T.verifyTicketToken(text)).toEqual({ ticketId: id, epoch: 7 });
    expect(T.looksLikeTicketToken(text)).toBe(true);
    // Stable (re-derivable): the attendee sees the same QR every time.
    expect(T.signTicket(id, 7)).toBe(text);
    expect(T.signTicket(id.toUpperCase(), 7)).toBe(text);
  });

  it("the payload is version, ticket id, epoch and MAC only: no name, email or event id", () => {
    const raw = T.base32Decode(T.signTicket(id, 3).slice(4))!;
    expect(raw).toHaveLength(35);
    expect(raw[0]).toBe(1);
    expect(raw.subarray(1, 17).toString("hex")).toBe(id.replaceAll("-", ""));
    expect(raw.readUInt16BE(17)).toBe(3);
    // 1 + 16 + 2 + 16: nothing else fits.
    expect(1 + 16 + 2 + 16).toBe(raw.length);
  });

  it("a flipped bit anywhere (id, epoch, MAC, version) fails verification", () => {
    const raw = T.base32Decode(T.signTicket(id, 5).slice(4))!;
    for (let bit = 0; bit < raw.length * 8; bit++) {
      const copy = Buffer.from(raw);
      copy[bit >> 3] ^= 1 << (7 - (bit & 7));
      expect(T.verifyTicketToken("ET1:" + T.base32Encode(copy)), `bit ${bit}`).toBeNull();
    }
  });

  it("a different epoch or ticket id yields a different token that does not verify as the other", () => {
    const a = T.signTicket(id, 1);
    const b = T.signTicket(id, 2);
    expect(a).not.toBe(b);
    expect(T.verifyTicketToken(b)?.epoch).toBe(2);
    expect(T.signTicket(crypto.randomUUID(), 1)).not.toBe(a);
  });

  it("rejects wrong shapes without throwing", () => {
    const good = T.signTicket(id, 1);
    for (const bad of [
      "",
      good.slice(0, -1),
      good + "0",
      good.toLowerCase(),
      good.replace("ET1:", "ET2:"),
      good.replace(/.$/, "U"),
      good.replace(/.$/, "I"),
      ` ${good}`,
      `${good}\n`,
      `${good}\0`,
      null,
      undefined,
      42,
      {},
    ]) {
      expect(T.verifyTicketToken(bad as string), String(bad)).toBeNull();
    }
  });

  it("a token minted under another secret does not verify", () => {
    // A hand-built token with the right shape and a MAC from a different key.
    const payload = Buffer.concat([Buffer.from([1]), Buffer.from(id.replaceAll("-", ""), "hex"), Buffer.from([0, 1])]);
    const otherKey = Buffer.from(hkdfSync("sha256", "z".repeat(40), "breakthru:15-event-ticketing", "ticket-qr:v1", 32));
    const mac = createHmac("sha256", otherKey).update("ET1").update(payload).digest().subarray(0, 16);
    expect(T.verifyTicketToken("ET1:" + T.base32Encode(Buffer.concat([payload, mac])))).toBeNull();
    // ...and the right key, computed independently of the module, does verify.
    const key = Buffer.from(hkdfSync("sha256", SECRET, "breakthru:15-event-ticketing", "ticket-qr:v1", 32));
    const good = createHmac("sha256", key).update("ET1").update(payload).digest().subarray(0, 16);
    expect(T.verifyTicketToken("ET1:" + T.base32Encode(Buffer.concat([payload, good])))).toEqual({ ticketId: id, epoch: 1 });
  });

  it("door code: 10 Crockford characters from HMAC(kDoor, id || epoch); a new epoch gives a new code", () => {
    const code = T.doorCodeFor(id, 1);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    const key = Buffer.from(hkdfSync("sha256", SECRET, "breakthru:15-event-ticketing", "door-code:v1", 32));
    const h = createHmac("sha256", key).update(Buffer.from(id.replaceAll("-", ""), "hex")).update(Buffer.from([0, 1])).digest();
    expect(code).toBe(T.base32Encode(h.subarray(0, 7)).slice(0, 10));
    expect(T.doorCodeFor(id, 2)).not.toBe(code);
    expect(T.formatDoorCode(code)).toBe(`${code.slice(0, 5)}-${code.slice(5)}`);
  });

  it("the door digest is the keyed HMAC under its own key, never a bare hash and never the QR or door-code key", () => {
    const code = T.doorCodeFor(id, 1);
    const digest = T.doorCodeDigest(code);
    const idx = Buffer.from(hkdfSync("sha256", SECRET, "breakthru:15-event-ticketing", "door-index:v1", 32));
    expect(digest.equals(createHmac("sha256", idx).update(code).digest())).toBe(true);
    expect(digest.equals(createHash("sha256").update(code).digest())).toBe(false);
    for (const purpose of ["ticket-qr:v1", "door-code:v1", "staff-invite:v1"]) {
      const other = Buffer.from(hkdfSync("sha256", SECRET, "breakthru:15-event-ticketing", purpose, 32));
      expect(digest.equals(createHmac("sha256", other).update(code).digest()), purpose).toBe(false);
    }
    expect(T.doorFor(id, 1)).toEqual({ code, digest });
  });

  it("normalises what a person types: case, spaces, hyphens, O -> 0, I and L -> 1", () => {
    expect(T.normalizeDoorCode("abcde-fghjk")).toBe("ABCDEFGHJK");
    expect(T.normalizeDoorCode("  abcde fghjk  ")).toBe("ABCDEFGHJK");
    expect(T.normalizeDoorCode("O0O0O-I1L1l")).toBe("0000011111");
    expect(T.normalizeDoorCode("oiloilOILo")).toBe("0110110110");
    // Round trip through the shown format.
    const code = T.doorCodeFor(id, 4);
    expect(T.normalizeDoorCode(T.formatDoorCode(code).toLowerCase())).toBe(code);
    // Not ten characters of the alphabet.
    for (const bad of ["", "ABCDE", "ABCDEFGHJKM", "ABCDE-FGHJU", "ABCDE-FGH!K", "ABCDE\0FGHJK", "x".repeat(100), null, 5]) {
      expect(T.normalizeDoorCode(bad as string), String(bad)).toBeNull();
    }
    // A typed-wrong code is the same digest as the right one only after normalisation.
    expect(T.doorCodeDigest(T.normalizeDoorCode(T.formatDoorCode(code).toLowerCase())!).equals(T.doorCodeDigest(code))).toBe(true);
  });

  it("base32 round-trips arbitrary bytes", () => {
    for (const n of [5, 10, 35]) {
      const b = Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
      expect(T.base32Decode(T.base32Encode(b))!.equals(b)).toBe(true);
    }
    expect(T.base32Decode("U")).toBeNull();
  });
});
