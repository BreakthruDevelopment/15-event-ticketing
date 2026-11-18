/**
 * Server checks on every FAQ-bot answer (spec "AI feature"). The model's output is data: nothing it says is shown until
 * it has passed these, and a failure never falls back to the model's words.
 *
 *  1. Citations must exist in the source map built from THIS event's rows at ask time (`E1`-`E5`, `F<ref_no>`); others
 *     are dropped (`unknown_citation`), whatever event they came from. `answered` with none left becomes `not_in_faq`.
 *  2. Every number, time, price, date and QUANTITY in the answer must appear in a cited source ("7pm", "7:00 PM" and
 *     "19:00" are the same time; "$10" and "10 dollars" the same price). This half FAILS CLOSED: a word standing where a
 *     quantity belongs that the file cannot value ("a couple of dollars", "a tenner") is refused, not ignored, so the
 *     cost of a spelling nobody listed is a quoted answer rather than a number the organiser never wrote.
 *  3. Every link, email address and phone number must appear in a cited source (links and emails as the same text,
 *     phones by their digits).
 * If 2 or 3 fails the answer becomes `quoted`: the cited sources' own text, verbatim, headed "From the organiser's FAQ:".
 * Pure: no database, no model.
 *
 * No list of "the numerals / invisible characters / currencies we know about" lives here. Each is DERIVED: numerals from the
 * Unicode Character Database (`unicode-derived.ts`, generated table), characters a host drops from the URL parser itself, and
 * money from ICU's currency data and `\p{Sc}` (`currency.ts`). A hand-written list can only be as good as its author's last
 * idea; the property test (`faq-checks.property.test.ts`) derives its oracle from the same authorities separately.
 */

import { CURRENCY_SIGN, currencyNameWords, currencyOfSign, currencyOfWord, currencyWordAlt } from "./currency";
import { classOf, hasNumericValue, parserDeletedClass, parserStrippedClass } from "./unicode-derived";

export type Source = {
  id: string;
  kind: "event" | "faq";
  /** Short heading for a citation chip: the entry's question, or "Event details: when". */
  label: string;
  /** The organiser's text for this source, as written (not escaped); what checks compare against and `quoted` prints. */
  text: string;
  /** The FAQ entry's `ref_no` (faq sources only). */
  refNo?: number;
};
export type SourceMap = Map<string, Source>;

export type ModelOutput = { status: "answered" | "not_in_faq" | "off_topic"; answer: string; citations: string[] };

export type CheckedAnswer = {
  status: "answered" | "not_in_faq" | "off_topic";
  /** `model`: the model's text passed every check (or it declined). `quoted`: rendered from the cited sources. */
  mode: "model" | "quoted";
  /** The model's text, only in `model` mode with status `answered`; null everywhere else (they render from `citations`). */
  answer: string | null;
  /** Valid citations only, in the order given, no duplicates. */
  citations: string[];
  flags: string[];
};

export const QUOTE_HEADER = "From the organiser's FAQ:";
export const NOT_IN_FAQ_TEXT = "The organiser's FAQ doesn't cover that.";

const stripNul = (s: string) => s.replace(/\0/g, "");
// TAB, LF and CR: the URL parser DELETES them ("evil<TAB>.test" resolves to evil.test) while a token scan splits on them.
// They are collapsed to a single space BEFORE any check, and the collapsed text is what is checked AND served, so the two
// can never disagree (re-scanning a deleted copy instead would glue honest sentences together).
// "TAB, LF and CR" is not written here: it is the set of characters the URL parser itself strips (`unicode-derived.ts`).
let breaksRe: RegExp | undefined;
const collapseBreaks = (s: string) => s.replace((breaksRe ??= new RegExp(`[${parserStrippedClass()}]+`, "gu")), " ");

// One view per purpose. Each folds only what its purpose licenses, so a fold made for one purpose can never erase a
// difference another purpose depends on:
//   - NUMERIC view (numbers, times, dates, prices, phones): compatibility characters and every script's decimal digits
//     become ASCII digits, invisible characters go. NEVER used for a host or a link.
//   - HOST view (the host of a link): only what IDNA/UTS46 itself maps, done by the URL parser ("ＥＶＩＬ" is "evil", a
//     zero-width space is nothing). It does NOT fold digits: "tickets二026" and "tickets٢026" are different, registrable hosts.
//   - LINK TAIL (path, query, fragment), emails, everything else about a link: as written, folded nothing.
// Each view has its own branded type, produced by exactly one function, and each scanner accepts only its own.

declare const NUMERIC: unique symbol;
declare const AS_WRITTEN: unique symbol;
/** Text in the numeric view. Only `numericView` makes one. */
export type NumericText = string & { readonly [NUMERIC]: true };
/** Text exactly as written, for the link scanner. Only `asWritten` makes one. */
export type WrittenText = string & { readonly [AS_WRITTEN]: true };

