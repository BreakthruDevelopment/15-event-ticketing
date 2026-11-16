import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type SourceMap, asWritten, checkFaqAnswer, findLinksAndEmails as findLinksAndEmailsView, findPhones as findPhonesView, numberTokens as numberTokensView, numericView, quotedText } from "./faq-checks";
import { currencyNameWords, currencyOfSign, currencyOfWord } from "./currency";
import { NUMERIC_TYPE_RANGES } from "./unicode-numeric.generated";
import { deletedCodePoints, hasNumericValue } from "./unicode-derived";

// Each scanner takes its own branded view of the text (a type error otherwise); these helpers send raw test strings through it.
const numberTokens = (s: string, ignore?: Set<string>) => numberTokensView(numericView(s), ignore);
const findLinksAndEmails = (s: string) => findLinksAndEmailsView(asWritten(s));
const findPhones = (s: string) => findPhonesView(numericView(s));

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

describe("one view per purpose", () => {
  const SRC = "Parking is $10. Doors open at 9:30 PM CST on December 4. Call 512-555-9999. Refunds up to 2 hours.\nTickets at https://\u0632\u064a\u062a\u0648\u0646.example/pay and \u0627\u0644\u0633\u0644\u0627\u0645.example and https://tickets2026.example/vip.";
  const map: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: `Q\n${SRC}` }]]);
  const run = (answer: string) => checkFaqAnswer({ status: "answered", answer, citations: ["F1"] }, map);

  it("digits in any script are read as the number they are: a different value is refused, the same value passes", () => {
    for (const bad of [
      "Parking is \uff04\uff11\uff10\uff10.", // fullwidth $100
      "Parking is $\u0661\u0660\u0660.", // Arabic-Indic 100
      "Parking is $\u0967\u0966\u0966.", // Devanagari 100
      "Parking is $\u00b9\u2070\u2070.", // superscript 100
      "Parking is $\u2460\u24ea\u24ea.", // circled 100
      "Doors open at \uff19:\uff13\uff10 AM CST.",
      "Doors open at \u0669:\u0663\u0660 AM CST.",
      "Doors on December \uff14\uff14.",
      "Call \uff15\uff11\uff12-\uff15\uff15\uff15-\uff19\uff19\uff18\uff19.",
      "Call \u0665\u0661\u0662-\u0665\u0665\u0665-\u0669\u0669\u0669\u0668.",
      "Refunds up to \uff12\uff12 hours.",
    ]) {
      expect(run(bad), bad).toMatchObject({ mode: "quoted", answer: null });
    }
    for (const good of [
      "Parking is \uff04\uff11\uff10.",
      "Parking is $\u0661\u0660.",
      "Parking is $\u0967\u0966.",
      "Doors open at \uff19:\uff13\uff10 PM CST on December \uff14.",
      "Call \u0665\u0661\u0662-\u0665\u0665\u0665-\u0669\u0669\u0669\u0669.",
      "Refunds up to \uff12 hours.",
    ]) {
      expect(run(good).mode, good).toBe("model");
    }
  });

  it("numerals that cannot be read as digits are refused, never silently accepted (Roman, CJK, any script)", () => {
    for (const bad of [
      "Tickets are \u5341 dollars.", // CJK ten
      "Tickets are \u58f9\u4f70 dollars.", // financial 100
      "Tickets are X dollars.", // ASCII Roman numeral
      "Parking is $\u2169.", // Roman numeral character
      "Parking is $\u216d.",
      "Parking is $\u2169\u2169.",
      "Parking is XIV dollars.",
      "Parking is $\u4e00.", // CJK one: not folded to 1 any more, refused like its neighbours
      "Refunds up to \u3007 hours.",
      "Refunds up to \u4e8c hours.",
      "Doors open at \u4e5d:\u4e09\u3007 PM CST.",
    ]) {
      expect(run(bad), bad).toMatchObject({ mode: "quoted", answer: null, flags: expect.arrayContaining(["unsupported_number"]) });
    }
    // verbatim in the source, they are the source's own words
    const roman: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: "Q\nThe XIV Summit starts at \u5341 sharp." }]]);
    expect(checkFaqAnswer({ status: "answered", answer: "The XIV Summit.", citations: ["F1"] }, roman).mode).toBe("model");
    expect(checkFaqAnswer({ status: "answered", answer: "It starts at \u5341 sharp.", citations: ["F1"] }, roman).mode).toBe("model");
    expect(checkFaqAnswer({ status: "answered", answer: "The XV Summit.", citations: ["F1"] }, roman).mode).toBe("quoted");
    // ordinary capital letters are not numerals
    expect(run("I think so: see F1.").mode).toBe("model");
  });

  it("every Unicode decimal digit folds to the ASCII digit ICU says it is", () => {
    const systems = Intl.supportedValuesOf("numberingSystem");
    let checked = 0;
    for (const nu of systems) {
      const fmt = new Intl.NumberFormat(`en-u-nu-${nu}`, { useGrouping: false });
      const glyphs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => fmt.format(n));
      if (!glyphs.every((g) => /^\p{Nd}$/u.test(g))) continue; // algorithmic systems (roman, han) are not digit runs
      glyphs.forEach((g, n) => {
        expect(numericView(g), `${nu} ${n}`).toBe(String(n));
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(300);
    for (let cp = 0x80; cp < 0x1ffff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (/\p{Nd}/u.test(ch)) expect(numericView(ch), cp.toString(16)).toMatch(/^[0-9]$/);
    }
  });

  it("the host view maps only what UTS46 maps: digits are NOT folded in a host", () => {
    const H = "Tickets at https://tickets2026.example/vip today.";
    const m: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: `Q\n${H}` }]]);
    const r = (host: string) => checkFaqAnswer({ status: "answered", answer: `Tickets at https://${host}/vip today.`, citations: ["F1"] }, m);
    expect(r("tickets2026.example").mode).toBe("model");
    expect(r("TICKETS2026.Example").mode).toBe("model");
    expect(r("\uff54\uff49\uff43\uff4b\uff45\uff54\uff53\uff12\uff10\uff12\uff16.example").mode).toBe("model"); // fullwidth ASCII is UTS46-mapped
    expect(r("tickets2026\u3002example").mode).toBe("model"); // ideographic full stop separates labels
    expect(r("tickets\u200b2026.example").mode).toBe("model"); // a zero-width space is ignored by UTS46
    expect(r("tickets\u2461026.example").mode).toBe("model"); // a circled 2 IS mapped to "2" by UTS46: the same host
    for (const host of [
      "tickets\u4e8c026.example", // CJK two
      "tickets\u0968026.example", // Devanagari two
      "tickets\u0662026.example", // Arabic-Indic two
      "tickets\u2161026.example", // Roman numeral two (maps to the letters "ii")
      "ticketsII026.example",
    ]) {
      expect(r(host), host).toMatchObject({ mode: "quoted", answer: null, flags: expect.arrayContaining(["unsupported_link"]) });
    }
    // the same keys also hold for a bare, scheme-less host
    const bare = checkFaqAnswer({ status: "answered", answer: "Tickets at tickets\u4e8c026.example/vip today.", citations: ["F1"] }, m);
    expect(bare.mode).toBe("quoted");
  });

  it("ZWNJ and ZWJ change the host (IDNA keeps them); other invisible characters do not", () => {
    expect(numericView("a\u200cb\u200dc\u200bd\u00ade\ufeff")).toBe("abcde");
    const host = "\u0632\u064a\u062a\u0648\u0646.example";
    expect(run(`Tickets at https://${host}/pay.`).mode).toBe("model");
    expect(run("Tickets at https://\u0632\u064a\u062a\u0648\u200c\u0646.example/pay.")).toMatchObject({ mode: "quoted", flags: expect.arrayContaining(["unsupported_link"]) });
    expect(run("Tickets at https://\u0632\u064a\u062a\u0648\u200d\u0646.example/pay.").mode).toBe("quoted");
    expect(run("Write evil\u200c.test now.").mode).toBe("quoted");
    expect(run("Tickets at https://\u0632\u064a\u062a\u0648\u200b\u0646.example/pay.").mode).toBe("model");
  });

  it("a path or query is compared as written: nothing in it is folded", () => {
    const m: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: "Q\nBuy at https://tickets.example.com/VIP?id=12 today." }]]);
    const r = (a: string) => checkFaqAnswer({ status: "answered", answer: a, citations: ["F1"] }, m);
    expect(r("Buy at https://tickets.example.com/VIP?id=12 today.").mode).toBe("model");
    for (const bad of [
      "Buy at https://tickets.example.com/\uff36\uff29\uff30?id=12 today.", // fullwidth VIP
      "Buy at https://tickets.example.com/VIP\u200b?id=12 today.",
      "Buy at https://tickets.example.com/V\u00adIP?id=12 today.",
      "Buy at https://tickets.example.com/VIP?id=\uff11\uff12 today.",
      "Buy at https://tickets.example.com/VIP?id=\u0661\u0662 today.",
      "Buy at tickets.example.com/\uff36\uff29\uff30?id=12 today.",
    ]) {
      expect(r(bad), bad).toMatchObject({ mode: "quoted", answer: null, flags: expect.arrayContaining(["unsupported_link"]) });
    }
    expect(r("Buy at https://tickets.example\u200b.com/VIP?id=12 today.").mode).toBe("model"); // the host view ignores it
  });

  it("Roman numerals survive NFKC: the small forms, glued forms, and lowercase words used as numbers are refused", () => {
    const five: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: "Q\nParking is $5. We have a mix of demos, and 30 cm of room." }]]);
    const r = (a: string) => checkFaqAnswer({ status: "answered", answer: a, citations: ["F1"] }, five);
    for (const bad of [
      "Parking is $\u2179.", // small roman ten
      "Parking is $\u2173.", // small roman four
      "Parking is $\u217b.", // small roman twelve
      "Parking is $\u2170\u2179.", // small roman nine, two characters
      "Parking is $\u2169dollars.", // glued to a letter
      "Doors open at \u2173 pm.",
      "Parking is iv dollars.",
      "Parking is $iv.",
      "Doors open at ix pm.",
      "Parking is $\u2160.", // a lone numeral CHARACTER one is still a numeral
    ]) {
      expect(r(bad), bad).toMatchObject({ mode: "quoted", answer: null, flags: expect.arrayContaining(["unsupported_number"]) });
    }
    // lowercase words that merely look like numerals are ordinary words
    for (const good of ["We have a mix of demos.", "There is 30 cm of room.", "Parking is $5, and I think so."]) expect(r(good).mode, good).toBe("model");
    // verbatim in the source, a numeral is the source's own word
    const src: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: "Q\nBuy iv dollars of fuel at $\u2179." }]]);
    expect(checkFaqAnswer({ status: "answered", answer: "Buy iv dollars of fuel at $\u2179.", citations: ["F1"] }, src).mode).toBe("model");
  });

  it("TAB, LF and CR inside a host cannot hide a link: they are collapsed to a space and that text is what is served", () => {
    const m: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: "Q\nBuy at https://tickets.example.com/EventPass today." }]]);
    const r = (a: string) => checkFaqAnswer({ status: "answered", answer: a, citations: ["F1"] }, m);
    for (const sep of ["\t", "\n", "\r", "\r\n", "\t\n\t"]) {
      const out = r(`Buy at evil${sep}.test/x today.`);
      // collapsed: "evil .test/x" has no domain, and the served text really is that text
      if (out.mode === "model") expect(out.answer).toBe("Buy at evil .test/x today.");
      // and a break after a grounded link is just a space
      expect(r(`Buy at https://tickets.example.com/EventPass${sep}today.`).answer, JSON.stringify(sep)).toBe("Buy at https://tickets.example.com/EventPass today.");
      // a break inside a TLD leaves "evil.te" as a domain of its own, which the source lacks
      expect(r(`Buy at evil.te${sep}st/x today.`).mode, JSON.stringify(sep)).toBe("quoted");
    }
    // honest multi-line answers are not damaged
    expect(r("Buy at https://tickets.example.com/EventPass\ntoday.").answer).toBe("Buy at https://tickets.example.com/EventPass today.");
    expect(r("Buy at\r\nhttps://tickets.example.com/EventPass today.").mode).toBe("model");
    // a link broken by a line break is checked as it will be read
    expect(r("Buy at https://tickets.example.com/Event\nPass today.")).toMatchObject({ mode: "quoted", flags: expect.arrayContaining(["unsupported_link"]) });
  });

  it("a percent-escape in a host is not decoded into equality: the parser would turn %2e into a dot", () => {
    const m: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: "Q\nBuy at https://tickets.example.com/vip today." }]]);
    const r = (a: string) => checkFaqAnswer({ status: "answered", answer: a, citations: ["F1"] }, m);
    expect(r("Buy at https://tickets.example.com/vip today.").mode).toBe("model");
    expect(r("Buy at https://tickets%2eexample.com/vip today.")).toMatchObject({ mode: "quoted", flags: expect.arrayContaining(["unsupported_link"]) });
    expect(r("Buy at https://tickets.example%2ecom/vip today.").mode).toBe("quoted");
  });

  it("each scanner accepts only its own view, and nothing else folds text", () => {
    // compile-time: a raw string is a type error (checked by `pnpm typecheck`)
    // @ts-expect-error numeric scanners accept the numeric view only
    expect(() => numberTokensView("7pm")).not.toThrow();
    // @ts-expect-error numeric scanners accept the numeric view only
    expect(() => findPhonesView("512-555-0100")).not.toThrow();
    // @ts-expect-error the link scanner accepts as-written text only
    expect(() => findLinksAndEmailsView("a.example")).not.toThrow();
    // @ts-expect-error a numeric view is not as-written text
    expect(() => findLinksAndEmailsView(numericView("a.example"))).not.toThrow();
    // module boundary: each exported scanner is declared over its view; the only casts into a view and the only
    // normalisation calls live in the two view functions
    const code = readFileSync(new URL("./faq-checks.ts", import.meta.url), "utf8");
    expect(code).toMatch(/export function findLinksAndEmails\(\w+: WrittenText\)/);
    for (const fn of ["findPhones", "numberTokens"]) expect(code, fn).toMatch(new RegExp(`export function ${fn}\\(\\w+: NumericText`));
    expect(code.match(/as NumericText/g)).toHaveLength(1);
    expect(code.match(/as WrittenText/g)).toHaveLength(1);
    // every normalisation call lives inside the numeric view, and nowhere else
    const view = code.slice(code.indexOf("export function numericView"), code.indexOf("export function asWritten"));
    expect(code.match(/\.normalize\(/g)?.length).toBe(view.match(/\.normalize\(/g)?.length);
    expect(view).toContain("as NumericText");
    // Nothing else can mint a view: that is the lint rule `brand/no-brand-cast` (every file, tests and scripts included,
    // `as never` and `<NumericText>x` too), proved by test/eslint-brand-rule.test.ts. No file may switch it off:
    const walk = (dir: URL): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() && e.name !== "node_modules" && e.name !== ".next" ? walk(new URL(`${e.name}/`, dir)) : /\.(tsx?|mjs)$/.test(e.name) ? [new URL(e.name, dir).pathname] : []));
    const root = new URL("../../", import.meta.url);
    const disabled = [...walk(new URL("src/", root)), ...walk(new URL("test/", root)), ...walk(new URL("scripts/", root))].filter((f) => !f.endsWith("/faq-checks.test.ts") && !f.endsWith("/eslint-brand-rule.test.ts") && /no-brand-cast/.test(readFileSync(f, "utf8")));
    expect(disabled).toEqual([]);
  });
});

