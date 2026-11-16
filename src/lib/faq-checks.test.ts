import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type SourceMap, checkFaqAnswer, findLinksAndEmails as findLinksAndEmailsNorm, findPhones as findPhonesNorm, normalizeText, numberTokens as numberTokensNorm, quotedText } from "./faq-checks";

// The scanners take normalised text only (a type error otherwise); these helpers send raw test strings through the front door.
const numberTokens = (s: string, ignore?: Set<string>) => numberTokensNorm(normalizeText(s), ignore);
const findLinksAndEmails = (s: string) => findLinksAndEmailsNorm(normalizeText(s));
const findPhones = (s: string) => findPhonesNorm(normalizeText(s));

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
  it("keeps the currency with the amount: equal digits in different currencies are different prices", () => {
    expect(numberTokens("€10")).not.toEqual(numberTokens("£10"));
    expect(numberTokens("€10")).not.toEqual(numberTokens("10"));
    expect(numberTokens("€10")).not.toEqual(numberTokens("$10"));
    expect(numberTokens("10€")).toEqual(numberTokens("€10"));
    expect(numberTokens("10 euros")).toEqual(numberTokens("€10"));
    expect(numberTokens("10 pounds")).toEqual(numberTokens("£10"));
    expect(numberTokens("$10")).toEqual(numberTokens("10 dollars"));
    const src: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Parking", text: "Parking\nParking costs €10." }]]);
    const chk = (a: string) => checkFaqAnswer({ status: "answered", answer: a, citations: ["F1"] }, src);
    expect(chk("Parking costs £10.").mode).toBe("quoted");
    expect(chk("Parking costs $10.").mode).toBe("quoted");
    expect(chk("Parking costs 10 euros.").mode).toBe("model");
    expect(chk("Parking costs €10.").mode).toBe("model");
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
  });
  it("a link token is captured whole: no character ends it early", () => {
    for (const url of ["https://a.example.com/p~q:r=s&t+u?v#w\\x@y", "a.example.com\\x@y~z", "https://u@a.example.com/x", "www.a.example.com/%2f?q=1&r=2#f"]) {
      expect(findLinksAndEmails(`See ${url}.`).links, url).toEqual([url]);
      expect(findLinksAndEmails(`(${url})`).links, url).toEqual([url]);
    }
    expect(findLinksAndEmails("Write hello@example.org, or john.smith@example.org.").emails).toEqual(["hello@example.org", "john.smith@example.org"]);
    expect(findLinksAndEmails("Write hello@example.org, or john.smith@example.org.").links).toEqual([]);
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

describe("links: an answer link must equal a source link", () => {
  const mk = (text: string): SourceMap => new Map([["F1", { id: "F1", kind: "faq", label: "Links", text: `Links\n${text}` }]]);
  const run = (source: string, answer: string) => checkFaqAnswer({ status: "answered", answer, citations: ["F1"] }, mk(source));
  const caught = (source: string, answer: string) => expect(run(source, answer), answer).toMatchObject({ mode: "quoted", answer: null, flags: expect.arrayContaining(["unsupported_link"]) });
  const fine = (source: string, answer: string) => expect(run(source, answer), answer).toMatchObject({ mode: "model", flags: [] });
  const SRC = "Buy at https://tickets.example.com/EventPass today.";

  it("a link echoed exactly passes; so does the same link without its scheme", () => {
    fine(SRC, "Buy at https://tickets.example.com/EventPass today.");
    fine(SRC, "Buy at tickets.example.com/EventPass today.");
    fine("Buy at tickets.example.com/EventPass today.", "Buy at tickets.example.com/EventPass today.");
  });
  it("scheme and host are case-insensitive; one trailing slash and trailing sentence punctuation do not matter", () => {
    fine(SRC, "Buy at HTTPS://TICKETS.Example.COM/EventPass today.");
    fine(SRC, "Buy at https://tickets.example.com/EventPass/ today.");
    fine("Buy at https://tickets.example.com/EventPass/ today.", "Buy at https://tickets.example.com/EventPass today.");
    fine(SRC, "Buy at https://tickets.example.com/EventPass.");
    fine(SRC, "Buy (https://tickets.example.com/EventPass), or later.");
    fine(SRC, "Is it https://tickets.example.com/EventPass?");
  });
  it("a changed path, query or fragment is refused (case included)", () => {
    caught(SRC, "Buy at https://tickets.example.com/eventpass today.");
    caught(SRC, "Buy at https://tickets.example.com/EventPass/extra today.");
    caught("Buy at https://tickets.example.com/buy?tier=VIP#Seats today.", "Buy at https://tickets.example.com/buy?tier=vip#Seats today.");
    caught("Buy at https://tickets.example.com/buy?tier=VIP#Seats today.", "Buy at https://tickets.example.com/buy?tier=VIP#seats today.");
    caught("Buy at https://tickets.example.com/?tier=VIP today.", "Buy at tickets.example.com?tier=General today.");
    caught("Buy at https://tickets.example.com/#Seats today.", "Buy at tickets.example.com#Other today.");
    caught("Buy at https://tickets.example.com/Event?tier=VIP today.", "Buy at https://tickets.example.com/Event today.");
    caught("Buy at https://tickets.example.com/Event#Seats today.", "Buy at https://tickets.example.com/Event today.");
  });
  it("nothing is repaired into equality: percent-case, default port, www, decoding", () => {
    caught("Files at https://tickets.example.com/files/a%2Fb today.", "Files at https://tickets.example.com/files/a%2fb today.");
    caught("Files at https://tickets.example.com/files/a%2Fb today.", "Files at https://tickets.example.com/files/a/b today.");
    caught(SRC, "Buy at https://tickets.example.com:443/EventPass today.");
    caught(SRC, "Buy at https://www.tickets.example.com/EventPass today.");
    caught(SRC, "Buy at www.tickets.example.com/EventPass today.");
    caught("Buy at https://www.tickets.example.com/EventPass today.", "Buy at https://tickets.example.com/EventPass today.");
  });
  it("http never stands in for https; a stated scheme must be the source's", () => {
    caught(SRC, "Buy at http://tickets.example.com/EventPass today.");
    caught("Buy at http://old.example.com/Plain today.", "Buy at https://old.example.com/Plain today.");
    fine("Buy at http://old.example.com/Plain today.", "Buy at http://old.example.com/Plain today.");
    caught("Buy at tickets.example.com/EventPass today.", "Buy at https://tickets.example.com/EventPass today.");
  });
  it("a different host is refused", () => {
    caught(SRC, "Buy at https://tickets.example.org/EventPass today.");
    caught(SRC, "Buy at https://evil.test/EventPass today.");
  });

  it("a backslash redirect is not equal to anything (browsers read \\ as /)", () => {
    caught(SRC, "Buy at https://tickets.example.com\\@evil.test/EventPass today.");
    caught("Buy at tickets.example.com today.", "Buy at https://tickets.example.com\\..\\admin today.");
    caught(SRC, "Buy at https://tickets.example.com\\EventPass today.");
    caught("Buy at tickets.example.com today.", "Buy at tickets.example.com\\refund-form today.");
    caught("Buy at tickets.example.com/EventPass today.", "Buy at www.tickets.example.com\\EventPass today.");
  });
  it("credentials before the host are not equal to the source link, even next to a source email (the shipped fixture's shape)", () => {
    caught(SRC, "Buy at https://evil.test@tickets.example.com/EventPass today.");
    caught("Email hello@austinproductmeetup.example.", "Refunds at https://hello@austinproductmeetup.example/refund-form today.");
    fine("Email hello@austinproductmeetup.example.", "Email hello@austinproductmeetup.example.");
  });
  it("only the path's trailing slash may differ; a slash inside a query or fragment is data", () => {
    const S = "Go to https://tickets.example.com/?return=/VIP/ today.";
    caught(S, "Go to https://tickets.example.com/?return=/VIP today.");
    caught("Go to https://tickets.example.com/?return=/VIP today.", "Go to https://tickets.example.com/?return=/VIP/ today.");
    caught("Go to https://tickets.example.com/#/VIP/ today.", "Go to https://tickets.example.com/#/VIP today.");
    fine(S, "Go to https://tickets.example.com/?return=/VIP/ today.");
    fine(S, "Go to tickets.example.com?return=/VIP/ today."); // the path's own "/" before the query may be left out
    fine("Go to https://tickets.example.com/EventPass/ today.", "Go to https://tickets.example.com/EventPass today.");
  });
  it("a prefix of a longer link never stands in for it, whatever character the cut lands on", () => {
    for (const sep of ["~", ":", "=", "&", "+", "@", "?", "#", "\\"]) {
      const full = `https://tickets.example.com/Event${sep}Pass`;
      caught(`Buy at ${full} today.`, "Buy at https://tickets.example.com/Event today.");
      caught(`Buy at ${full} today.`, "Buy at tickets.example.com/Event today.");
      fine(`Buy at ${full} today.`, `Buy at ${full} today.`);
    }
  });
  it("a domain anywhere inside a whitespace token is found, not only at its start", () => {
    for (const [src, tok] of [
      ["refunds:evil.test/claim-your-money", "evil.test/claim-your-money"],
      ["Tickets:evil.test/EventPass", "evil.test/EventPass"],
      ["tickets\u2014evil.test/EventPass", "evil.test/EventPass"],
      ["see/evil.test/EventPass", "evil.test/EventPass"],
      ["see(evil.test/EventPass", "evil.test/EventPass"],
      ["xhttps://evil.test/EventPass", "xhttps://evil.test/EventPass"], // a glued scheme is one token, never equal to a source link
    ] as const) {
      expect(findLinksAndEmails(`Go ${src}.`).links, src).toEqual([tok]);
    }
    const dbl = findLinksAndEmails("Write hello@known.example@evil.test now");
    expect(dbl.emails).toEqual(["hello@known.example"]);
    expect(dbl.links).toEqual(["hello@known.example@evil.test", "evil.test"]); // the glued tail is checked as a link, and the domain inside it too
  });
  it("hosts in any script are seen: an IDN host or TLD cannot slip past unchecked", () => {
    caught(SRC, "Buy at \u0442\u0435\u0441\u0442.\u0440\u0444/pay today.");
    caught(SRC, "Buy at b\u00fccher.example/pay today.");
    caught(SRC, "Buy at \u4f8b\u3048.jp today.");
    caught(SRC, "Buy at evil\u3002test/pay today."); // ideographic full stop
    caught(SRC, "Buy at evil\u200b.test/pay today."); // zero-width space inside the host
    caught(SRC, "Buy at evil.te\u00adst/pay today."); // soft hyphen
    expect(findLinksAndEmails("Buy at \u0442\u0435\u0441\u0442.\u0440\u0444/pay today.").links).toEqual(["\u0442\u0435\u0441\u0442.\u0440\u0444/pay"]);
  });
  it("a decoy after the domain cannot hide it; a dotless scheme host is still a link", () => {
    caught(SRC, "Buy at evil.test-x/x#tickets.example.com/EventPass today.");
    caught(SRC, "Buy at https://evil/EventPass today.");
    caught(SRC, "Buy at ftp://localhost/EventPass today.");
    caught(SRC, "Buy at See\u200bhttp://evil today.");
  });
  it("a domain hidden inside a token is refused as an ungrounded link (seven bypasses of 86a39b1)", () => {
    const FX = "Refunds\nEmail hello@austinproductmeetup.example.";
    caught(FX, "Refunds are handled at refunds:evil.test/claim-your-money.");
    caught(FX, "Write to hello@austinproductmeetup.example@evil.test for refunds.");
    caught(SRC, "Buy at Tickets:evil.test/EventPass today.");
    caught(SRC, "Buy at tickets\u2014evil.test/EventPass today.");
    caught(SRC, "Buy at see/evil.test/EventPass today.");
    caught(SRC, "Buy at see(evil.test/EventPass today.");
    caught(SRC, "Buy at xhttps://evil.test/EventPass today.");
    caught(SRC, "Buy at https://tickets.example.com/EventPass @evil.test/x today.");
    caught(SRC, "Buy at https://tickets.example.com/EventPass\u00a0evil.test/x today.");
    caught(SRC, "Buy at hello@known.example@evil.test today.");
    fine(SRC, "Buy at https://tickets.example.com/EventPass (tickets.example.com/EventPass) today.");
  });
  it("an answer echoing a Windows path is not a link problem", () => {
    const r = run("Run C:\\Program Files\\setup.exe to install.", "Run C:\\Program Files\\setup.exe to install.");
    expect(r.flags).not.toContain("unsupported_link");
    expect(r.mode).toBe("model");
  });
});

describe("the normalisation front door", () => {
  const SRC = "Parking is $10. Doors open at 9:30 PM CST on December 4. Call 512-555-9999. Refunds up to 2 hours.\nTickets at https://زيتون.example/pay and السلام.example.";
  const map: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: `Q\n${SRC}` }]]);
  const run = (answer: string) => checkFaqAnswer({ status: "answered", answer, citations: ["F1"] }, map);

  it("digits in any script are read as the number they are: a different value is refused, the same value passes", () => {
    for (const bad of [
      "Parking is ＄１００.", // fullwidth $100
      "Parking is $١٠٠.", // Arabic-Indic 100
      "Parking is $१००.", // Devanagari 100
      "Parking is $¹⁰⁰.", // superscript 100
      "Parking is $①⓪⓪.", // circled 100
      "Parking is $ⅩⅩ.", // roman numeral X X = "1010"
      "Parking is $Ⅽ.", // roman numeral C = 100
      "Doors open at ９:３０ AM CST.",
      "Doors open at ٩:٣٠ AM CST.",
      "Doors on December ４４.",
      "Call ５１２-５５５-９９８９.",
      "Call ٥١٢-٥٥٥-٩٩٩٨.",
      "Refunds up to ２２ hours.",
      "Refunds up to 〇 hours.", // an ideographic zero: kept as itself, so it is not in the source
    ]) {
      expect(run(bad), bad).toMatchObject({ mode: "quoted", answer: null });
    }
    for (const good of [
      "Parking is ＄１０.",
      "Parking is $١٠.",
      "Parking is $१०.",
      "Parking is $Ⅹ.",
      "Doors open at ９:３０ PM CST on December ４.",
      "Call ٥١٢-٥٥٥-٩٩٩٩.",
      "Refunds up to ２ hours.",
    ]) {
      expect(run(good).mode, good).toBe("model");
    }
  });

  it("every Unicode decimal digit folds to the ASCII digit ICU says it is", () => {
    const systems = Intl.supportedValuesOf("numberingSystem");
    let checked = 0;
    for (const nu of systems) {
      const fmt = new Intl.NumberFormat(`en-u-nu-${nu}`, { useGrouping: false });
      const glyphs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => fmt.format(n));
      if (!glyphs.every((g) => /^\p{Nd}$/u.test(g))) continue; // algorithmic systems (roman, han) are not digit runs
      glyphs.forEach((g, n) => {
        expect(normalizeText(g), `${nu} ${n}`).toBe(String(n));
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(300);
    // and no decimal digit anywhere is left unfolded
    for (let cp = 0x80; cp < 0x1ffff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (/\p{Nd}/u.test(ch)) expect(normalizeText(ch), cp.toString(16)).toMatch(/^[0-9]$/);
    }
  });

  it("a path or query is compared as written: compatibility and invisible characters in it are not folded away", () => {
    const m: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: "Q\nBuy at https://tickets.example.com/VIP?id=12 today." }]]);
    const r = (a: string) => checkFaqAnswer({ status: "answered", answer: a, citations: ["F1"] }, m);
    expect(r("Buy at https://tickets.example.com/VIP?id=12 today.").mode).toBe("model");
    for (const bad of [
      "Buy at https://tickets.example.com/\uff36\uff29\uff30?id=12 today.", // fullwidth VIP (Codex's case)
      "Buy at https://tickets.example.com/VIP\u200b?id=12 today.", // zero-width space in the path
      "Buy at https://tickets.example.com/V\u00adIP?id=12 today.", // soft hyphen
      "Buy at https://tickets.example.com/VIP?id=\uff11\uff12 today.", // fullwidth digits in the query
      "Buy at https://tickets.example.com/VIP?id=\u0661\u0662 today.",
      "Buy at tickets.example.com/\uff36\uff29\uff30?id=12 today.",
    ]) {
      expect(r(bad), bad).toMatchObject({ mode: "quoted", answer: null, flags: expect.arrayContaining(["unsupported_link"]) });
    }
    // the host is still read as a browser reads it: an invisible character in the host is the same host
    expect(r("Buy at https://tickets.example\u200b.com/VIP?id=12 today.").mode).toBe("model");
  });

  it("ZWNJ and ZWJ are kept (IDNA keeps them: they change the host); other format characters are dropped", () => {
    expect(normalizeText("a‌b‍c")).toBe("a‌b‍c");
    expect(normalizeText("a​b­c﻿d⁠e")).toBe("abcde");
    expect(normalizeText("evil。test Ａ")).toBe("evil.test A");
    const host = "زيتون.example";
    expect(run(`Tickets at https://${host}/pay.`).mode).toBe("model");
    expect(run(`Tickets at https://زيتو‌ن.example/pay.`)).toMatchObject({ mode: "quoted", flags: expect.arrayContaining(["unsupported_link"]) });
    expect(run("Tickets at https://زيتو‍ن.example/pay.").mode).toBe("quoted");
    expect(run("Write evil‌.test now.").mode).toBe("quoted");
    expect(run("Tickets at https://زيتو​ن.example/pay.").mode).toBe("model"); // ZWSP is dropped: the same host
  });

  it("no scanner reads raw text: they only accept Norm, and nothing else normalises", () => {
    // compile-time: a raw string is a type error (checked by `pnpm typecheck`)
    // @ts-expect-error scanners accept normalised text only
    expect(() => numberTokensNorm("7pm")).not.toThrow();
    // @ts-expect-error scanners accept normalised text only
    expect(() => findPhonesNorm("512-555-0100")).not.toThrow();
    // @ts-expect-error scanners accept normalised text only
    expect(() => findLinksAndEmailsNorm("a.example")).not.toThrow();
    // module boundary: every exported scanner is declared over Norm, and the only normalisation calls live in the front door
    const code = readFileSync(new URL("./faq-checks.ts", import.meta.url), "utf8");
    for (const fn of ["findLinksAndEmails", "findPhones", "numberTokens"]) expect(code, fn).toMatch(new RegExp(`export function ${fn}\\(\\w+: Norm`));
    expect(code.match(/\.normalize\(/g)).toHaveLength(1);
    expect(code.match(/\\p\{Cf\}/g)).toHaveLength(1);
    const door = code.slice(code.indexOf("export function normalizeText"), code.indexOf("// ----", code.indexOf("export function normalizeText")));
    expect(door).toContain(".normalize(");
    expect(door).toContain("\\p{Cf}");
  });
});
