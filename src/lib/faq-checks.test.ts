import { describe, expect, it } from "vitest";
import { type SourceMap, canonLink, checkFaqAnswer, findLinksAndEmails, findPhones, numberTokens, quotedText } from "./faq-checks";

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
    expect(findLinksAndEmails("Go to https://Tickets.Example.org/EventPass.").links).toEqual(["https://Tickets.Example.org/EventPass"]);
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

describe("calendar words and number words are facts too", () => {
  const dateSrc: SourceMap = new Map([
    ["E1", { id: "E1", kind: "event", label: "when", text: "When: starts Thursday, December 3, 2026 at 7:00 PM CST. Doors open at 6:30 PM." }],
    ["F2", { id: "F2", kind: "faq", label: "Cost", text: "Cost\nParking is $10. Kids under twelve are free." }],
  ]);
  const chk = (answer: string, ids: string[]) => checkFaqAnswer({ status: "answered", answer, citations: ids }, dateSrc);

  it("a different month, day or weekday is quoted, the right date passes", () => {
    expect(chk("It is on Thursday, December 3, 2026.", ["E1"]).mode).toBe("model");
    expect(chk("It is on Dec 3.", ["E1"]).mode).toBe("model");
    expect(chk("It is on 3 December.", ["E1"]).mode).toBe("model");
    expect(chk("It is on January 3, 2026.", ["E1"])).toMatchObject({ mode: "quoted", flags: ["unsupported_number"] });
    expect(chk("It is on December 4, 2026.", ["E1"]).mode).toBe("quoted");
    expect(chk("It is on Friday, December 3.", ["E1"]).mode).toBe("quoted");
    expect(chk("See you Fri, Dec 3.", ["E1"]).mode).toBe("quoted");
  });
  it("'may' as a verb is not a month", () => {
    expect(chk("You may arrive at 6:30 PM.", ["E1"]).mode).toBe("model");
    expect(chk("It is on May 3.", ["E1"]).mode).toBe("quoted");
  });
  it("number words count as numbers", () => {
    expect(chk("Parking is ten dollars.", ["F2"]).mode).toBe("model");
    expect(chk("Parking is twelve dollars.", ["F2"]).mode).toBe("quoted");
    expect(chk("Parking is ten dollars.", ["E1"]).mode).toBe("quoted");
    expect(chk("Kids under twelve are free.", ["F2"]).mode).toBe("model");
    expect(chk("Kids under thirteen are free.", ["F2"]).mode).toBe("quoted");
    expect([...numberTokens("twenty-five, one hundred twenty, five and ten")].sort()).toEqual(["10", "120", "25", "5"]);
    expect(chk("One of the rooms is free.", ["F2"]).mode).toBe("model");
  });
});

describe("time zones, ambiguous words and number words", () => {
  const src: SourceMap = new Map([
    ["E1", { id: "E1", kind: "event", label: "when", text: "When: starts Thursday, December 3, 2026 at 7:00 PM CST; ends at 9:00 PM CST. Doors open at 6:30 PM CST." }],
    ["E2", { id: "E2", kind: "event", label: "where", text: "Where: Hall. Starts 7:00 PM GMT+5:30." }],
  ]);
  const chk = (answer: string, ids: string[]) => checkFaqAnswer({ status: "answered", answer, citations: ids }, src);

  it("an answer that names a zone must name the source's zone", () => {
    expect(chk("It starts at 7:00 PM CST.", ["E1"]).mode).toBe("model");
    expect(chk("It starts at 7:00 PM Central Time.", ["E1"]).mode).toBe("model");
    expect(chk("It starts at 7:00 PM EST.", ["E1"])).toMatchObject({ mode: "quoted", flags: ["unsupported_number"] });
    expect(chk("It starts at 7:00 PM CDT.", ["E1"]).mode).toBe("quoted");
    expect(chk("It starts at 7:00 PM Eastern Time.", ["E1"]).mode).toBe("quoted");
    expect(chk("It starts at 7:00 PM.", ["E1"]).mode).toBe("model");
  });
  it("offsets are compared too", () => {
    expect(chk("Starts 7:00 PM GMT+5:30.", ["E2"]).mode).toBe("model");
    expect(chk("Starts 7:00 PM UTC +05:30.", ["E2"]).mode).toBe("model");
    expect(chk("Starts 7:00 PM GMT+5.", ["E2"]).mode).toBe("quoted");
    expect(chk("Starts 7:00 PM IST.", ["E2"]).mode).toBe("quoted");
  });
  it("sun, sat, wed and march are words unless they sit next to a date", () => {
    expect(chk("We march in at 6:30 PM and sat down; the sun was out, wed love to see you.", ["E1"]).mode).toBe("model");
    expect(chk("See you Sun 3.", ["E1"]).mode).toBe("quoted");
    expect(chk("See you Wed, December 3.", ["E1"]).mode).toBe("quoted");
    expect(chk("See you Thu, Dec 3.", ["E1"]).mode).toBe("model");
    expect(chk("It is on March 3.", ["E1"]).mode).toBe("quoted");
    expect(chk("It is on 3 March.", ["E1"]).mode).toBe("quoted");
  });
  it("WEST, IST, BST in capitals are zones only right after a time", () => {
    expect(chk("We were told: WEST side entrance at 6:30 PM.", ["E1"]).mode).toBe("model");
    expect(chk("Park on the WEST lot, then walk to IST hall.", ["E1"]).mode).toBe("model");
    expect(chk("It starts at 7:00 PM WEST.", ["E1"]).mode).toBe("quoted");
    expect(chk("It starts at 7 PM BST.", ["E1"]).mode).toBe("quoted");
    expect(numberTokens("7:00 PM IST")).toContain("z:ist");
  });
  it("'one hundred and twenty' is 120; 'five and ten' stays two numbers", () => {
    expect([...numberTokens("one hundred and twenty")]).toEqual(["120"]);
    expect([...numberTokens("two thousand and five")]).toEqual(["2005"]);
    expect([...numberTokens("five and ten")].sort()).toEqual(["10", "5"]);
  });
});

