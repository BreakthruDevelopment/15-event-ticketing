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
// Links, emails, phone numbers

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const URL_SCHEME = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
const DOMAIN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b(?:\/[^\s<>"')\]]*)?/gi;
const PHONE = /(?:\+?\d{1,3}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{3}[\s.-]\d{4}\b|\+\d[\d\s().-]{8,}\d/g;

const trimTail = (s: string) => s.replace(/[.,;:!?)\]]+$/g, "");

/** Emails first, then links (scheme or bare domain) that aren't part of an email; lower-cased, tail punctuation removed. */
export function findLinksAndEmails(input: string): { emails: string[]; links: string[]; rest: string } {
  const emails = (input.match(EMAIL) ?? []).map((m) => trimTail(m.toLowerCase()));
  let rest = input.replace(EMAIL, " ");
  const links = [...(rest.match(URL_SCHEME) ?? [])];
  rest = rest.replace(URL_SCHEME, " ");
  links.push(...(rest.match(DOMAIN) ?? []));
  rest = rest.replace(DOMAIN, " ");
  return { emails, links: links.map((m) => trimTail(m.toLowerCase())), rest };
}

export function findPhones(input: string): string[] {
  return (input.match(PHONE) ?? []).map((m) => m.replace(/\D/g, "")).filter((d) => d.length >= 7);
}

const isTokenChar = (c: string | undefined) => !!c && /[a-z0-9_\-/%@]/.test(c);

/** `needle` occurs in `haystack` as a whole link or email: not as the start or middle of a longer one. Both lower-case. */
function containsWhole(haystack: string, needle: string): boolean {
  if (!needle) return true;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return false;
    const before = haystack[i - 1];
    const after = haystack[i + needle.length];
    const afterDot = after === "." && /[a-z0-9]/.test(haystack[i + needle.length + 1] ?? "");
    if (!isTokenChar(before) && before !== "." && !isTokenChar(after) && !afterDot) return true;
    from = i + 1;
  }
}

const normLink = (l: string) => l.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");

// ---------------------------------------------------------------------------------------------------------------------
// Number, time, price and date tokens

const MONEY_SYMBOL = /\$\s?(\d[\d,]*(?:\.\d+)?)/g;
const MONEY_WORD = /(\d[\d,]*(?:\.\d+)?)\s?(?:usd|dollars?|bucks)\b/g;
const TIME_12H = /\b(\d{1,2})(?::(\d{2}))?\s?([ap])\.?m\b\.?/g;
const TIME_24H = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
const NUMBER = /[a-z]*\d+(?:[.,]\d+)*[a-z]*/g;

const canonNumber = (raw: string) => {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : raw;
};

/**
 * Every number-like thing in `input`, in one canonical form: times as `t:HH:MM` (24-hour), prices as `$N`, other numbers
 * as their value ("3rd" is 3, "1,000" is 1000), and words with digits ("b12") lower-cased. `ignore` is a set of
 * citation ids to leave out (the answer may say "(F3)"; an INVENTED "E99" is not ignored).
 */
export function numberTokens(input: string, ignore: Set<string> = new Set()): Set<string> {
  let s = input.toLowerCase();
  for (const id of ignore) s = s.replace(new RegExp(`\\b${id.toLowerCase()}\\b`, "g"), " ");
  const out = new Set<string>();
  s = s.replace(MONEY_SYMBOL, (_m, n: string) => {
    out.add(`$${canonNumber(n)}`);
    return " ";
  });
  s = s.replace(MONEY_WORD, (_m, n: string) => {
    out.add(`$${canonNumber(n)}`);
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
  const src = sourceText.toLowerCase();

  const a = findLinksAndEmails(answer);
  const s = findLinksAndEmails(sourceText);
  if (a.emails.some((e) => !s.emails.some((x) => x === e))) flags.push("unsupported_email");
  const srcLinks = s.links.map(normLink);
  if (a.links.some((l) => !srcLinks.some((x) => x === normLink(l) || containsWhole(src, normLink(l))))) flags.push("unsupported_link");

  const srcPhones = findPhones(sourceText);
  if (findPhones(answer).some((d) => !srcPhones.some((p) => p.endsWith(d) || d.endsWith(p)))) flags.push("unsupported_phone");

  const have = numberTokens(sourceText);
  const want = numberTokens(answer, new Set(citedIds));
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