// Review 5923899510: every remaining finding had one cause, a hand-written list of "the numerals / invisible characters /
// currencies somebody thought of". These tests walk the CLASS (every Unicode currency sign, every ISO code, every code
// point with a numeric value, every character the URL parser deletes), not instances.
describe("derived lists: the class, not the instances", () => {
  const PRICE = "Parking is $10. Doors open at 9:30 PM CST. Call 512-555-9999.";
  const map: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: `Q\n${PRICE}` }]]);
  const run = (answer: string) => checkFaqAnswer({ status: "answered", answer, citations: ["F1"] }, map);
  const refused = (answer: string) => expect(run(answer), answer).toMatchObject({ mode: "quoted", answer: null, flags: expect.arrayContaining(["unsupported_number"]) });
  const cases = (w: string) => [w, w.toUpperCase(), w[0].toUpperCase() + w.slice(1), w.replace(/./g, (c, i) => (i % 2 ? c.toUpperCase() : c))];

  const allCodePoints = (test: (ch: string) => boolean) => {
    const out: string[] = [];
    for (let cp = 0; cp < 0x110000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (test(ch)) out.push(ch);
    }
    return out;
  };

  describe("one currency table, lower-cased first", () => {
    const SIGNS = allCodePoints((c) => /\p{Sc}/u.test(c));
    it("a lowercase Roman numeral next to ANY Unicode currency sign is refused, in every case", () => {
      expect(SIGNS.length).toBeGreaterThan(50);
      for (const sign of SIGNS) for (const n of cases("iv")) refused(`Parking is ${sign}${n}.`);
      for (const sign of ["₩", "₽", "₺", "₪", "₫", "₱", "₦", "฿"]) for (const n of ["iv", "IV", "Iv", "iV"]) refused(`Parking is ${sign}${n}.`);
    });
    it("a Roman numeral before ANY ISO currency code or currency name is refused, in every case (and before am/pm)", () => {
      const codes = Intl.supportedValuesOf("currency");
      expect(codes.length).toBeGreaterThan(100);
      for (const code of codes) for (const w of [code, code.toLowerCase()]) for (const n of ["iv", "Iv", "iV"]) refused(`Parking is ${n} ${w}.`);
      for (const w of ["dollars", "Dollars", "DOLLARS", "euros", "yen", "baht", "pounds", "USD", "EUR"]) for (const n of ["iv", "Iv", "iV", "IV"]) refused(`Parking is ${n} ${w}.`);
      for (const n of ["ix", "Ix", "iX", "IX"]) for (const pm of ["PM", "pm", "Pm", "p.m."]) refused(`Doors open at ${n} ${pm}.`);
    });
    it("words that merely contain Roman letters are still words", () => {
      for (const ok of ["We have a mix of demos.", "Parking is civil, mild and live.", "There is 30 cm of room.", "Call 512-555-9999 all day."]) {
        expect([...numberTokens(ok)].filter((t) => t.startsWith("r:")), ok).toEqual([]);
      }
    });
    it("every price form of one currency is the same price, and two currencies never are", () => {
      expect(numberTokens("₹10")).toEqual(numberTokens("10 INR"));
      expect(numberTokens("$10")).toEqual(numberTokens("10 dollars"));
      expect(numberTokens("£10")).toEqual(numberTokens("10 pounds"));
      expect(numberTokens("€10")).toEqual(numberTokens("10 EUR"));
      expect(numberTokens("10 SEK")).not.toEqual(numberTokens("10 NOK"));
      expect(numberTokens("¢10")).not.toEqual(numberTokens("€10"));
      expect(numberTokens("10 pesos")).not.toEqual(numberTokens("₱10"));
      // a sign no ISO code owns is its own currency, equal only to itself
      expect(numberTokens("¢10")).toEqual(numberTokens("10¢".replace("10¢", "¢10")));
      expect(numberTokens("¢10")).not.toEqual(numberTokens("£10"));
    });
    // B1's root cause: "buck"/"bucks"/"rmb" were claimed AFTER the loop that fills `nameWords`, so `currencyNameWords()` and
    // the rules built from it did not know them while `currencyOfWord()` did. There is one list now, and this fails if it
    // ever splits again: every word the currency table can price must also be a word the quantity rules treat as a unit.
    it("every colloquial currency word is a NAME word, and every NAME word prices and quantifies alike", () => {
      const names = currencyNameWords();
      for (const w of ["buck", "bucks", "rmb"]) {
        expect(names, w).toContain(w);
        expect(currencyOfWord(w), w).not.toBe(`w:${w}`);
      }
      // the whole set, not a sample: EVERY name word is a unit to the quantity rules, so the two can never go out of step
      // again. ("dirham" and friends name several currencies and are their own currency, which is `currencyOfWord`'s job.)
      const src: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: "Q\nParking costs $10." }]]);
      expect(names.size).toBeGreaterThan(100);
      for (const w of names) {
        expect(checkFaqAnswer({ status: "answered", answer: `Parking costs a ${w}.`, citations: ["F1"] }, src).mode, `a ${w}`).toBe("quoted");
        expect(checkFaqAnswer({ status: "answered", answer: `Parking costs one ${w}.`, citations: ["F1"] }, src).mode, `one ${w}`).toBe("quoted");
      }
    });
    it("the table reads signs and words from ICU", () => {
      expect(currencyOfSign("$")).toBe("usd");
      expect(currencyOfSign("₹")).toBe("inr");
      expect(currencyOfSign("¢")).toBe("sc:¢");
      expect(currencyOfWord("dollars")).toBe("usd");
      expect(currencyOfWord("baht")).toBe("thb");
      expect(currencyOfWord("sek")).toBe("sek");
    });
  });

  describe("numerals from Unicode Numeric_Type", () => {
    const NUMERIC = allCodePoints(hasNumericValue);
    // 1.1M code points against 219 range pairs: ~2.2 s on a loaded machine, so the 5 s default is a coin flip rather than a
    // signal (review round 14, S3). The scan is the point of the test, so the timeout moves instead of the scan.
    it("the generated table covers what \\p{N} does not, and \\p{N} covers every character the table lists", () => {
      const table = allCodePoints((c) => NUMERIC_TYPE_RANGES.some((v, i) => i % 2 === 0 && (c.codePointAt(0) as number) >= v && (c.codePointAt(0) as number) <= NUMERIC_TYPE_RANGES[i + 1]));
      expect(table.length).toBeGreaterThan(1900);
      expect(table).toContain("十");
      expect(table).toContain("卄");
      expect(table).toContain("〹");
      // letters with numeric values are the reason \p{N} alone is not enough
      expect(table.filter((c) => !/\p{N}/u.test(c)).length).toBeGreaterThan(50);
    }, 60_000);
    it("every character with a numeric value either folds to ASCII digits or is refused unless the source has it", () => {
      expect(NUMERIC.length).toBeGreaterThan(1900);
      for (const c of NUMERIC) {
        const view = numericView(c);
        const tokens = numberTokensView(view);
        if (/^[0-9]+$/.test(view.normalize("NFKC").replace(/\s/g, ""))) continue; // folded to digits: compared as the number it is
        // anything else MUST leave a token (n:, r:, or digits mixed with a token) that a source lacking it cannot have
        expect(tokens.size, `U+${(c.codePointAt(0) as number).toString(16)}`).toBeGreaterThan(0);
      }
    });
    it("the named leaks are closed: U+5344, U+3039 and the rest of the class", () => {
      for (const c of ["卄", "〹", "〸", "〺", "十", "廿", "卅", "万", "萬"]) refused(`Parking is $${c}.`);
      // U+2183 and U+2184 sit among the Roman numerals but are LETTERS in the UCD (Lu, Ll; no numeric value): in neither list
      expect(NUMERIC).not.toContain("Ↄ");
      expect(NUMERIC).not.toContain("ↄ");
      // and in the source, verbatim, they pass
      const m2: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: "Q\nParking is $卄 today." }]]);
      expect(checkFaqAnswer({ status: "answered", answer: "Parking is $卄 today.", citations: ["F1"] }, m2).mode).toBe("model");
    });
  });

  describe("a comma is a thousands separator only between groups of three", () => {
    it('"$1,0" and "$1,5" are not "$10" and "$15"; "$1,000" is still "$1000"', () => {
      expect(numberTokens("$1,000")).toEqual(numberTokens("$1000"));
      expect(numberTokens("$1,000,000.50")).toEqual(numberTokens("$1000000.5"));
      expect(numberTokens("$1,0")).not.toEqual(numberTokens("$10"));
      expect(numberTokens("$1,5")).not.toEqual(numberTokens("$15"));
      expect(numberTokens("1,50")).not.toEqual(numberTokens("150"));
      refused("Parking is $1,0.");
      // found by the property test (seed 6): U+1F102 "DIGIT ONE COMMA" is "1," to NFKC
      refused("Parking is $\u{1F102}0.");
    });
  });

  describe("characters the URL parser deletes, found by asking the URL parser", () => {
    it("the fast derivation equals probing every code point (the categories scanned are enough)", () => {
      const fast = deletedCodePoints();
      const all = deletedCodePoints(true);
      expect(fast).toEqual(all);
      expect(all.ignorable.length).toBeGreaterThan(200);
      expect(all.stripped).toEqual([0x09, 0x0a, 0x0d]);
      for (const cp of [0x200b, 0xad, 0x2060, 0xfeff, 0x34f, 0xfe0f, 0x180b, 0xe0100]) expect(all.ignorable, cp.toString(16)).toContain(cp);
    }, 60_000);

    const IGN = deletedCodePoints().ignorable.filter((cp) => ![0x09, 0x0a, 0x0d].includes(cp)).map((cp) => String.fromCodePoint(cp));
    const SRC = "Buy at https://tickets.example.com/EventPass today.";
    const m: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: `Q\n${SRC}` }]]);
    const link = (a: string) => checkFaqAnswer({ status: "answered", answer: a, citations: ["F1"] }, m);

    it("a deleted character anywhere in a link's scheme and slashes does not hide it (dotless hosts included)", () => {
      for (const ch of IGN) {
        for (const a of [`See https:${ch}//localhost/admin now.`, `See https:/${ch}/localhost/admin now.`, `See https${ch}://localhost/admin now.`, `See ${ch}https://localhost/admin now.`, `Refunds:${ch}//evil\n.test/x].`, `See http:${ch}//evil/x now.`]) {
          expect(link(a), `U+${(ch.codePointAt(0) as number).toString(16)} ${JSON.stringify(a)}`).toMatchObject({ mode: "quoted", flags: expect.arrayContaining(["unsupported_link"]) });
        }
      }
    });
    it("seed 2024's bypass stays closed", () => {
      expect(link("Refunds:​//evil\n.test/x].").mode).toBe("quoted");
    });
    it("a deleted character is nothing inside a number, and a TAB/LF/CR is a break", () => {
      for (const ch of IGN) expect(numericView(`1${ch}0`), `U+${(ch.codePointAt(0) as number).toString(16)}`).toBe(numericView("10"));
      for (const ch of ["\t", "\n", "\r"]) expect(numericView(`1${ch}0`)).toBe(`1${ch}0`);
    });
    it("every character the URL parser strips is collapsed before anything is checked", () => {
      for (const ch of ["\t", "\n", "\r"]) expect(link(`Buy at https://tickets.example.com/EventPass${ch}today.`).answer).toBe("Buy at https://tickets.example.com/EventPass today.");
    });
  });
});