describe("links keep the case of path, query and fragment", () => {
  const map: SourceMap = new Map([
    ["F1", { id: "F1", kind: "faq", label: "Tickets", text: "Tickets\nBuy at https://tickets.example.com/EventPass and VIP at https://tickets.example.com/buy?tier=VIP#Seats or http://old.example.com/Plain or www.Shop.example.com/Go/ or see https://tickets.example.com/files/a%2Fb." }],
    ["F2", { id: "F2", kind: "faq", label: "Bare", text: "Bare\nVisit bare.example.com/Path today." }],
  ]);
  const chk = (answer: string, id = "F1") => checkFaqAnswer({ status: "answered", answer, citations: [id] }, map);
  const caught = (answer: string, id = "F1") => expect(chk(answer, id), answer).toMatchObject({ mode: "quoted", answer: null, flags: expect.arrayContaining(["unsupported_link"]) });
  const fine = (answer: string, id = "F1") => expect(chk(answer, id).mode, answer).toBe("model");

  it("catches a path whose case was changed (the exact case Codex reported)", () => {
    caught("Buy at https://tickets.example.com/eventpass.");
    caught("Buy at https://tickets.example.com/EVENTPASS.");
    fine("Buy at https://tickets.example.com/EventPass.");
  });
  it("catches a changed query value or fragment", () => {
    caught("VIP at https://tickets.example.com/buy?tier=vip#Seats.");
    caught("VIP at https://tickets.example.com/buy?tier=VIP#seats.");
    fine("VIP at https://tickets.example.com/buy?tier=VIP#Seats.");
  });
  it("matches the host case-insensitively", () => {
    fine("Buy at https://TICKETS.Example.COM/EventPass.");
    fine("Buy at HTTPS://tickets.example.com/EventPass.");
    fine("Shop at www.shop.EXAMPLE.com/Go.");
    fine("Shop at https://Bare.example.com/Path.", "F2");
    caught("Shop at https://BARE.example.com/path.", "F2");
  });
  it("percent-encoding: hex digits are case-insensitive, the decoded value is not", () => {
    fine("Files at https://tickets.example.com/files/a%2fb.");
    caught("Files at https://tickets.example.com/files/a/b.");
    caught("Files at https://tickets.example.com/files/A%2Fb.");
  });
  it("a trailing slash and a default port do not matter; another port does", () => {
    fine("Buy at https://tickets.example.com/EventPass/.");
    // (an answer that adds ":443" is still caught by the number check; the link form itself ignores a default port)
    expect(canonLink("https://tickets.example.com:443/EventPass").key).toBe(canonLink("https://tickets.example.com/EventPass").key);
    expect(canonLink("https://tickets.example.com:8443/EventPass").key).not.toBe(canonLink("https://tickets.example.com/EventPass").key);
    caught("Buy at https://tickets.example.com:8443/EventPass.");
    fine("Shop at https://shop.example.com/Go.");
    caught("Shop at https://shop.example.com/Go/x.");
  });
  it("the scheme may be left out but not changed: http never stands in for https", () => {
    fine("Buy at tickets.example.com/EventPass.");
    caught("Buy at http://tickets.example.com/EventPass.");
    fine("Old shop at http://old.example.com/Plain.");
    caught("Old shop at https://old.example.com/plain.");
    fine("Visit https://bare.example.com/Path.", "F2");
    caught("Visit http://bare.example.com/Path.", "F2");
  });
  it("a different host or a longer path is still unsupported", () => {
    caught("Buy at https://tickets.example.org/EventPass.");
    caught("Buy at https://tickets.example.com/EventPass/extra.");
  });
});

