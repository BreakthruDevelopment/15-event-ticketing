/**
 * Server checks on every FAQ-bot answer (spec "AI feature"). The model's output is data: nothing it says is shown until
 * it has passed these, and a failure never falls back to the model's words.
 *
 *  1. Citations must exist in the source map built from THIS event's rows at ask time (`E1`-`E5`, `F<ref_no>`); others
 *     are dropped (`unknown_citation`), whatever event they came from. `answered` with none left becomes `not_in_faq`.
 *  2. Every number, time, price and date token in the answer must appear in a cited source ("7pm", "7:00 PM" and "19:00"
 *     are the same time; "$10" and "10 dollars" the same price).
 *  3. Every link, email address and phone number must appear in a cited source (links and emails as the same text,
 *     phones by their digits).
 * If 2 or 3 fails the answer becomes `quoted`: the cited sources' own text, verbatim, headed "From the organiser's FAQ:".
 * Pure: no database, no model.
 */

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

// ---------------------------------------------------------------------------------------------------------------------
// The one normalisation front door

declare const NORMALISED: unique symbol;
/** Text that has been through `normalizeText`. The scanners accept nothing else, so none of them can read raw text. */
export type Norm = string & { readonly [NORMALISED]: true };

const ROMAN_VALUE: Record<number, number> = {
  0x216c: 50, 0x216d: 100, 0x216e: 500, 0x216f: 1000, 0x217c: 50, 0x217d: 100, 0x217e: 500, 0x217f: 1000,
  0x2180: 1000, 0x2181: 5000, 0x2182: 10000, 0x2185: 6, 0x2186: 50, 0x2187: 50000, 0x2188: 100000,
};
// Roman-numeral characters (U+2160..2188) are numbers too: "$Ⅹ" is ten dollars. Valued before NFKC turns them into letters.
const romanValue = (c: string) => {
  const cp = c.codePointAt(0) as number;
  if (ROMAN_VALUE[cp]) return String(ROMAN_VALUE[cp]);
  if (cp >= 0x2160 && cp <= 0x216b) return String(cp - 0x2160 + 1);
  if (cp >= 0x2170 && cp <= 0x217b) return String(cp - 0x2170 + 1);
  return c;
};
// Decimal digits come in runs of ten starting at zero, in every script: the digit's value is its offset in its run.
const isNd = (cp: number) => cp > 0 && /\p{Nd}/u.test(String.fromCodePoint(cp));
function foldDigit(c: string): string {
  const cp = c.codePointAt(0) as number;
  if (cp < 128) return c;
  let start = cp;
  while (isNd(start - 1)) start--;
  return String((cp - start) % 10);
}

/**
 * THE front door. Every scanner below (links, emails, phones, numbers, times, dates, prices, zones) reads text that has
 * been through this and nothing else, once for the sources and once for the answer, so there is a single canonical view
 * of free text and no scanner has a normalisation of its own to get wrong:
 *  - the CJK ideographic digits (〇一二三四五六七八九, which are letters, not Nd) and Roman-numeral characters become their number; NFKC (fullwidth and superscript digits, circled digits, compatibility
 *    letters and currency signs, fullwidth full stops);
 *  - every other decimal digit (Arabic-Indic, Devanagari, ...) becomes the ASCII digit it stands for, which NFKC does not do;
 *  - format characters (zero-width space, soft hyphen, BOM, word joiner, ...) are dropped, EXCEPT U+200C and U+200D: IDNA
 *    keeps those two because they change the host they sit in;
 *  - ideographic and halfwidth full stops read as ".", as a browser reads them in a host.
 */
export function normalizeText(raw: string): Norm {
  return raw
    .replace(/[\u3007\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d]/g, (c) => String("\u3007\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d".indexOf(c)))
    .replace(/[\u2160-\u2188]/g, romanValue)
    .normalize("NFKC")
    .replace(/\p{Nd}/gu, foldDigit)
    .replace(/\p{Cf}/gu, (c) => (c === "\u200c" || c === "\u200d" ? c : ""))
    .replace(/[\u3002\uff61]/g, ".") as Norm;
}

// ---------------------------------------------------------------------------------------------------------------------
// Links, emails, phone numbers

