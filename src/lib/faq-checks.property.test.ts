import { domainToASCII } from "node:url";
import { describe, expect, it } from "vitest";
import { NUMERIC_TYPE_RANGES } from "./unicode-numeric.generated";
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
// Characters a host drops: ASK the platform's own IDNA implementation (`domainToASCII`, not the WHATWG `URL` class production
// asks) about every code point, instead of listing them. Planes 4-13 (U+40000..U+DFFFF) hold no assigned character.
const IGNORABLE = new Set<number>();
for (const [lo, hi] of [[0, 0x40000], [0xe0000, 0x110000]]) {
  for (let cp = lo; cp < hi; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (domainToASCII(`a${String.fromCodePoint(cp)}b.test`) === "ab.test") IGNORABLE.add(cp);
  }
}
const isIgnorable = (cp: number) => IGNORABLE.has(cp);

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
    else if (/\p{Cf}/u.test(ch) || (isIgnorable(cp) && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d)) continue; // invisible: nothing (TAB/LF/CR are word breaks)
    else out += ch;
  }
  return out.normalize("NFKC"); // case kept: Roman numerals are capitals
}

// Numerals, straight from the Unicode Character Database's Numeric_Type (the generated table's raw ranges, not production's
// lookup around it): any character with a numeric value that is not an ASCII digit.
const isUcdNumeric = (cp: number) => {
  for (let i = 0; i < NUMERIC_TYPE_RANGES.length; i += 2) if (cp >= NUMERIC_TYPE_RANGES[i] && cp <= NUMERIC_TYPE_RANGES[i + 1]) return true;
  return false;
};
const UCD_NUMERIC_NON_ND = (() => {
  const out: string[] = [];
  for (let i = 0; i < NUMERIC_TYPE_RANGES.length; i += 2) {
    for (let cp = NUMERIC_TYPE_RANGES[i]; cp <= NUMERIC_TYPE_RANGES[i + 1]; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!/\p{Nd}/u.test(ch)) out.push(ch);
    }
  }
  return out;
})();
// Currency signs are \p{Sc}; currency words are the ISO codes and the last word of each currency's English name (ICU's
// DisplayNames, a different API from the formatter production reads), singular or plural. Metals and test codes (X..) are no amounts.
const CURRENCY_WORDS = new Set<string>();
{
  const names = new Intl.DisplayNames(["en"], { type: "currency" });
  for (const code of Intl.supportedValuesOf("currency")) {
    CURRENCY_WORDS.add(code.toLowerCase());
    if (code.startsWith("X")) continue;
    const last = (names.of(code) ?? "").toLowerCase().replace(/\s*\(.*\)\s*$/, "").split(/\s+/).pop() ?? "";
    if (/^\p{L}+$/u.test(last)) for (const w of [last, `${last}s`, `${last}es`, last.replace(/y$/, "ies")]) CURRENCY_WORDS.add(w);
  }
  for (const w of ["buck", "bucks", "rmb"]) CURRENCY_WORDS.add(w);
}
const SIGNS = (() => {
  const out: string[] = [];
  for (let cp = 0; cp < 0x30000; cp++) if (cp < 0xd800 || cp > 0xdfff) if (/\p{Sc}/u.test(String.fromCodePoint(cp))) out.push(String.fromCodePoint(cp));
  return out;
})();

/**
 * Every Roman numeral a text uses, as uppercase letters, read from the RAW text (NFKC would turn the numeral characters into
 * ordinary letters, lowercase for the small forms, before anyone could see them):
 *  - each numeral CHARACTER (a character with a numeric value that NFKC turns into roman letters), any case, glued to anything;
 *  - a standalone ASCII capital numeral ("X dollars"); a lone "I" is the pronoun;
 *  - a lowercase ASCII word only where it is used as a number: right after a currency sign, or right before a currency word
 *    or am/pm ("iv dollars"). Elsewhere it is a word ("mix", "cm").
 */
function romans(raw: string): string[] {
  const out: string[] = [];
  for (const ch of raw) {
    const cp = ch.codePointAt(0) as number;
    // a numeral character: has a numeric value in the UCD and is, to NFKC, nothing but roman letters
    if (cp > 0x7f && isUcdNumeric(cp) && /^[ivxlcdm]+$/i.test(ch.normalize("NFKC"))) out.push(ch.normalize("NFKC").toUpperCase());
  }
  for (const m of raw.matchAll(/(?<![\p{L}\p{N}])[IVXLCDM]+(?![\p{L}\p{N}])/gu)) if (isRoman(m[0])) out.push(m[0]);
  // lowercase, read after lower-casing the WHOLE text: every case of "iv" is the same word. A run of roman letters that is a whole
  // word, right after a currency sign, or right before a currency word (whole word) or am/pm.
  const low = raw.toLowerCase();
  const letter = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  for (const m of low.matchAll(/[ivxlcdm]+/g)) {
    const i = m.index as number;
    const j = i + m[0].length;
    if (letter(low[i - 1] ?? undefined) && !/\p{Sc}/u.test(low[i - 1] ?? "")) continue; // inside a longer word
    const before = low.slice(0, i).replace(/\s$/, "");
    const afterSign = /\p{Sc}$/u.test(before) && !letter(low[j]);
    const rest = low.slice(j).replace(/^\s/, "");
    const word = /^\p{L}+/u.exec(rest)?.[0] ?? "";
    const beforeWord = !letter(low[j]) && CURRENCY_WORDS.has(word);
    const beforeAmPm = /^[ap]\.?m(?![\p{L}\p{N}])/u.test(rest);
    if ((afterSign || beforeWord || beforeAmPm) && isRoman(m[0].toUpperCase())) out.push(m[0].toUpperCase());
  }
  return out;
}