// Codex 4582788038 asked for "one dollar"; thirteen rounds then found "one buck", "a couple of dollars", "a tenner" and
// "half an hour", each time by hand, because the check only knew the spellings someone had listed. The rule is now inverted:
// a word standing where a quantity belongs that the file cannot value is REFUSED, so an unlisted spelling costs a quoted
// answer rather than a fabricated number. These tests pin both directions — what must be refused, and what that costs.
describe("quantities fail closed: what cannot be valued is refused", () => {
  const SRC = "Parking costs $10. Doors open at 6:30 PM CST. Tickets are free.";
  const m: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: `Q\n${SRC}` }]]);
  const run = (a: string) => checkFaqAnswer({ status: "answered", answer: a, citations: ["F1"] }, m);
  const refuses = (a: string) => expect(run(a), a).toMatchObject({ mode: "quoted", flags: expect.arrayContaining(["unsupported_number"]) });

  it("a price or time spelled as a word must be the source's price or time", () => {
    for (const bad of [
      "Parking costs one dollar.", "Parking costs One Dollar.", "Parking costs ONE DOLLARS.", "Parking costs a dollar.", "Parking costs an euro.", "Parking costs one euro.", "Parking costs one yen.",
      "Parking costs one USD.", "Parking costs One EUR.", "Parking costs $one.", "Parking costs €one.", "Parking costs two dollars.", "Parking costs twenty dollars.", "Parking costs a hundred dollars.",
      "Parking costs a thousand dollars.", "Parking costs a dozen dollars.", "Parking costs five bucks.", "Parking costs a buck.", "Doors open at one pm.", "Doors open at One PM.", "Doors open at one a.m.",
      "Doors open at five pm.", "Doors open at twelve am.",
    ]) {
      refuses(bad);
    }
  });
  // Review round 14, B1: "a buck" was caught and "one buck" was not, because the article rule's units were typed out here
  // while the currency NAME words were built from ICU — and "buck" was claimed after the loop that fills them. One list now.
  it("a colloquial currency name is a currency name in every rule (B1)", () => {
    for (const bad of ["Parking costs one buck.", "Parking costs a buck.", "Parking costs one bucks.", "Parking costs several bucks.", "Parking is one rmb."]) refuses(bad);
  });
  // Review round 14, B3: the quantity class is open, so the check refuses what it cannot value instead of ignoring it.
  it("a quantity expression no list contains is refused, not ignored (B3)", () => {
    const counts: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: "Q\nParking costs $10. The talk lasts 45 minutes. There are four exits. 20 seats are reserved." }]]);
    const r = (a: string) => expect(checkFaqAnswer({ status: "answered", answer: a, citations: ["F1"] }, counts), a).toMatchObject({ mode: "quoted", flags: expect.arrayContaining(["unsupported_number"]) });
    for (const bad of [
      "Parking costs a couple of dollars.", "Parking costs a few dollars.", "Parking costs several dollars.", "Parking costs a pair of dollars.", "Parking costs a couple bucks.",
      "Parking costs one usd.", "Parking costs one cent.", "Parking costs one quid.", "Parking costs a tenner.", "Parking costs a handful of dollars.", "Parking costs half a dollar.",
      "The talk lasts half an hour.", "The talk lasts a couple of hours.", "The talk lasts a few minutes.", "There is one exit.", "A quarter of the seats are reserved.",
    ]) {
      r(bad);
    }
  });
  it("the source's own price and time, spelled either way, pass", () => {
    for (const good of ["Parking costs ten dollars.", "Parking costs $10.", "Doors open at half past six pm CST.".replace("half past six pm", "6:30 PM")]) expect(run(good).mode, good).toBe("model");
    const one: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: "Q\nParking costs one dollar. Doors open at one pm." }]]);
    const r = (a: string) => checkFaqAnswer({ status: "answered", answer: a, citations: ["F1"] }, one).mode;
    for (const good of ["Parking costs one dollar.", "Parking costs $1.", "Parking costs a dollar.", "Doors open at 1 pm.", "Doors open at one pm."]) expect(r(good), good).toBe("model");
    expect(r("Parking costs two dollars.")).toBe("quoted");
  });
  it("a quantity word the source itself uses is the source's own word", () => {
    const vague: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: "Q\nParking is a couple of dollars. Refunds take several days. It is a real treat." }]]);
    const r = (a: string) => checkFaqAnswer({ status: "answered", answer: a, citations: ["F1"] }, vague).mode;
    for (const good of ["Parking is a couple of dollars.", "Refunds take several days.", "It is a real treat.", "Parking is a couple of dollars and refunds take several days."]) expect(r(good), good).toBe("model");
    expect(r("Parking is a dozen dollars.")).toBe("quoted");
  });
  // Review round 14, B2: the article rule ran on the SOURCE too, so ordinary organiser prose minted a price the answer
  // could then state as a figure. An article is weaker evidence than a figure and now licenses only another article.
  it("an article in the source is not a price the answer may state as a figure (B2)", () => {
    const cases: Array<[string, string]> = [
      ["Tickets are $25. Members save a dollar.", "Tickets cost $1."],
      ["Tickets are a dollar cheaper at the door.", "Tickets cost $1."],
      ["Parking: not a dollar more than posted.", "Parking costs $1."],
      ["Members save a pound on every drink.", "Drinks cost £1."],
    ];
    for (const [src, answer] of cases) {
      const map: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: `Q\n${src}` }]]);
      expect(checkFaqAnswer({ status: "answered", answer, citations: ["F1"] }, map), answer).toMatchObject({ mode: "quoted", flags: expect.arrayContaining(["unsupported_number"]) });
      // the same article back is still the source's own words
      expect(checkFaqAnswer({ status: "answered", answer: src, citations: ["F1"] }, map).mode, src).toBe("model");
    }
  });
  it("prose uses of \"one\" and \"a\" are still prose", () => {
    for (const ok of ["One of the exits is by the front desk.", "No one is turned away.", "One more thing: it is free.", "There is a top-floor bar and a pen for you.", "Someone will meet you."]) {
      expect(run(ok).flags, ok).not.toContain("unsupported_number");
    }
  });
  // What failing closed costs. Each of these is honest and still refused, which shows the attendee the organiser's own text
  // instead: a worse answer, not a wrong one. Recorded so the price is visible rather than argued about.
  it("the false alarms failing closed buys are these, and they are refusals, not bad answers", () => {
    // "one" is the numeral everywhere outside its prose frames, so a count the source never states is refused
    for (const cost of ["Come one hour before doors.", "Give it one try.", "One pizza each."]) refuses(cost);
    // every ICU currency NAME word is a unit, and a few of them are ordinary English words ("real", "mark")
    refuses("It is a real treat.");
    expect(run("Come one hour before doors.")).toMatchObject({ mode: "quoted", answer: null, citations: ["F1"] });
  });
  // Review round 14, S2: the article rule fired on compound nouns. Two of the three shapes are structural and now suppressed.
  it("a unit used as a measure of something else, or as a modifier, is not an amount (S2)", () => {
    const cafe: SourceMap = new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: "Q\nThe cafe sells coffee by the pound. Prices are shown in US dollars." }]]);
    const r = (a: string) => checkFaqAnswer({ status: "answered", answer: a, citations: ["F1"] }, cafe).mode;
    expect(r("You can buy a pound of coffee at the cafe.")).toBe("model");
    expect(r("A yen-denominated price is not listed.")).toBe("model");
    expect(r("Prices are shown in US dollars.")).toBe("model");
    // still refused, and reported as the cost of firing broadly: the unit is the head of no phrase we can parse
    expect(r("There is a dollar store next door.")).toBe("quoted");
  });
});