// Unicode-aware: a host may be written in any script (internationalised domains and TLDs), and an ASCII-only class would
// leave "тест.рф" invisible to every check.
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}\p{M}\u200c\u200d-]+(?:\.[\p{L}\p{N}\p{M}\u200c\u200d-]+)+/giu;
const EMAIL_WHOLE = /^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}\p{M}\u200c\u200d-]+(?:\.[\p{L}\p{N}\p{M}\u200c\u200d-]+)+$/iu;
// Any "scheme://" starts a link, glued to a preceding word or not, a dotless host ("http://evil") or not; "www." too.
const LINK_START = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S*/i;
const DOMAIN_START = /^(?:[\p{L}\p{N}\p{M}\u200c\u200d-]+\.)+[\p{L}\p{M}]{2,}/iu;
// No lookahead after the TLD: the link is sliced from the match start to the end of the token, so a lookahead could only
// hide a domain ("evil.test-x/x#tickets.example.com/EventPass").
const DOMAIN_ANY = /(?:[\p{L}\p{N}\p{M}\u200c\u200d-]+\.)+[\p{L}\p{M}]{2,}/iu;
const PHONE = /(?:\+?\d{1,3}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{3}[\s.-]\d{4}\b|\+\d[\d\s().-]{8,}\d/g;

/** Strip sentence punctuation from the end of a token: . , ; : ! ? quotes, ">" and an unbalanced ")" or "]". */
function trimTail(t: string): string {
  for (;;) {
    const c = t[t.length - 1];
    const unbalanced = (open: string, close: string) => c === close && t.split(close).length > t.split(open).length;
    if (c && (".,;:!?'\">".includes(c) || unbalanced("(", ")") || unbalanced("[", "]"))) t = t.slice(0, -1);
    else return t;
  }
}

/**
 * Links and emails in `input`. Links first, then emails in what is left.
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
export function findLinksAndEmails(text: Norm): { emails: string[]; links: string[] } {
  const emails: string[] = [];
  const links: string[] = [];
  for (const raw of text.split(/\s+/)) {
    const withScheme = LINK_START.exec(raw);
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

export function findPhones(text: Norm): string[] {
  return (text.match(PHONE) ?? []).map((m) => m.replace(/\D/g, "")).filter((d) => d.length >= 7);
}

/**
 * An answer link must EQUAL a source link, byte for byte, after only these: the scheme and host are lower-cased; the
 * answer may leave the scheme out (but never states a different one: "http://" is not "https://"); one trailing "/" more
 * or less. Nothing is repaired into equality: no decoding, no case folding of path/query, no "www." added or dropped, no
 * default ports. The model is repeating links from sources we gave it, so it has no reason to vary one; a false alarm
 * only degrades to the quoted source (which prints the real link), a miss serves a bad link to everyone for 24 h.
 */
export function parseLink(link: string): { scheme: "http" | "https" | ""; key: string } {
  const m = /^(https?):\/\//i.exec(link);
  const rest = link.slice(m ? m[0].length : 0);
  const cut = rest.search(/[/?#]/);
  const host = (cut < 0 ? rest : rest.slice(0, cut)).toLowerCase();
  const tail = cut < 0 ? "" : rest.slice(cut);
  return { scheme: (m ? m[1].toLowerCase() : "") as "http" | "https" | "", key: (host + tail).replace(/\/$/, "") };
}

/**
 * What follows a token's host: its path, query and fragment, exactly as written. A browser keeps every character of these
 * ("/\uff36\uff29\uff30" is a different page from "/VIP", and so is one with a zero-width space in it), while the front
 * door folds compatibility characters and drops invisible ones: right for hosts and numbers, wrong for a path. So a link
 * whose tail the front door would change is refused: the model has no reason to write one, and a flag only degrades to the
 * quoted source.
 */
const tokenTail = (token: string) => {
  const at = token.indexOf("://");
  const rest = token.slice(at < 0 ? 0 : at + 3);
  const cut = rest.search(/[/?#]/);
  return cut < 0 ? "" : rest.slice(cut);
};
function hasUnstableLinkTail(answer: string): boolean {
  return answer.split(/\s+/).some((token) => {
    const tail = tokenTail(token);
    return tail !== "" && normalizeText(tail) !== tail && findLinksAndEmails(normalizeText(token)).links.length > 0;
  });
}

function linkMatches(a: ReturnType<typeof parseLink>, s: ReturnType<typeof parseLink>): boolean {
  return a.key === s.key && (!a.scheme || a.scheme === s.scheme);
}

// ---------------------------------------------------------------------------------------------------------------------
// Number, time, price and date tokens

// An amount carries its currency: "$10" and "10 dollars" are the same price, "€10" and "£10" are not ("10" alone is neither).
const CURRENCY_SYMBOL: Record<string, string> = { "$": "usd", "€": "eur", "£": "gbp", "¥": "jpy", "₹": "inr", "₩": "krw", "₽": "rub", "₺": "try", "₪": "ils", "₫": "vnd", "₱": "php", "₦": "ngn", "฿": "thb" };
const CURRENCY_WORD: Record<string, string> = { usd: "usd", dollar: "usd", dollars: "usd", buck: "usd", bucks: "usd", eur: "eur", euro: "eur", euros: "eur", gbp: "gbp", pound: "gbp", pounds: "gbp", jpy: "jpy", yen: "jpy", inr: "inr", rupee: "inr", rupees: "inr", cad: "cad", aud: "aud", chf: "chf", francs: "chf", mxn: "mxn", pesos: "mxn", cny: "cny", yuan: "cny", rmb: "cny" };
const MONEY_SYMBOL = new RegExp(`([${Object.keys(CURRENCY_SYMBOL).join("")}])\\s?(\\d[\\d,]*(?:\\.\\d+)?)`, "g");
const MONEY_SYMBOL_AFTER = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s?([${Object.keys(CURRENCY_SYMBOL).join("")}])`, "g");
const MONEY_WORD = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s?(${Object.keys(CURRENCY_WORD).join("|")})\\b`, "g");
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
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUM_WORD = `(?:${[...Object.keys(SMALL), "hundred", "thousand"].join("|")})`;
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

/** "ten" -> "10", "twenty-five" -> "25", "one hundred" -> "100". A lone "one" stays a word ("one of the rooms"). */
function numberWordsToDigits(s: string): string {
  return s.replace(NUM_WORDS_RE, (m) => {
    const words = m.split(/[\s-]+/).filter((w) => w !== "and");
    if (words.length === 1 && words[0] === "one") return m;
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

const canonNumber = (raw: string) => {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : raw;
};

/**
 * Every number-like thing in `input`, in one canonical form: times as `t:HH:MM` (24-hour), prices as `$N`, other numbers
 * as their value ("3rd" is 3, "1,000" is 1000), and words with digits ("b12") lower-cased. `ignore` is a set of
 * citation ids to leave out (the answer may say "(F3)"; an INVENTED "E99" is not ignored).
 */
export function numberTokens(input: Norm, ignore: Set<string> = new Set()): Set<string> {
  let s: string = input.toLowerCase();
  for (const id of ignore) s = s.replace(new RegExp(`\\b${id.toLowerCase()}\\b`, "g"), " ");
  const out = new Set<string>();
  // Calendar words are facts too: a month, a weekday and a month-and-day pair must each appear in a cited source
  // ("January 3" against a source that says "December 3" is a different date; so is "Friday" for "Thursday").
  zoneTokens(input, out);
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
    out.add(moneyToken(CURRENCY_SYMBOL[sym], n));
    return " ";
  });
  s = s.replace(MONEY_SYMBOL_AFTER, (_m, n: string, sym: string) => {
    out.add(moneyToken(CURRENCY_SYMBOL[sym], n));
    return " ";
  });
  s = s.replace(MONEY_WORD, (_m, n: string, word: string) => {
    out.add(moneyToken(CURRENCY_WORD[word], n));
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
  // A numeric character the front door could not turn into a digit must appear, as itself, in the source.
  for (const m of s.matchAll(/[^\d]/gu)) if (/\p{N}/u.test(m[0])) out.add(`n:${m[0]}`);
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

  // One front door: both texts are normalised here, once, and only the normalised text reaches a scanner.
  const ans = normalizeText(answer);
  const src = normalizeText(sourceText);
  const a = findLinksAndEmails(ans);
  const s = findLinksAndEmails(src);
  if (a.emails.some((e) => !s.emails.some((x) => x === e))) flags.push("unsupported_email");
  const srcLinks = s.links.map(parseLink);
  if (hasUnstableLinkTail(answer) || a.links.some((l) => !srcLinks.some((x) => linkMatches(parseLink(l), x)))) flags.push("unsupported_link");

  const srcPhones = findPhones(src);
  if (findPhones(ans).some((d) => !srcPhones.some((p) => p.endsWith(d) || d.endsWith(p)))) flags.push("unsupported_phone");

  const have = numberTokens(src);
  const want = numberTokens(ans, new Set(citedIds));
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

  const answer = stripNul(output.answer).trim();
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
