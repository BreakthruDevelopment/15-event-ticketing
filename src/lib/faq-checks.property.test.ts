import { describe, expect, it } from "vitest";
import { type SourceMap, checkFaqAnswer } from "./faq-checks";

/**
 * A property test that keeps hunting for grounding bypasses so people don't have to think of each one.
 *
 * Invariant: if the answer contains any domain, email address or link host that does not appear in the source text,
 * `checkFaqAnswer` must not return `mode: "model"`.
 *
 * "Contains a domain" is computed here by a deliberately different, cruder and broader method than the production
 * finder: after the character mappings browsers apply to a host (NFKC, format characters dropped, ideographic full
 * stops read as "."), ANY "letters-or-digits dot letters" run counts. A test that shared the finder's tokenising would
 * share its blind spots. The generator is seeded, so a failure is reproducible; it prints the answer.
 */

// mulberry32: tiny seeded PRNG
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- the oracle: crude, independent, and with its OWN policy ------------------------------------------------------------
// Production's views are a regex chain plus the URL parser. This shares none of that, and it does not share production's
// POLICY either: it is derived from the IDNA rules (UTS46 / IDNA2008), written down here once.
//   host view   NFKC + case-fold (UTS46 maps compatibility forms: fullwidth "ＥＶＩＬ" is "evil", Roman "Ⅱ" is "ii", circled
//               "②" is "2"); ignorable characters (ZWSP, soft hyphen, word joiner, BOM, bidi marks) are deleted; ideographic
//               full stops separate labels; ZWNJ/ZWJ are KEPT (CONTEXTJ). It does NOT turn other scripts' decimal digits
//               into ASCII ones: Arabic-Indic, Devanagari and CJK digits are valid, distinct label characters.
//   number view the opposite licence: every script's decimal digit (read from ICU's numbering systems, not from a range
//               table) is the ASCII digit it stands for.
//   numerals    Roman and CJK numerals are not digits in any view; if the answer has one the source lacks, it is a bypass.
const DIGIT_OF = new Map<string, string>();
for (const nu of Intl.supportedValuesOf("numberingSystem")) {
  const f = new Intl.NumberFormat(`en-u-nu-${nu}`, { useGrouping: false });
  const g = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => f.format(n));
  if (g.every((x) => /^\p{Nd}$/u.test(x))) g.forEach((x, n) => DIGIT_OF.set(x, String(n))); // decimal-digit systems only
}
const isIgnorable = (cp: number) => (cp >= 0x200b && cp <= 0x200f && cp !== 0x200c && cp !== 0x200d) || cp === 0xad || cp === 0xfeff || cp === 0x2060 || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);

function hostView(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x3002 || cp === 0xff61 || cp === 0xff0e) out += ".";
    else if (!isIgnorable(cp)) out += ch;
  }
  return out.normalize("NFKC").toLowerCase();
}
function numView(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (DIGIT_OF.has(ch)) out += DIGIT_OF.get(ch);
    else if (!isIgnorable(cp) && cp !== 0x200c && cp !== 0x200d) out += ch;
  }
  return out.normalize("NFKC"); // case kept: Roman numerals are capitals
}

const CJK_NUMERALS = "〇零一二三四五六七八九十百千万萬億亿兆壹貳贰參叁肆伍陸陆柒捌玖拾佰仟廿卅";
// A Roman numeral by arithmetic: value it, write that value back canonically, and compare.
function isRoman(t: string): boolean {
  const V: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let n = 0;
  for (let i = 0; i < t.length; i++) n += V[t[i]] < (V[t[i + 1]] ?? 0) ? -V[t[i]] : V[t[i]];
  let back = "";
  for (const [sym, v] of [["M", 1000], ["CM", 900], ["D", 500], ["CD", 400], ["C", 100], ["XC", 90], ["L", 50], ["XL", 40], ["X", 10], ["IX", 9], ["V", 5], ["IV", 4], ["I", 1]] as const) {
    while (n >= v) {
      back += sym;
      n -= v;
    }
  }
  return t !== "I" && back === t;
}

