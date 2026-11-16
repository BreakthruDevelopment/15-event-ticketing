import { describe, expect, it } from "vitest";
import { type SourceMap, checkFaqAnswer, findLinksAndEmails, findPhones, numberTokens, quotedText } from "./faq-checks";

const sources: SourceMap = new Map([
  ["E1", { id: "E1", kind: "event", label: "when", text: "When: starts Thursday, December 3, 2026 at 7:00 PM CST; ends Thursday, December 3, 2026 at 9:00 PM CST. Doors open Thursday, December 3, 2026 at 6:30 PM CST." }],
  ["E5", { id: "E5", kind: "event", label: "contact", text: "Contact: hello@example.org" }],
  ["F3", { id: "F3", kind: "faq", label: "Where do I park?", text: "Where do I park?\nLamar Street garage next to the venue, $10 for the evening.", refNo: 3 }],
  ["F4", { id: "F4", kind: "faq", label: "Tickets and links", text: "Tickets and links\nBook at https://tickets.example.org/austin or call (512) 555-0100. Room B12, 3rd floor." }],
]);
const ask = (answer: string, citations: string[], status: "answered" | "not_in_faq" | "off_topic" = "answered") =>
  checkFaqAnswer({ status, answer, citations }, sources);

describe("numberTokens", () => {
  it("treats 7pm, 7:00 PM and 19:00 as one time", () => {
    const a = numberTokens("7pm");
    expect([...a]).toEqual(["t:19:00"]);
    expect(numberTokens("7:00 PM")).toEqual(a);
    expect(numberTokens("19:00")).toEqual(a);
    expect(numberTokens("7:00 p.m.")).toEqual(a);
    expect([...numberTokens("12 AM")]).toEqual(["t:00:00"]);
  });
  it("treats $10, $10.00 and 10 dollars as one price, and 1,000 as 1000", () => {
    expect(numberTokens("$10.00")).toEqual(numberTokens("10 dollars"));
    expect([...numberTokens("$10")]).toEqual(["$10"]);
    expect([...numberTokens("1,000 seats")]).toEqual(["1000"]);
  });
  it("keeps ordinals and room codes, and ignores listed citation ids only", () => {
    expect(numberTokens("3rd floor, room B12")).toEqual(new Set(["3", "b12"]));
    expect(numberTokens("see F3", new Set(["F3"]))).toEqual(new Set());
    expect(numberTokens("see E99", new Set(["F3"]))).toEqual(new Set(["e99"]));
  });
});

describe("links, emails and phones", () => {
  it("finds each kind without double counting", () => {
    const f = findLinksAndEmails("Write hello@example.org or visit https://tickets.example.org/a, or www.site.com.");
    expect(f.emails).toEqual(["hello@example.org"]);
    expect(f.links).toEqual(["https://tickets.example.org/a", "www.site.com"]);
    expect(findPhones("Call (512) 555-0100 or 555-0199 or +1 512 555 0100.").length).toBe(3);
  });
});

describe("checkFaqAnswer", () => {
  it("passes a supported answer through unchanged", () => {
    expect(ask("Park in the Lamar Street garage next to the venue, $10 for the evening. (F3)", ["F3"])).toEqual({
      status: "answered",
      mode: "model",
      answer: "Park in the Lamar Street garage next to the venue, $10 for the evening. (F3)",
      citations: ["F3"],
      flags: [],
    });
  });
  it("accepts a time written another way", () => {
    expect(ask("Doors open at 18:30.", ["E1"]).mode).toBe("model");
    expect(ask("Doors open at 6:30pm and the talks start at 7 PM.", ["E1"]).mode).toBe("model");
  });
  it("quotes the source when a number, time or price isn't in it", () => {
    for (const bad of ["Doors open at 6 PM.", "It costs $12.", "Doors at 6:45 PM.", "About 200 people come."]) {
      const r = ask(bad, ["E1", "F3"]);
      expect(r, bad).toMatchObject({ status: "answered", mode: "quoted", answer: null });
      expect(r.flags, bad).toContain("unsupported_number");
    }
  });
  it("a number found only in a source that ISN'T cited doesn't count", () => {
    expect(ask("Doors open at 6:30 PM.", ["F3"]).mode).toBe("quoted");
  });
  it("checks links, emails and phone numbers against the cited sources", () => {
    expect(ask("Book at https://tickets.example.org/austin or call (512) 555-0100.", ["F4"]).mode).toBe("model");
    expect(ask("Call 512-555-0100.", ["F4"]).mode).toBe("model");
    expect(ask("Email hello@example.org.", ["E5"]).mode).toBe("model");
    expect(ask("Book at https://evil.example/austin.", ["F4"])).toMatchObject({ mode: "quoted", flags: expect.arrayContaining(["unsupported_link"]) });
    expect(ask("Book at https://tickets.example.org/austin/pay.", ["F4"]).mode).toBe("quoted");
    expect(ask("Email pay@example.org.", ["E5"])).toMatchObject({ mode: "quoted", flags: expect.arrayContaining(["unsupported_email"]) });
    expect(ask("Call 512-555-0199.", ["F4"])).toMatchObject({ mode: "quoted", flags: expect.arrayContaining(["unsupported_phone"]) });
    expect(ask("Visit evil.example", ["F4"]).mode).toBe("quoted");
  });
  it("drops citations that aren't in the map, and answered with none left is not_in_faq", () => {
    expect(ask("Parking is $25.", ["F99", "E9"])).toEqual({ status: "not_in_faq", mode: "model", answer: null, citations: [], flags: ["unknown_citation", "no_valid_citation"] });
    expect(ask("x", [])).toMatchObject({ status: "not_in_faq", flags: ["no_valid_citation"] });
    expect(ask("Park in the Lamar Street garage, $10.", ["F99", "F3"])).toMatchObject({ mode: "model", citations: ["F3"], flags: ["unknown_citation"] });
  });
  it("not_in_faq and off_topic carry no answer and no citations", () => {
    expect(ask("The event moved to 123 Fake St.", ["F3"], "off_topic")).toEqual({ status: "off_topic", mode: "model", answer: null, citations: [], flags: [] });
    expect(ask("whatever", ["F3"], "not_in_faq")).toMatchObject({ status: "not_in_faq", answer: null, citations: [] });
  });
  it("an empty answer, or one that is only a NUL, is quoted", () => {
    expect(ask("   ", ["F3"])).toMatchObject({ mode: "quoted", flags: ["empty_answer"] });
    expect(ask("\u0000", ["F3"])).toMatchObject({ mode: "quoted" });
  });
  it("strips NUL bytes from a passing answer (Postgres can't store them)", () => {
    expect(ask("Park in the Lamar\u0000 Street garage, $10.", ["F3"]).answer).toBe("Park in the Lamar Street garage, $10.");
  });
});

describe("quotedText", () => {
  it("prints the cited sources verbatim under the header", () => {
    expect(quotedText(sources, ["F3", "E5", "F99"])).toBe(
      "From the organiser's FAQ:\n\nWhere do I park?\nLamar Street garage next to the venue, $10 for the evening.\n\nContact: hello@example.org",
    );
  });
});