// Number WORDS. English spell-out is not in ICU or JS, so this list IS hand-written, here, declared, and built differently from
// production's (positional arrays, not a keyed map). A number word is a number where it is used as one: right after a currency
// sign, or right before a currency word (a name word, or an ISO code written in capitals: lowercase "try" is a word) or am/pm;
// "a"/"an" is the quantity 1 before a dollar, euro, pound, yen or buck. Elsewhere ("one of the exits") it is prose.
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const WORD_VALUE = new Map<string, number>([...ONES.map((w, i) => [w, i] as const), ...TENS.map((w, i) => [w, i * 10] as const).filter(([w]) => w), ["hundred", 100], ["thousand", 1000], ["dozen", 12]]);
const NAME_WORDS = new Set([...CURRENCY_WORDS].filter((w) => !(w.length === 3 && Intl.supportedValuesOf("currency").includes(w.toUpperCase()))));
const ISO_CODES = new Set(Intl.supportedValuesOf("currency"));
function wordNumbers(raw: string): { all: number[]; inContext: number[] } {
  const all: number[] = [];
  const inContext: number[] = [];
  for (const m of raw.matchAll(/[\p{L}]+/gu)) {
    const word = m[0].toLowerCase();
    const i = m.index as number;
    const after = raw.slice(i + m[0].length).replace(/^\s/, "");
    const next = /^\p{L}+/u.exec(after)?.[0] ?? "";
    const prev = raw.slice(0, i).replace(/\s$/, "");
    const isNumberWord = WORD_VALUE.has(word);
    const article = (word === "a" || word === "an") && /^(dollars?|euros?|pounds?|yen|bucks?)$/i.test(next);
    if (!isNumberWord && !article) continue;
    const v = article ? 1 : (WORD_VALUE.get(word) as number);
    all.push(v);
    const money = NAME_WORDS.has(next.toLowerCase()) || ISO_CODES.has(next);
    const clock = /^[ap]\.?m(?![\p{L}\p{N}])/iu.test(after);
    if (article || /\p{Sc}$/u.test(prev) || money || clock) inContext.push(v);
  }
  return { all, inContext };
}

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
  // a number is digits, with a thousands comma only between groups of three and an optional decimal part ("1,0" is two numbers)
  const NUMBER_VALUE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
  const value = (run: string) => String(Number(run.replace(/,/g, "")));
  const sourceRuns = new Set((ns.match(NUMBER_VALUE) ?? []).map(value));
  for (const run of na.match(NUMBER_VALUE) ?? []) if (!sourceRuns.has(value(run))) found.push(`#${value(run)}`);
  // numerals that are not digits: a Roman or CJK numeral the source does not itself contain
  const sourceRomans = new Set(romans(source));
  for (const r of romans(answer)) if (!sourceRomans.has(r)) found.push(`R${r}`);
  const sourceWords = wordNumbers(source).all;
  const sourceDigits = (ns.match(NUMBER_VALUE) ?? []).map(value);
  for (const v of wordNumbers(answer).inContext) if (!sourceWords.includes(v) && !sourceDigits.includes(String(v))) found.push(`W${v}`);
  for (const ch of na) if ((ch.codePointAt(0) as number) > 0x7f && isUcdNumeric(ch.codePointAt(0) as number) && !DIGIT_OF.has(ch) && !ns.includes(ch)) found.push(`N${ch}`);
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
  "evil\t.test", "evil.\ttest", "evil\n.test", "evil.test\r", "tickets.\texample.com", "tickets.example\n.com", "evil.te\r\nst",
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
  "Parking is $\u2179.", "Parking is $\u2173.", "Parking is $\u217b.", "Parking is $\u2170\u2179.", "Doors open at \u2173 pm.", "Parking is iv dollars.", "Parking is $iv.", "Doors open at ix pm.", "We have a mix of demos.", "There is 30 cm of room.",
  "Parking is one dollar.", "Parking is One Dollar.", "Parking is a dollar.", "Parking is one USD.", "Parking is $one.", "Parking is two dollars.", "Parking is a hundred dollars.", "Parking is ten dollars.", "Doors open at one pm.", "Doors open at five PM.", "Doors open at six p.m.",
  "One of the exits is by the desk.", "No one is turned away.", "Come one hour before doors.", "Give it one try.", "It is a real treat.", "Parking is an euro.", "Parking is a dozen dollars.",
  "Tickets are X dollars.", "Parking is $\u2169.", "Tickets are \u5341 dollars.", "Tickets are \u58f9\u4f70 dollars.", "The XIV Summit.", "The XV Summit.", "Parking is $\u4e00\u3007.", "I think so, and see C or D.",
];
function inScript(text: string, r: () => number): string {
  if (r() < 0.25) return text;
  const nu = SCRIPTS[Math.floor(r() * SCRIPTS.length)];
  const f = new Intl.NumberFormat(`en-u-nu-${nu}`, { useGrouping: false });
  const glyph = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => f.format(n));
  return text.replace(/[0-9]/g, (d) => (r() < 0.85 ? glyph[Number(d)] : d)); // mostly one script, an occasional ASCII digit mixed in
}