// What may NOT be part of a host label or a mail local part, for the crude scan: whitespace, URL delimiters, brackets,
// quotes of every kind, dashes.
const DELIM = String.raw`\s/\\@:?#()<>[\]"',;*_\u2013\u2014\u2039\u203a\u2018\u2019\u201c\u201d\u00ab\u00bb`;
const DOMAIN_CRUDE = new RegExp(`[^${DELIM}]+\\.[\\p{L}\\p{M}]{2,}`, "gu");
const EMAIL_CRUDE = new RegExp(`[^${DELIM}]+@[^${DELIM}]+\\.[\\p{L}\\p{M}]{2,}`, "gu");
const LINKISH = new RegExp(`(?:[a-z][a-z0-9+.-]*:\\/\\/)?[^${DELIM}]+\\.[\\p{L}\\p{M}]{2,}\\S*|[a-z][a-z0-9+.-]*:\\/\\/\\S*`, "u");
const HOST_AFTER_SCHEME = /[a-z][a-z0-9+.-]*:\/\/([^\s/?#\\]+)/g;

/**
 * Everything in the answer that names a place or a quantity and is not in the source, per the crude scan:
 *  - domains, emails and hosts after a scheme;
 *  - whole links/paths/schemes: the link-looking token (from its scheme or domain, minus trailing punctuation) must be a
 *    case-insensitive substring of the source, scheme included when the answer states one;
 *  - numbers: every digit run (after reading any script's digits) must be a digit run the source has;
 *  - Roman and CJK numerals the source does not contain.
 */
/** `t` occurs in `s` as a whole token: followed by whitespace, the end, or sentence punctuation that is itself followed by one of those. */
function appears(s: string, t: string): boolean {
  for (let i = s.indexOf(t); i >= 0; i = s.indexOf(t, i + 1)) {
    const after = s[i + t.length];
    const next = s[i + t.length + 1];
    if (after === undefined || /\s/.test(after)) return true;
    if (/[.,;:!?)\]>'"*_]/.test(after) && (next === undefined || /\s/.test(next))) return true;
  }
  return false;
}

function ungrounded(answer: string, source: string): string[] {
  const a = hostView(answer);
  const s = hostView(source);
  const names = [...(a.match(DOMAIN_CRUDE) ?? []), ...(a.match(EMAIL_CRUDE) ?? []), ...[...a.matchAll(HOST_AFTER_SCHEME)].map((m) => m[1])].filter((f) => !s.includes(f));
  const found: string[] = [...names];
  for (const token of a.split(/\s+/)) {
    const m = LINKISH.exec(token);
    if (!m) continue;
    const t = m[0].replace(/[.,;:!?)\]>'"’”‹*_]+$/g, "");
    // only the path's trailing slash may differ, never one inside a query or fragment
    const tt = /[?#]/.test(t) ? t : t.replace(/\/$/, "");
    // ("host?q" and "host/?q" are the same page: the empty path may be written either way)
    const bare = tt.replace(/^((?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]+)([?#])/, "$1/$2");
    if (tt && !appears(s, tt) && !appears(s, bare)) found.push(tt);
  }
  // A path/query is compared as written: if the host view (UTS46-style folding, dropping invisibles) would change it, the
  // answer has changed what a browser keeps.
  for (const token of answer.split(/\s+/)) {
    if (!LINKISH.test(hostView(token))) continue;
    const at = token.indexOf("://");
    const rest = token.slice(at < 0 ? 0 : at + 3);
    const cut = rest.search(/[/?#]/);
    const tail = cut < 0 ? "" : rest.slice(cut);
    if (tail && hostView(tail) !== tail.toLowerCase()) found.push(`~${tail}`);
  }
  // numbers, in the number view
  const na = numView(answer);
  const ns = numView(source);
  const sourceRuns = new Set(ns.match(/[0-9]+/g) ?? []);
  for (const run of na.match(/[0-9]+/g) ?? []) if (!sourceRuns.has(run)) found.push(`#${run}`);
  // numerals that are not digits: a Roman or CJK numeral the source does not itself contain
  const romans = (t: string) => (t.match(/(?<![\p{L}\p{N}])[IVXLCDM]+(?![\p{L}\p{N}])/gu) ?? []).filter(isRoman);
  const sourceRomans = new Set(romans(ns));
  for (const r of romans(na)) if (!sourceRomans.has(r)) found.push(`R${r}`);
  for (const ch of na) if (CJK_NUMERALS.includes(ch) && !ns.includes(ch)) found.push(`N${ch}`);
  return found;
}

const NUMERIC_SOURCE = "Parking is $10. Doors open at 9:30 PM CST on December 4. Call 512-555-9999. Refunds up to 2 hours.";
const SOURCES = [
  "Buy at https://tickets.example.com/EventPass today. Email hello@austinproductmeetup.example.",
  "Doors open at 6:30 PM CST. Parking is $10 in the Lamar Street garage.",
  "Visit tickets.example.com today, or write to hello@austinproductmeetup.example.",
  NUMERIC_SOURCE,
  "Tickets at https://\u0632\u064a\u062a\u0648\u0646.example/pay today.",
  "Go to https://tickets.example.com/?return=/VIP/ today.",
  "Tickets at https://tickets2026.example/vip today. The XIV Summit.",
];
const mapFor = (text: string): SourceMap => new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: `Q\n${text}` }]]);

const HOSTS = [
  "tickets2026.example", "tickets\u0662026.example", "tickets\u0968026.example", "tickets\u4e8c026.example", "tickets\u2161026.example", "tickets\u2461026.example", "ticketsII026.example", "tickets\u200b2026.example", "tickets2026\u3002example", "\uff54ickets2026.example",
  "evil.test", "Evil.TEST", "evil.test.", "tickets.example.com", "TICKETS.example.com", "www.tickets.example.com", "tickets.example.com.evil.test",
  "evil-tickets.example.com", "ticket5.example.com", "xn--e1aybc.xn--p1ai", "тест.рф", "bücher.example", "例え.jp", "раураl.com",
  "evil。test", "evil．test", "evil｡test", "evil​.test", "evil.te­st", "ev⁠il.test", "evil.﻿ test".replace(" ", ""),
  `${"a".repeat(60)}.test`, `${"a-".repeat(30)}b.test`, "a.b.c.d.e.f.g.test", "hello@austinproductmeetup.example", "hello@austinproductmeetup.example@evil.test",
  "\u0632\u064a\u062a\u0648\u0646.example", "\u0632\u064a\u062a\u0648\u200c\u0646.example", "\u0632\u064a\u062a\u0648\u200d\u0646.example", "\u0632\u064a\u062a\u0648\u200b\u0646.example", "evil\u200c.test", "evil\u200d.test",
  "evil@austinproductmeetup.example", "hello@evil.test", "localhost", "10.0.0.1", "evil",
];
const WRAPS = ["", "(", "[", "<", "‹", "“", "**", "_", "[x](", "see:", "see/", "see(", "tickets—", "\\", "//", "x", "mailto:", "https://", "http://", "HTTPS://", "xhttps://", "www.", "ftp://", "https://user@", "https:\\\\", "https:/\\", " "];
const TAILS = ["", "/", "/?return=/VIP", "/?return=/VIP/", "?return=/VIP", "#/VIP", "#/VIP/", "/\uff36\uff29\uff30", "/EventPass\u200b", "/Event\u00adPass", "?id=\uff11", "?id=\u0661", "/x", "/EventPass", "?q=1", "#f", "\\x", "\\..\\admin", "@evil.test", "-x/x#tickets.example.com/EventPass", "%2Fx", "%2fx", "/..", "//", "/%2e%2e/", ":443", ":8443", "?next=https://evil.test/x", "#@evil.test", "​/x", "~x", "+x", "=x", "&x"];
const CLOSERS = ["", ")", ">", "]", ".", ",", ").", "’", "**", "_", "”", "!", "?", "‹"];
const SPACES = [" ", " ", " ", "  ", " ", " ", "　", "\t", "​", "⁠"];
const FRAMES = ["Buy at %s today.", "Refunds: %s.", "See %s", "Write to %s for details.", "%s", "Go here: %s, then pay.", "[%s]", "<%s>", "Tickets are at %s today and %s tomorrow."];

// Numbers: atoms of the numeric source, exact or with one value changed, with digits rendered in a random script.
// Decimal-digit systems only (every glyph a Unicode Nd), plus hanidec (the CJK ideographic digits, which production folds
// too). Algorithmic systems (roman, tamil, financial Han numerals) write numbers with words/letters and are out of scope.
const SCRIPTS = Intl.supportedValuesOf("numberingSystem").filter((nu) => {
  const g = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => new Intl.NumberFormat(`en-u-nu-${nu}`, { useGrouping: false }).format(n));
  return nu === "hanidec" || g.every((x) => /^\p{Nd}$/u.test(x));
});
const ATOMS = [
  "Parking is $10.", "Parking is $100.", "Parking is $1.", "Parking is 10 dollars.", "Parking is \u20ac10.", "Parking is $\u2169.", "Parking is $\u216d.", "Parking is $\u2169\u2169.",
  "Doors open at 9:30 PM CST.", "Doors open at 9:45 PM CST.", "Doors open at 19:30 CST.", "Doors open at 9:30 AM CST.",
  "Doors open on December 4.", "Doors open on December 5.", "Doors open on December 14.", "Doors open on December 4, 2026.",
  "Call 512-555-9999.", "Call 512-555-9998.", "Call (512) 555-9999.", "Call 512 555 9999.", "Refunds up to 2 hours.", "Refunds up to 3 hours.", "Refunds up to 20 hours.", "Refunds up to 0 hours.",
  "Tickets are X dollars.", "Parking is $\u2169.", "Tickets are \u5341 dollars.", "Tickets are \u58f9\u4f70 dollars.", "The XIV Summit.", "The XV Summit.", "Parking is $\u4e00\u3007.", "I think so, and see C or D.",
];
function inScript(text: string, r: () => number): string {
  if (r() < 0.25) return text;
  const nu = SCRIPTS[Math.floor(r() * SCRIPTS.length)];
  const f = new Intl.NumberFormat(`en-u-nu-${nu}`, { useGrouping: false });
  const glyph = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => f.format(n));
  return text.replace(/[0-9]/g, (d) => (r() < 0.85 ? glyph[Number(d)] : d)); // mostly one script, an occasional ASCII digit mixed in
}

function answerFrom(r: () => number): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  if (r() < 0.3) {
    // trailing slashes: only the path's may differ, never one inside a query or fragment
    const link = pick(["https://tickets.example.com", "tickets.example.com", "https://tickets.example.com/", "https://tickets.example.com/EventPass"]) + pick(["", "/", "?return=/VIP", "?return=/VIP/", "/?return=/VIP", "/?return=/VIP/", "#/VIP", "#/VIP/", "/#/VIP/"]);
    return `Go to ${link}${pick(["", ".", ")"])} today.`;
  }
  if (r() < 0.4) {
    const parts = [pick(ATOMS), ...(r() < 0.5 ? [pick(ATOMS)] : [])];
    return parts.map((p) => inScript(p, r)).join(" ");
  }
  const one = () => `${pick(WRAPS)}${pick(HOSTS)}${pick(TAILS)}${pick(CLOSERS)}`;
  const frame = pick(FRAMES);
  let out = frame.replace(/%s/g, one);
  if (r() < 0.2) out = out.replace(" ", pick(SPACES)); // odd whitespace between words
  if (r() < 0.15) out = `${out} ${one()}`; // a second, separate candidate
  return out;
}

describe("grounding property: an ungrounded domain, email or host never passes as the model's answer", () => {
  it("holds for 6000 seeded hostile answers against seven sources", () => {
    // FAQ_PROPERTY_SEED / FAQ_PROPERTY_RUNS widen the hunt locally; CI uses the fixed defaults.
    const r = rng(Number(process.env.FAQ_PROPERTY_SEED ?? 20261115));
    const failures: string[] = [];
    let hostile = 0;
    const runs = Number(process.env.FAQ_PROPERTY_RUNS ?? 6000);
    for (let i = 0; i < runs; i++) {
      const answer = answerFrom(r);
      const source = SOURCES[i % SOURCES.length];
      if (ungrounded(answer, source).length === 0) continue;
      hostile++;
      const out = checkFaqAnswer({ status: "answered", answer, citations: ["F1"] }, mapFor(source));
      if (out.mode === "model") failures.push(`${JSON.stringify(answer)} against source #${i % SOURCES.length}`);
    }
    expect(failures.slice(0, 15), `${failures.length} bypasses`).toEqual([]);
    expect(hostile).toBeGreaterThan(runs / 2); // the generator really is producing hostile answers
  }, 30_000 + Number(process.env.FAQ_PROPERTY_RUNS ?? 6000) * 5);

  it("the crude scan itself sees what it must (so the property is not vacuous)", () => {
    expect(ungrounded("Buy at тест.рф/pay", SOURCES[0])).toContain("тест.рф");
    expect(ungrounded("evil.test-x/x#tickets.example.com/EventPass", SOURCES[0])).toContain("evil.test");
    expect(ungrounded("hello@austinproductmeetup.example@evil.test", SOURCES[0])).toContain("evil.test");
    expect(ungrounded("Buy at https://tickets.example.com/EventPass", SOURCES[0])).toEqual([]);
    // numbers: the oracle reads other scripts' digits itself (ICU numbering systems), so these are the same or different values
    expect(ungrounded("Parking is $\uff11\uff10.", NUMERIC_SOURCE)).toEqual([]);
    expect(ungrounded("Parking is $\u0661\u0660.", NUMERIC_SOURCE)).toEqual([]);
    expect(ungrounded("Parking is $\u0661\u0660\u0660.", NUMERIC_SOURCE)).toEqual(["#100"]);
    expect(ungrounded("Parking is $\u216d.", NUMERIC_SOURCE)).toEqual(["RC"]);
    expect(ungrounded("Tickets are \u5341 dollars.", NUMERIC_SOURCE)).toEqual(["N\u5341"]);
    expect(ungrounded("The XIV Summit, I think, and CIVIL MILD.", NUMERIC_SOURCE)).toEqual(["RXIV"]);
    // the host view does not fold other scripts' digits; UTS46 does map circled and fullwidth forms
    expect(ungrounded("Go to tickets\u0662026.example/vip", SOURCES[6])).not.toEqual([]);
    expect(ungrounded("Go to tickets\u2461026.example/vip", SOURCES[6])).toEqual([]);
    expect(ungrounded("Call \u0665\u0661\u0662-\u0665\u0665\u0665-\u0669\u0669\u0669\u0668.", NUMERIC_SOURCE)).toEqual(["#9998"]);
  });
});