// Decimal digits come in runs of ten starting at zero, in every script: the digit's value is its offset in its run.
const isNd = (cp: number) => cp > 0 && /\p{Nd}/u.test(String.fromCodePoint(cp));
function foldDigit(c: string): string {
  const cp = c.codePointAt(0) as number;
  if (cp < 128) return c;
  let start = cp;
  while (isNd(start - 1)) start--;
  return String((cp - start) % 10);
}

// Roman-numeral characters (the Nl characters that NFKC turns into the letters I V X L C D M: U+2160..217F and kin) are
// numerals, not digits: no view turns them into numbers. NFKC would turn them into plain letters (the small forms into
// lowercase ones), erasing the evidence the numeral scan needs, so the numeric view FIRST wraps each in markers carrying its
// uppercase letters, and `numberTokens` reads the markers.
const ROMAN_OPEN = "\ue000";
const ROMAN_CLOSE = "\ue001";

/**
 * The numeric view: Roman-numeral characters marked (see above), then NFKC (fullwidth, superscript and circled digits,
 * compatibility currency signs), every `\p{Nd}` digit folded to ASCII, format characters dropped.
 */
export function numericView(raw: string): NumericText {
  // Invisible characters go: every format character (Cf) and every character the URL parser deletes (variation selectors,
  // soft hyphen...), except TAB/LF/CR, which are word breaks here.
  invisibleRe ??= new RegExp(`[\\p{Cf}${parserDeletedClass()}]`, "gu");
  breakRe ??= new RegExp(`^[${parserStrippedClass()}]$`, "u");
  const keep = breakRe;
  // NFKC, except that a currency sign NFKC would turn into letters ("₨" is "Rs", "﷼" is Arabic letters) stays the sign it is.
  const nfkc = (text: string) =>
    text.replace(/\p{Sc}|[^\p{Sc}]+/gu, (seg) => {
      const n = seg.normalize("NFKC");
      return /^\p{Sc}$/u.test(seg) && !/^\p{Sc}$/u.test(n) ? seg : n;
    });
  return nfkc(
    raw
      .replace(/[\ue000\ue001]/g, " ") // the markers' own code points cannot be forged by the text
      .replace(/\p{Nl}/gu, (c) => (/^[ivxlcdm]+$/i.test(c.normalize("NFKC")) ? `${ROMAN_OPEN}${c.normalize("NFKC").toUpperCase()}${ROMAN_CLOSE}` : c)),
  )
    .replace(/\p{Nd}/gu, foldDigit)
    .replace(invisibleRe, (c) => (keep.test(c) ? c : "")) as NumericText;
}
let invisibleRe: RegExp | undefined;
let breakRe: RegExp | undefined;

/** The as-written view: nothing is folded. */
export function asWritten(raw: string): WrittenText {
  return raw as WrittenText;
}

// ---------------------------------------------------------------------------------------------------------------------
// Links, emails, phone numbers

