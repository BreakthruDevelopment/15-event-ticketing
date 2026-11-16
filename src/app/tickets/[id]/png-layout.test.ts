import { describe, expect, it } from "vitest";
import { qrSvg } from "@/lib/tickets/qr";
import { PNG_QR, layoutTicket, prefersShareSheet, svgModuleRuns, ticketPngFilename, ticketQrMarkup } from "./png-layout";

const TEXT = "ET1:" + "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQ";

describe("ticket QR markup", () => {
  it("keeps qrSvg output and refuses anything else", () => {
    const svg = qrSvg(TEXT);
    expect(ticketQrMarkup(svg)).toBe(svg);
    expect(svg).not.toContain(TEXT);
    const runs = svgModuleRuns(svg);
    expect(runs.length).toBeGreaterThan(50);
    expect(Math.min(...runs.map((run) => run.x), ...runs.map((run) => run.y))).toBeGreaterThanOrEqual(4);
    expect(ticketQrMarkup("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>")).toBeNull();
    expect(ticketQrMarkup("<div></div>")).toBeNull();
    expect(ticketQrMarkup(`${svg}<script></script>`)).toBeNull();
  });
});

describe("ticketPngFilename", () => {
  it("uses the event title and drops characters that do not belong in a file name", () => {
    expect(ticketPngFilename("Austin Product Meetup")).toBe("Austin-Product-Meetup.png");
    expect(ticketPngFilename("  ")).toBe("ticket.png");
    expect(ticketPngFilename("A/B:C")).toBe("ABC.png");
    expect(ticketPngFilename(`${"VeryLong".repeat(20)}`)).toMatch(/^[\w-]+\.png$/);
    expect(ticketPngFilename("x".repeat(80)).length).toBeLessThanOrEqual(64);
  });
});

describe("prefersShareSheet", () => {
  it("is the iOS path, including iPadOS desktop mode, and not Android Chrome", () => {
    expect(prefersShareSheet({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" })).toBe(true);
    expect(prefersShareSheet({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
    expect(prefersShareSheet({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel) Chrome/120.0.0.0", platform: "Linux armv8l", maxTouchPoints: 5 })).toBe(false);
    expect(prefersShareSheet({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
  });
});

describe("layoutTicket", () => {
  const measure = (sample: string) => sample.length * 10;

  it("places a QR at least 240px wide and wraps a 60-character title", () => {
    const title = "T".repeat(60);
    const layout = layoutTicket(
      {
        eventTitle: title,
        when: "Mon, Jun 15, 2026, 6:00 PM – 8:30 PM CDT",
        where: "Smoke Hall, 1 Main St",
        holderName: "H".repeat(60),
        guestLabel: "Guest 2",
        ticketTypeName: "General",
        doorCode: "01234-56789",
      },
      measure,
    );
    const qr = layout.ops.find((op) => op.op === "qr");
    expect(qr).toMatchObject({ size: PNG_QR });
    expect(PNG_QR).toBeGreaterThanOrEqual(240);
    const texts = layout.ops.filter((op) => op.op === "text").map((op) => (op.op === "text" ? op.text : ""));
    expect(texts.join("")).toContain(title);
    expect(texts).toContain("01234-56789");
    expect(texts.filter((line) => /^H+$/.test(line)).join("")).toBe("H".repeat(60));
    expect(texts.filter((line) => /^T+$/.test(line)).join("")).toBe(title);
    expect(layout.height).toBeGreaterThan(PNG_QR);
    expect(texts.every((line) => measure(line) <= layout.width)).toBe(true);
  });
});
