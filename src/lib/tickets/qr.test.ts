import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { QR_SIZE, qrMatrix, qrSvg } from "./qr";

const TEXT = "ET1:" + "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQ"; // 60 characters

describe("qrSvg", () => {
  it("is version 3, level M: 29 x 29 modules, and only alphanumeric mode can fit 60 characters there", () => {
    expect(TEXT).toHaveLength(60);
    const m = qrMatrix(TEXT);
    expect(m).toHaveLength(QR_SIZE);
    expect(m.every((row) => row.length === QR_SIZE)).toBe(true);
    const r = encode(TEXT, { ecc: "M", boostEcc: false, minVersion: 3, maxVersion: 3, border: 0 });
    expect(r.version).toBe(3);
    // Version 3-M holds 61 alphanumeric characters but only 42 bytes: the lowercase twin needs byte mode and cannot fit.
    expect(() => encode(TEXT.toLowerCase(), { ecc: "M", boostEcc: false, minVersion: 3, maxVersion: 3, border: 0 })).toThrow();
    // 61 fit, 62 do not.
    expect(() => qrMatrix("A".repeat(61))).not.toThrow();
    expect(() => qrMatrix("A".repeat(62))).toThrow();
  });

  it("refuses text outside the alphanumeric set", () => {
    for (const bad of ["", "abc", "ET1:é", "A\0B", "A#B"]) expect(() => qrSvg(bad), bad).toThrow();
  });

  it("renders black modules on white with a 4-module quiet zone, as an inline SVG with no text of the ticket in it", () => {
    const svg = qrSvg(TEXT);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 37 37"');
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('fill="#000"');
    expect(svg).not.toContain("ET1");
    expect(svg).not.toContain("script");
    // Nothing is drawn inside the quiet zone: every path coordinate starts at >= 4 and ends <= 33.
    const nums = [...svg.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)].map((x) => ({ x: +x[1], y: +x[2], w: +x[3] }));
    expect(nums.length).toBeGreaterThan(50);
    expect(Math.min(...nums.map((n) => n.x), ...nums.map((n) => n.y))).toBeGreaterThanOrEqual(4);
    expect(Math.max(...nums.map((n) => n.x + n.w), ...nums.map((n) => n.y + 1))).toBeLessThanOrEqual(33);
  });

  it("is deterministic and differs per text", () => {
    expect(qrSvg(TEXT)).toBe(qrSvg(TEXT));
    expect(qrSvg(TEXT)).not.toBe(qrSvg(TEXT.slice(0, -1) + "Z"));
  });

  it("draws the finder patterns where the standard puts them", () => {
    const m = qrMatrix(TEXT);
    for (const [r0, c0] of [
      [0, 0],
      [0, QR_SIZE - 7],
      [QR_SIZE - 7, 0],
    ]) {
      for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
        const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3));
        expect(m[r0 + i][c0 + j], `${r0},${c0} ${i},${j}`).toBe(ring !== 2);
      }
    }
  });
});