// What may not be part of a host label or a mail local part (whitespace, URL delimiters, brackets, quotes of every kind,
// dashes), and the full stops (ASCII, ideographic, fullwidth, halfwidth) that separate labels. Everything else, in any
// script, invisible characters included, is a label character: a domain is recognised BROADLY and its host is then
// mapped by the URL parser, so a character we did not think of cannot hide one.
// Whitespace is JavaScript's own `\s`, read off the engine (not typed out), EXCEPT U+FEFF: JS counts the BOM as whitespace, but
// UTS46 deletes it, so inside a host it is nothing and must not split a token.
const WS = classOf(Array.from({ length: 0x10000 }, (_, cp) => cp).filter((cp) => cp !== 0xfeff && /\s/.test(String.fromCharCode(cp))));
const DELIM = String.raw`${WS}/\\?#@:()<>[\]"',;*_!–—‹›‘’“”«»`;
const DOT = String.raw`.。．｡`;
const LABEL = `[^${DELIM}${DOT}]+`;
const TLD = String.raw`[\p{L}\p{M}\p{Cf}]{2,}`;
const DOMAIN = `(?:${LABEL}[${DOT}])+${TLD}`;
const EMAIL = new RegExp(`[^${DELIM}]+@${DOMAIN}`, "giu");
const EMAIL_WHOLE = new RegExp(`^[^${DELIM}]+@${DOMAIN}$`, "iu");
// A plain host has no percent-escape: the URL parser DECODES "%2e" to ".", so such a host keeps its raw text (never equal to another).
const PLAIN_HOST = new RegExp(`^(?:[^${DELIM}${DOT}%]|[${DOT}])+$`, "u");
// Any "scheme://" starts a link, glued to a preceding word or not, a dotless host ("http://evil") or not; "www." too. Characters
// the URL parser deletes may sit anywhere in the "://" ("https:<ZWSP>//localhost/admin"), so none of them hides a link start.
let linkStartRe: RegExp | undefined;
const linkStart = () => (linkStartRe ??= new RegExp(`[a-z][a-z0-9+.-]*[${parserDeletedClass()}]*:[${parserDeletedClass()}]*\\/[${parserDeletedClass()}]*\\/|\\bwww\\.`, "iu"));
const DOMAIN_START = new RegExp(`^${DOMAIN}`, "iu");
// No lookahead after the TLD: the link is sliced from the match start to the end of the token, so a lookahead could only
// hide a domain ("evil.test-x/x#tickets.example.com/EventPass").
const DOMAIN_ANY = new RegExp(DOMAIN, "iu");
const PHONE = /(?:\+?\d{1,3}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{3}[\s.-]\d{4}\b|\+\d[\d\s().-]{8,}\d/g;

/** Strip sentence punctuation from the end of a token: . , ; : ! ? quotes, ">" and an unbalanced ")" or "]". */
function trimTail(t: string): string {
  for (;;) {
    const c = t[t.length - 1];
    const unbalanced = (open: string, close: string) => c === close && t.split(close).length > t.split(open).length;
    if (c && (".,;:!?'\">’”›»".includes(c) || unbalanced("(", ")") || unbalanced("[", "]"))) t = t.slice(0, -1);
    else return t;
  }
}

/**
 * Links and emails in `text`, as written. Links first, then emails in what is left.
 *
 * TWO PROPERTIES THAT MATTER, and both must hold:
 *  1. A link is a MAXIMAL run of non-whitespace characters, from its "http(s)://", "www." or bare-domain start to the next
 *     whitespace, minus trailing sentence punctuation. No character class ends a token early, so a prefix of a link can
 *     never be checked in place of the whole link ("\", "~", ":", "=", "&", "+", "?", "#", "@" each used to cut the token
 *     short and the rest went unchecked).
 *  2. A domain ANYWHERE inside a whitespace token is found, not only at its start ("see:evil.test/x", "a—evil.test/x",
 *     "hello@known.example@evil.test"): what follows the match is the maximal suffix. A token that merely contains a
 *     link must never fall through unchecked.
 * Emails are lower-cased; links are returned exactly as written.
 */
export function findLinksAndEmails(text: WrittenText): { emails: string[]; links: string[] } {
  const emails: string[] = [];
  const links: string[] = [];
  for (const raw of text.split(new RegExp(`[${WS}]+`, "u"))) {
    const withScheme = linkStart().exec(raw);
    if (withScheme) {
      links.push(trimTail(raw.slice(withScheme.index)));
      continue;
    }
    const token = trimTail(raw.replace(/^[(["'<]+/, ""));
    if (EMAIL_WHOLE.test(token)) emails.push(token.toLowerCase());
    else if (DOMAIN_START.test(token)) links.push(token);
    else {
      const found = raw.match(EMAIL) ?? [];
      for (const m of found) {
        emails.push(trimTail(m.toLowerCase()));
        // An email with more glued on ("name@host/refund", "name@host=x") is not a clean email: its tail is checked as part
        // of a link, so it can never be a path nobody looked at.
        const at = raw.indexOf(m);
        if (trimTail(raw.slice(at + m.length)) !== "") links.push(trimTail(raw.slice(at)));
      }
      let left = raw;
      for (const m of found) left = left.replace(m, "\0");
      const d = DOMAIN_ANY.exec(left);
      if (d) links.push(trimTail(left.slice(d.index).replace(/\0/g, "")));
    }
  }
  return { emails, links };
}

export function findPhones(text: NumericText): string[] {
  return (text.match(PHONE) ?? []).map((m) => m.replace(/\D/g, "")).filter((d) => d.length >= 7);
}

/**
 * The host as a browser resolves it: UTS46 mapping by the URL parser (case, fullwidth forms, ideographic stops, ignored
 * characters), punycode out. Only a plain host goes through it: anything with a port, userinfo, backslash, percent-escape
 * or other delimiter keeps its raw text and so never equals another link's host (the parser would drop part of it).
 */
function hostKey(host: string): string {
  if (!PLAIN_HOST.test(host)) return `raw:${host.toLowerCase()}`;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return `raw:${host.toLowerCase()}`;
  }
}

/**
 * An answer link must EQUAL a source link after only these: the scheme is lower-cased; the host is compared as a browser
 * resolves it (`hostKey`); the answer may leave the scheme out (but never states a different one: "http://" is not
 * "https://"); one trailing "/" of the path more or less. The path, query and fragment are compared AS WRITTEN: no folding,
 * no decoding, no case change, and a slash inside a query or fragment is data. No "www." added or dropped, no default
 * ports. The model is repeating links from sources we gave it, so it has no reason to vary one; a false alarm only
 * degrades to the quoted source (which prints the real link), a miss serves a bad link to everyone for 24 h.
 */
export function parseLink(link: string): { scheme: "http" | "https" | ""; key: string } {
  const m = /^(https?):\/\//i.exec(link);
  const rest = link.slice(m ? m[0].length : 0);
  const cut = rest.search(/[/?#]/);
  const host = cut < 0 ? rest : rest.slice(0, cut);
  const tail = cut < 0 ? "" : rest.slice(cut);
  const pathEnd = tail.search(/[?#]/);
  const path = pathEnd < 0 ? tail : tail.slice(0, pathEnd);
  const rest2 = pathEnd < 0 ? "" : tail.slice(pathEnd);
  return { scheme: (m ? m[1].toLowerCase() : "") as "http" | "https" | "", key: hostKey(host) + path.replace(/\/$/, "") + rest2 };
}

function linkMatches(a: ReturnType<typeof parseLink>, s: ReturnType<typeof parseLink>): boolean {
  return a.key === s.key && (!a.scheme || a.scheme === s.scheme);
}

// ---------------------------------------------------------------------------------------------------------------------
// Number, time, price and date tokens

// An amount carries its currency: "$10" and "10 dollars" are the same price, "€10" and "£10" are not ("10" alone is neither).
// The currency table is `currency.ts`: every \p{Sc} sign and every ISO code or currency name, one table for every rule below.
const AMOUNT = String.raw`\d+(?:,\d+)*(?:\.\d+)?`; // a trailing comma is punctuation, not part of the amount
const MONEY_SYMBOL = new RegExp(`(${CURRENCY_SIGN})\\s?(${AMOUNT})`, "gu");
const MONEY_SYMBOL_AFTER = new RegExp(`(${AMOUNT})\\s?(${CURRENCY_SIGN})`, "gu");
let moneyWordRe: RegExp | undefined;
const moneyWord = () => (moneyWordRe ??= new RegExp(`(${AMOUNT})\\s?(${currencyWordAlt()})\\b`, "g"));
// ---------------------------------------------------------------------------------------------------------------------
// QUANTITIES, AND WHY THIS PART FAILS CLOSED
//
// A grounded-answer check must not have to RECOGNISE a quantity in order to be suspicious of one. Thirteen review rounds
// of "add this spelling to the list" showed why: the space of English quantity expressions is not enumerable, so every
// list leaves the next spelling ("one buck", "a couple of dollars", "several dollars", "a tenner", "half an hour") as a
// silent pass. So the rule is inverted: WHERE THE ANSWER PUTS SOMETHING IN A QUANTITY SLOT AND THIS FILE CANNOT VALUE IT,
// THE ANSWER IS REFUSED and the attendee sees the organiser's own text instead.
//
// Nothing below decides correctness by being complete. `SMALL` gives values to the words it knows; `QUANT_STOP` names
// words that never quantify anything ("in dollars", "US dollars"). A word missing from either list makes this STRICTER:
// it becomes an unvaluable quantity word, which the source can satisfy only by using the same word. The cost of an
// unlisted word is therefore a false alarm (a worse answer), never a bypass (a wrong one).
//
// Evidence has two strengths, because an article is weaker than a figure:
//   STRONG  a digit run, a numeral, or a number word written out ("one dollar", "ten dollars").
//   WEAK    the quantity 1 read from "a"/"an" in front of a unit ("a dollar"). The answer may write an article where the
//           source states 1 outright, but the source's article does NOT license the answer to state $1 as a figure
//           (round 14, B2: "Members save a dollar" must not license "Tickets cost $1").

/** A unit takes a quantity in front of it. Currency NAME words are the one currency table's; no runtime data lists units of time. */
const TIME_UNITS = ["second", "minute", "hour", "day", "week", "month", "year"];
let unitAltMemo: string | undefined;
const unitAlt = () =>
  (unitAltMemo ??= [...currencyNameWords(), ...TIME_UNITS.flatMap((w) => [w, `${w}s`])]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"));

// "a dollar", "an hour" is the quantity 1 — but not "a pound of coffee" (a measure of something else) or
// "a yen-denominated price" (the unit is a modifier). Both exceptions are structural, not a list of nouns.
let articleRe: RegExp | undefined;
const articleOne = () => (articleRe ??= new RegExp(`(?<![\\p{L}\\p{N}])an?\\s+(?=(?:${unitAlt()})(?![\\p{L}\\p{N}-])(?!\\s+of(?![\\p{L}\\p{N}])))`, "giu"));

// "one" is the numeral 1 wherever it stands, EXCEPT these prose frames. The list shortens the refusals; a frame nobody
// listed is refused, which is why "There is one exit." against a source saying "four exits" no longer passes.
const ONE_PROSE = /(?<![\p{L}\p{N}])(?:no|the|each|every|any|which|this|that|some)\s+one(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])one\s+(?:of|another|more)(?![\p{L}\p{N}])/gu;
let romanContextRe: RegExp | undefined;
const romanContext = () =>
  (romanContextRe ??= new RegExp(
    `(?:(?<=${CURRENCY_SIGN}\\s?)([ivxlcdm]+)(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])([ivxlcdm]+)(?:(?![\\p{L}\\p{N}])(?=\\s?(?:${currencyWordAlt()})(?![\\p{L}\\p{N}]))|(?=\\s?[ap]\\.?m(?![\\p{L}\\p{N}]))))`,
    "gu",
  ));
const moneyToken = (cur: string, n: string) => (cur === "usd" ? `$${canonNumber(n)}` : `c:${cur}:${canonNumber(n)}`);
const TIME_12H = /\b(\d{1,2})(?::(\d{2}))?\s?([ap])\.?m\b\.?/g;
const TIME_24H = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
const NUMBER = /[a-z]*\d+(?:[.,]\d+)*[a-z]*/g;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
// "march" and "may" are ordinary words too, so they count as months only next to a day number ("March 3", "3 May").
const MONTH_RE = "(?:january|february|april|june|july|august|september|october|november|december)";
const MONTH_ANY = `(?:${MONTH_RE.slice(3, -1)}|may!?|march!?)`;
// Abbreviations only where they can't be an ordinary word: a month before a day number ("Dec 3"), "May" only before a day number.
const MONTH_ABBR: Record<string, string> = { jan: "january", feb: "february", mar: "march", apr: "april", jun: "june", jul: "july", aug: "august", sep: "september", sept: "september", oct: "october", nov: "november", dec: "december" };
const WEEKDAY_ABBR: Record<string, string> = { mon: "monday", tue: "tuesday", tues: "tuesday", wed: "wednesday", thu: "thursday", thur: "thursday", thurs: "thursday", fri: "friday", sat: "saturday", sun: "sunday" };

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, dozen: 12,
};
const NUM_WORD = `(?:${[...Object.keys(SMALL), "dozen", "hundred", "thousand"].join("|")})`;
// "one hundred and twenty": "and" joins only after hundred or thousand ("five and ten" stays two numbers).
const NUM_WORDS_RE = new RegExp(`\\b${NUM_WORD}(?:[\\s-]+${NUM_WORD}|(?<=hundred|thousand)\\s+and\\s+${NUM_WORD})*\\b`, "g");

const ZONE_FAMILY: Record<string, string> = { est: "eastern", edt: "eastern", cst: "central", cdt: "central", mst: "mountain", mdt: "mountain", pst: "pacific", pdt: "pacific", akst: "alaska", akdt: "alaska", hst: "hawaii" };
const ZONE_ABBR = /\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT|AKST|AKDT|HST|UTC|GMT|CET|CEST|EEST|JST|KST|AEST|AEDT|NZST|NZDT)\b(?!\s?[+-]\d)/g;
// These double as ordinary words or names in capitals ("WEST", "IST", "BST", "WET", "EET"): a zone only right after a time.
const ZONE_ABBR_AFTER_TIME = /(?<=(?:\d|[aApP]\.?[mM]\.?)\s?)\b(BST|IST|WET|WEST|EET)\b(?!\s?[+-]\d)/g;
const ZONE_OFFSET = /\b(?:GMT|UTC)\s?([+-])(\d{1,2})(?::?(\d{2}))?/gi;
const ZONE_NAMED = /\b(eastern|central|mountain|pacific|alaska|hawaii)(?:[- ]aleutian)?\s+(?:standard\s+|daylight\s+)?time\b/gi;

/**
 * Time zones the text states: an abbreviation ("CST", also as its family "central"), a GMT or UTC offset, or a named
 * zone ("Central Time"). A time is only the same time in the same zone, so an answer that names a zone must name one the
 * cited source names ("7:00 PM EST" against "7:00 PM CST" is a different time).
 */
function zoneTokens(input: string, out: Set<string>) {
  for (const m of input.matchAll(ZONE_ABBR)) {
    const z = m[1].toLowerCase();
    if (z === "utc" || z === "gmt") out.add("z:gmt");
    else out.add(`z:${z}`);
    if (ZONE_FAMILY[z]) out.add(`z:${ZONE_FAMILY[z]}`);
  }
  for (const m of input.matchAll(ZONE_ABBR_AFTER_TIME)) out.add(`z:${m[1].toLowerCase()}`);
  for (const m of input.matchAll(ZONE_OFFSET)) out.add(`z:gmt${m[1]}${Number(m[2])}:${m[3] ?? "00"}`);
  for (const m of input.matchAll(ZONE_NAMED)) out.add(`z:${m[1].toLowerCase()}`);
}

// Words that never quantify anything, so they do not make what stands in front of a unit suspicious ("in dollars",
// "the dollar", "US dollars"). Only a false-alarm reducer: a word missing here is reported, not ignored.
const QUANT_STOP = new Set(
  ("a an the this that these those there here in of for to by at on off per and or with from as is are was were be been being it its their your our my his her" +
    " not but so then only just about around over under more less fewer than up down each every another other same first last next free" +
    " cost costs costing price priced prices pay paid plus minus us american canadian australian british japanese swiss mexican singapore hong kong zealand").split(" "),
);
/** A crude singular/plural fold, so "a guest" is licensed by a source that writes "guests". */
const stem = (w: string) => w.replace(/(?:es|s)$/, "");
/** The space between a quantity and what it counts: an ordinary space or a no-break space, never a hyphen or a slash. */
const SP = "[ \\u00a0]";
let quantRes: { beforeUnit: RegExp; articleOf: RegExp; articleEnd: RegExp; word: RegExp; unit: RegExp } | undefined;
const quantPatterns = () =>
  (quantRes ??= {
    // "several dollars", "a few dollars": whatever stands immediately in front of a unit is the amount.
    beforeUnit: new RegExp(`(?<![\\p{L}\\p{N}])(\\p{L}+)${SP}+(?:${unitAlt()})(?![\\p{L}\\p{N}-])`, "gu"),
    // "a couple of dollars", "a quarter of the seats": the partitive quantifier frame.
    articleOf: new RegExp(`(?<![\\p{L}\\p{N}])an?${SP}+(\\p{L}+)${SP}+of(?![\\p{L}\\p{N}])`, "gu"),
    // "a tenner.": "a"/"an" and one word that closes the phrase, so the word IS the amount ("a real treat" is not).
    articleEnd: new RegExp(`(?<![\\p{L}\\p{N}])an?${SP}+(\\p{L}+)(?=["'\\u2019\\u201d]?(?:[.,;:!?)\\]]|$))`, "gu"),
    word: /\p{L}+/gu,
    unit: new RegExp(`^(?:${unitAlt()})$`, "u"),
  });

/**
 * Words the answer puts in a quantity slot that this file cannot value — the fail-closed half of the number check.
 * Each becomes `q:<stem>`, which only a source using the same word can satisfy (`quantityVocabulary`). Words the numeral
 * rules already own (Roman numerals, characters with a Unicode numeric value) are left to them.
 */
export function quantityClaims(input: NumericText): Set<string> {
  const low = (input as string).toLowerCase();
  const p = quantPatterns();
  const out = new Set<string>();
  const unvaluable = (w: string) =>
    w !== "" &&
    !(w in SMALL) &&
    w !== "hundred" &&
    w !== "thousand" &&
    !QUANT_STOP.has(w) &&
    !ROMAN_NUMERAL.test(w.toUpperCase()) &&
    ![...w].some((c) => hasNumericValue(c));
  for (const re of [p.beforeUnit, p.articleOf, p.articleEnd]) {
    re.lastIndex = 0;
    for (const m of low.matchAll(re)) if (unvaluable(m[1]) && !p.unit.test(m[1])) out.add(`q:${stem(m[1])}`);
  }
  return out;
}

/** Every word the source uses, as `q:` tokens: what a quantity word in the answer has to be matched by. */
export function quantityVocabulary(input: NumericText): Set<string> {
  const out = new Set<string>();
  for (const m of (input as string).toLowerCase().matchAll(quantPatterns().word)) out.add(`q:${stem(m[0])}`);
  return out;
}

/** "ten" -> "10", "twenty-five" -> "25", "one hundred" -> "100", "one" -> "1" (prose frames are blanked before this runs). */
function numberWordsToDigits(s: string): string {
  return s.replace(NUM_WORDS_RE, (m) => {
    const words = m.split(/[\s-]+/).filter((w) => w !== "and");
    let total = 0;
    let cur = 0;
    for (const w of words) {
      if (w === "hundred") cur = (cur || 1) * 100;
      else if (w === "thousand") {
        total += (cur || 1) * 1000;
        cur = 0;
      } else cur += SMALL[w];
    }
    return String(total + cur);
  });
}

// A comma is a thousands separator only between groups of three ("1,000"): "1,5" and "1,0" are NOT 15 and 10 (a decimal comma,
// or digits a numeral character glued a comma onto), so they stay as written and equal only themselves.
const canonNumber = (raw: string) => {
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) return raw;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : raw;
};

/**
 * Every number-like thing in `input`, in one canonical form: times as `t:HH:MM` (24-hour), prices as `$N`, other numbers
 * as their value ("3rd" is 3, "1,000" is 1000), and words with digits ("b12") lower-cased. `ignore` is a set of
 * citation ids to leave out (the answer may say "(F3)"; an INVENTED "E99" is not ignored).
 *
 * `articles` reads "a"/"an" in front of a unit as the quantity 1. That is WEAK evidence, so `unsupportedParts` runs this
 * twice per text and keeps the two apart: see the note above `TIME_UNITS`.
 */
const ROMAN_NUMERAL = /^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
export function numberTokens(input: NumericText, ignore: Set<string> = new Set(), articles = false): Set<string> {
  const out = new Set<string>();
  // Numerals the numeric view cannot turn into digits (Roman numerals, CJK ideographic numerals) are not "out of scope"
  // but REFUSED: each must appear as itself in the source, so "十 dollars" can never pass for a price it is not.
  // 1. numeral CHARACTERS (marked by the numeric view, in any case, glued to anything): every one counts, a lone "I" too.
  const marker = new RegExp(`${ROMAN_OPEN}([IVXLCDM]+)${ROMAN_CLOSE}`, "g");
  for (const m of input.matchAll(marker)) out.add(`r:${m[1]}`);
  const plain = input.replace(marker, " ") as string;
  // 2. ASCII capitals standing alone, as written ("X dollars"): a lone "I" is the pronoun.
  for (const m of plain.matchAll(/(?<![\p{L}\p{N}])[IVXLCDM]+(?![\p{L}\p{N}])/gu)) if (m[0] !== "I" && ROMAN_NUMERAL.test(m[0])) out.add(`r:${m[0]}`);
  // 3. ASCII letters only where they are used AS a number, not as a word ("a mix of demos", "30 cm"): straight after a
  //    currency sign, or straight before a currency word or am/pm ("iv dollars", "at ix pm"). The text is lower-cased FIRST,
  //    so "IV USD", "Iv dollars" and "iV dollars" are the same as "iv usd"; the sign and the words are the shared table's.
  // 4. A number WORD is the number it spells, wherever it is written: "two", "twenty", "a hundred" and now "one" too
  //    (`numberWordsToDigits`). "one" used to count only next to money or a clock, which left every count outside those two
  //    contexts unchecked ("There is one exit." against "four exits"); it is now a number everywhere but in the prose frames
  //    of `ONE_PROSE`, which are blanked below. With `articles`, "a"/"an" in front of a unit reads as 1 as well.
  const wordsAsNumbers = articles ? plain.replace(articleOne(), "1 ") : plain;
  const lowered = wordsAsNumbers.toLowerCase();
  for (const m of lowered.matchAll(romanContext())) {
    const t = (m[1] ?? m[2]).toUpperCase();
    if (t !== "I" && ROMAN_NUMERAL.test(t)) out.add(`r:${t}`);
  }
  let s: string = lowered;
  for (const id of ignore) s = s.replace(new RegExp(`\\b${id.toLowerCase()}\\b`, "g"), " ");
  // Calendar words are facts too: a month, a weekday and a month-and-day pair must each appear in a cited source
  // ("January 3" against a source that says "December 3" is a different date; so is "Friday" for "Thursday").
  zoneTokens(input, out);
  // "one of the exits", "no one", "one more thing": the prose frames, blanked so the numeral rule does not read them as 1.
  s = s.replace(ONE_PROSE, (m) => m.replace("one", " "));
  s = numberWordsToDigits(s);
  s = s.replace(new RegExp(`\\b(${Object.keys(MONTH_ABBR).join("|")})\\.?(?=\\s*\\d)`, "g"), (_m, a: string) => MONTH_ABBR[a]);
  s = s.replace(/\b(may|march)(?=\s+\d)/g, "$1!");
  s = s.replace(/(\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?)(may|march)\b/g, "$1$2!");
  // A weekday abbreviation ("Sat", "Wed", "Sun") counts only next to a date.
  s = s.replace(new RegExp(`\\b(${Object.keys(WEEKDAY_ABBR).join("|")})(?=[.,]?\\s+(?:\\d|${MONTH_ANY}))`, "g"), (_m, a: string) => WEEKDAY_ABBR[a]);
  const monthDay = (month: string, day: string) => out.add(`d:${month.replace("!", "")}-${Number(day)}`);
  for (const m of s.matchAll(new RegExp(`\\b(${MONTH_ANY})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "g"))) monthDay(m[1], m[2]);
  for (const m of s.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ANY})`, "g"))) monthDay(m[2], m[1]);
  for (const w of [...MONTHS.filter((x) => x !== "may" && x !== "march"), "may!", "march!", ...WEEKDAYS]) {
    if (new RegExp(w.endsWith("!") ? w : `\\b${w}\\b`).test(s)) out.add(`w:${w.replace("!", "")}`);
  }
  s = s.replace(MONEY_SYMBOL, (_m, sym: string, n: string) => {
    out.add(moneyToken(currencyOfSign(sym), n));
    return " ";
  });
  s = s.replace(MONEY_SYMBOL_AFTER, (_m, n: string, sym: string) => {
    out.add(moneyToken(currencyOfSign(sym), n));
    return " ";
  });
  s = s.replace(moneyWord(), (_m, n: string, word: string) => {
    out.add(moneyToken(currencyOfWord(word), n));
    return " ";
  });
  s = s.replace(TIME_12H, (_m, h: string, mm: string | undefined, ap: string) => {
    const hour = Number(h);
    if (hour < 1 || hour > 12) {
      out.add(`t:${hour}:${mm ?? "00"}${ap}`);
    } else {
      out.add(`t:${String((hour % 12) + (ap === "p" ? 12 : 0)).padStart(2, "0")}:${mm ?? "00"}`);
    }
    return " ";
  });
  s = s.replace(TIME_24H, (_m, h: string, mm: string) => {
    out.add(`t:${h.padStart(2, "0")}:${mm}`);
    return " ";
  });
  // A character with a numeric value (Unicode Numeric_Type) that the numeric view could not turn into a digit must appear,
  // as itself, in the source.
  // Read from `plain`, BEFORE lower-casing: lower-casing turns U+2183 into U+2184, and a numeral character must not be lost
  // to a case mapping (neither is a numeral itself: both are letters in the UCD and in neither list).
  for (const m of plain.matchAll(/[^\x00-\x7f]/gu)) if (hasNumericValue(m[0])) out.add(`n:${m[0]}`);
  for (const m of s.match(NUMBER) ?? []) {
    const ordinal = /^(\d+)(?:st|nd|rd|th)$/.exec(m);
    if (ordinal) out.add(canonNumber(ordinal[1]));
    else if (/^[\d.,]+$/.test(m)) out.add(canonNumber(m));
    else out.add(m);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------

/** Why `answer` is not supported by `sourceText` (the cited sources joined), or an empty list when it is. */
export function unsupportedParts(answer: string, sourceText: string, citedIds: string[]): string[] {
  const flags: string[] = [];

  // Each purpose gets its own view of each text, once: links and emails as written, numbers and phones in the numeric view.
  const a = findLinksAndEmails(asWritten(collapseBreaks(answer)));
  const s = findLinksAndEmails(asWritten(collapseBreaks(sourceText)));
  if (a.emails.some((e) => !s.emails.some((x) => x === e))) flags.push("unsupported_email");
  const srcLinks = s.links.map(parseLink);
  if (a.links.some((l) => !srcLinks.some((x) => linkMatches(parseLink(l), x)))) flags.push("unsupported_link");

  const ans = numericView(answer);
  const src = numericView(sourceText);
  const srcPhones = findPhones(src);
  if (findPhones(ans).some((d) => !srcPhones.some((p) => p.endsWith(d) || d.endsWith(p)))) flags.push("unsupported_phone");

  // Quantities, in two strengths plus the fail-closed catch-all (see the note above `TIME_UNITS`). A weak token carries a
  // "?" so it can only ever be answered by the source's weak set; the source's weak set contains everything its strong set
  // does, so an answer's "a dollar" is still licensed by a source that says "one dollar" or "$1".
  const haveStrong = numberTokens(src);
  const haveWeak = numberTokens(src, new Set(), true);
  const wantStrong = numberTokens(ans, new Set(citedIds));
  const wantWeak = numberTokens(ans, new Set(citedIds), true);
  const have = new Set([...haveStrong, ...[...haveWeak].map((t) => `${t}?`), ...quantityVocabulary(src)]);
  const want = new Set([...wantStrong, ...[...wantWeak].filter((t) => !wantStrong.has(t)).map((t) => `${t}?`), ...quantityClaims(ans)]);
  for (const t of want) {
    if (!have.has(t)) {
      flags.push("unsupported_number");
      break;
    }
  }
  return flags;
}

/** The cited sources' own text, verbatim, for a `quoted` or `lookup` answer. */
export function quotedText(sources: SourceMap, ids: string[]): string {
  const blocks = ids.flatMap((id) => {
    const s = sources.get(id);
    return s ? [s.text] : [];
  });
  return [QUOTE_HEADER, ...blocks].join("\n\n");
}

export function checkFaqAnswer(output: ModelOutput, sources: SourceMap): CheckedAnswer {
  const flags: string[] = [];
  const citations: string[] = [];
  for (const id of output.citations) {
    if (!sources.has(id)) flags.push("unknown_citation");
    else if (!citations.includes(id)) citations.push(id);
  }
  const uniqueFlags = () => [...new Set(flags)];

  if (output.status !== "answered") {
    return { status: output.status, mode: "model", answer: null, citations: [], flags: uniqueFlags() };
  }
  if (citations.length === 0) {
    flags.push("no_valid_citation");
    return { status: "not_in_faq", mode: "model", answer: null, citations: [], flags: uniqueFlags() };
  }

  const answer = collapseBreaks(stripNul(output.answer)).trim();
  if (!answer) {
    flags.push("empty_answer");
    return { status: "answered", mode: "quoted", answer: null, citations, flags: uniqueFlags() };
  }
  const cited = citations.map((id) => sources.get(id)?.text ?? "").join("\n");
  const problems = unsupportedParts(answer, cited, citations);
  if (problems.length > 0) {
    return { status: "answered", mode: "quoted", answer: null, citations, flags: uniqueFlags().concat(problems) };
  }
  return { status: "answered", mode: "model", answer, citations, flags: uniqueFlags() };
}
