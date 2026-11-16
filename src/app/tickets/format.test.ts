import { describe, expect, it } from "vitest";
import { formatEventWhen, formatWhere, splitTickets, wrapText } from "./format";

describe("splitTickets", () => {
  const now = Date.parse("2026-06-15T18:00:00.000Z");
  const ticket = (endsAt: string) => ({ id: endsAt, event: { endsAt: new Date(endsAt) } });

  it("keeps an event that is still running in upcoming, and preserves order", () => {
    const rows = [ticket("2026-06-15T18:00:00.000Z"), ticket("2026-06-15T17:59:59.000Z"), ticket("2026-07-01T00:00:00.000Z")];
    const { upcoming, past } = splitTickets(rows, now);
    expect(upcoming.map((row) => row.id)).toEqual(["2026-06-15T18:00:00.000Z", "2026-07-01T00:00:00.000Z"]);
    expect(past.map((row) => row.id)).toEqual(["2026-06-15T17:59:59.000Z"]);
  });
});

describe("formatEventWhen", () => {
  it("uses the event time zone for a same-day range", () => {
    const text = formatEventWhen(new Date("2026-06-15T23:00:00.000Z"), new Date("2026-06-16T01:30:00.000Z"), "America/Chicago");
    expect(text).toMatch(/Mon, Jun 15, 2026, 6:00 PM – 8:30 PM CDT/);
  });

  it("shows both dates when the event crosses midnight in that zone", () => {
    const text = formatEventWhen(new Date("2026-01-15T04:00:00.000Z"), new Date("2026-01-15T18:00:00.000Z"), "America/Chicago");
    expect(text).toMatch(/Wed, Jan 14, 2026, 10:00 PM/);
    expect(text).toMatch(/Thu, Jan 15, 2026, 12:00 PM/);
    expect(text).toMatch(/CST/);
  });
});

describe("formatWhere", () => {
  it("joins the venue and address, and skips a blank address", () => {
    expect(formatWhere("Smoke Hall", "1 Main St")).toBe("Smoke Hall, 1 Main St");
    expect(formatWhere("Smoke Hall", "  ")).toBe("Smoke Hall");
  });
});

describe("wrapText", () => {
  const measure = (sample: string) => sample.length;

  it("wraps on spaces and splits a 60-character word", () => {
    expect(wrapText("short words here", 10, measure)).toEqual(["short", "words here"]);
    const word = "A".repeat(60);
    const lines = wrapText(word, 20, measure);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.length <= 20)).toBe(true);
    expect(lines.join("")).toBe(word);
  });
});