const ROMAN_WORDS = ["iv", "IV", "Iv", "iV", "ix", "IX", "xi", "Xi", "mix", "Mix"];
const CURRENCY_PICK = ["dollars", "Dollars", "DOLLARS", "usd", "USD", "Usd", "eur", "EUR", "euros", "yen", "baht", "sek", "SEK", "jpy", "krw", "KRW", "inr", "pounds", "rupees"];
function dynamicAtom(r: () => number): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  switch (Math.floor(r() * 5)) {
    case 0: return `Parking is ${pick(SIGNS)}${pick(ROMAN_WORDS)}.`; // any currency sign, any case
    case 1: return `Parking is ${pick(ROMAN_WORDS)} ${pick(CURRENCY_PICK)}.`;
    case 2: return `Doors open at ${pick(ROMAN_WORDS)} ${pick(["PM", "pm", "Pm", "p.m.", "AM"])}.`;
    case 3: return `Refunds up to ${pick(UCD_NUMERIC_NON_ND)} hours.`; // any character with a numeric value
    default: return `Parking is $${pick(UCD_NUMERIC_NON_ND)}${pick(["", "0"])}.`;
  }
}

function answerFrom(r: () => number): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  if (r() < 0.12) return dynamicAtom(r);
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

// The seeds CI runs on every PR: the one that found the last bypass (2024), the default, and a spread. A seed is a
// reproducible run; FAQ_PROPERTY_SEEDS ("1-200" or "7,9,11") widens the hunt locally (`pnpm test:fuzz`).
function seedList(): number[] {
  const spec = process.env.FAQ_PROPERTY_SEEDS ?? process.env.FAQ_PROPERTY_SEED;
  if (!spec) return [2024, 20261115, 1, 7, 42, 99, 314, 777, 1337, 4242, 65536, 123456789];
  return spec.split(",").flatMap((part) => {
    const range = /^(\d+)-(\d+)$/.exec(part.trim());
    return range ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i) : [Number(part)];
  });
}

describe("grounding property: an ungrounded domain, email, host, number or numeral never passes as the model's answer", () => {
  const runs = Number(process.env.FAQ_PROPERTY_RUNS ?? 2500);
  it.each(seedList())("holds for seeded hostile answers against seven sources (seed %i)", (seed) => {
    const r = rng(seed);
    const failures: string[] = [];
    let hostile = 0;
    for (let i = 0; i < runs; i++) {
      const answer = answerFrom(r);
      const source = SOURCES[i % SOURCES.length];
      if (ungrounded(answer, source).length > 0) hostile++; // sanity: how many generated answers are hostile at all
      // What matters is what is SERVED: the text of a "model" answer (which may differ from the input, e.g. line breaks).
      const out = checkFaqAnswer({ status: "answered", answer, citations: ["F1"] }, mapFor(source));
      if (out.mode === "model" && out.answer !== null && ungrounded(out.answer, source).length > 0) failures.push(`${JSON.stringify(answer)} -> ${JSON.stringify(out.answer)} against source #${i % SOURCES.length}`);
    }
    expect(failures.slice(0, 15), `seed ${seed}: ${failures.length} bypasses`).toEqual([]);
    expect(hostile).toBeGreaterThan(runs / 2); // the generator really is producing hostile answers
  }, 30_000 + runs * 5);

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
    // number words in money/time context are numbers; in prose they are not
    expect(ungrounded("Parking is one dollar.", NUMERIC_SOURCE)).toEqual(["W1"]);
    expect(ungrounded("Parking is a dollar, at one pm.", NUMERIC_SOURCE)).toEqual(["W1", "W1"]);
    expect(ungrounded("Parking is ten dollars. One of the exits; no one; give it one try.", NUMERIC_SOURCE)).toEqual([]);
    expect(ungrounded("The XIV Summit, I think, and CIVIL MILD.", NUMERIC_SOURCE)).toEqual(["RXIV"]);
    // the host view does not fold other scripts' digits; UTS46 does map circled and fullwidth forms
    expect(ungrounded("Go to tickets\u0662026.example/vip", SOURCES[6])).not.toEqual([]);
    expect(ungrounded("Go to tickets\u2461026.example/vip", SOURCES[6])).toEqual([]);
    expect(ungrounded("Call \u0665\u0661\u0662-\u0665\u0665\u0665-\u0669\u0669\u0669\u0668.", NUMERIC_SOURCE)).toEqual(["#9998"]);
  });
});