describe("a link may not be redirected with a backslash, or cut short", () => {
  const mk = (text: string): SourceMap => new Map([["F1", { id: "F1", kind: "faq", label: "Links", text: `Links\n${text}` }]]);
  const run = (source: string, answer: string) => checkFaqAnswer({ status: "answered", answer, citations: ["F1"] }, mk(source));
  const caught = (source: string, answer: string) => expect(run(source, answer), answer).toMatchObject({ mode: "quoted", answer: null, flags: expect.arrayContaining(["unsupported_link"]) });
  const fine = (source: string, answer: string) => expect(run(source, answer).mode, answer).toBe("model");

  it("a backslash after the host is refused (browsers read it as a path separator)", () => {
    caught("Buy at https://tickets.example.com/EventPass today.", "Buy at https://tickets.example.com\\@evil.test/EventPass today.");
    caught("Buy at tickets.example.com today.", "Buy at https://tickets.example.com\\..\\admin today.");
    caught("Buy at https://tickets.example.com/EventPass today.", "Buy at https://tickets.example.com\\EventPass today.");
  });
  it("a scheme-less link with a backslash is refused too", () => {
    caught("Buy at tickets.example.com today.", "Buy at tickets.example.com\\refund-form today.");
    caught("Buy at tickets.example.com/EventPass today.", "Buy at www.tickets.example.com\\EventPass today.");
  });
  it("credentials in front of the host are refused", () => {
    // the finder reads "evil.test@tickets.example.com" as an email, so it is refused as one; either way it is quoted away
    for (const answer of ["Buy at https://evil.test@tickets.example.com/EventPass today.", "Buy at https://evil@tickets.example.com/EventPass today."]) {
      expect(run("Buy at https://tickets.example.com/EventPass today.", answer), answer).toMatchObject({ mode: "quoted", answer: null });
    }
    expect(canonLink("https://evil@tickets.example.com/EventPass").key).not.toBe(canonLink("https://tickets.example.com/EventPass").key);
  });
  it("canonLink reads a backslash as the slash a browser reads", () => {
    expect(canonLink("https://tickets.example.com\\admin").key).toBe(canonLink("https://tickets.example.com/admin").key);
  });
  it("a prefix of a longer link never stands in for it, whatever character the cut lands on", () => {
    for (const sep of ["~", ":", "=", "&", "+"]) {
      const full = `https://tickets.example.com/Event${sep}Pass`;
      caught(`Buy at ${full} today.`, "Buy at https://tickets.example.com/Event today.");
      caught(`Buy at ${full} today.`, "Buy at tickets.example.com/Event today.");
      fine(`Buy at ${full} today.`, `Buy at ${full} today.`);
    }
  });
  it("a bare domain with a query or fragment but no path is compared in full", () => {
    caught("Buy at https://tickets.example.com/?tier=VIP today.", "Buy at tickets.example.com?tier=General today.");
    caught("Buy at https://tickets.example.com/?tier=VIP today.", "Buy at tickets.example.com/?tier=General today.");
    caught("Buy at https://tickets.example.com/#Seats today.", "Buy at tickets.example.com#Other today.");
    caught("Buy at tickets.example.com?tier=VIP today.", "Buy at tickets.example.com today.");
    fine("Buy at https://tickets.example.com/?tier=VIP today.", "Buy at tickets.example.com?tier=VIP today.");
    fine("Buy at tickets.example.com?tier=VIP today.", "Buy at https://tickets.example.com/?tier=VIP today.");
    expect(findLinksAndEmails("Go to tickets.example.com?tier=VIP.").links).toEqual(["tickets.example.com?tier=VIP"]);
  });
  it("a dropped query or fragment is refused, a kept one is fine", () => {
    caught("Buy at https://tickets.example.com/Event?tier=VIP today.", "Buy at https://tickets.example.com/Event today.");
    caught("Buy at https://tickets.example.com/Event#Seats today.", "Buy at https://tickets.example.com/Event today.");
    caught("Buy at tickets.example.com/Event?tier=VIP today.", "Buy at tickets.example.com/Event today.");
    fine("Buy at https://tickets.example.com/Event?tier=VIP today.", "Buy at https://tickets.example.com/Event?tier=VIP today.");
  });
});
