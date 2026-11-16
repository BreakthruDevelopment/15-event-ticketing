/**
 * ONE currency table for every rule that cares about money (price tokens, and the lowercase Roman-numeral context). Read
 * from the runtime's ICU data (every ISO 4217 code, its English names, its symbol) and Unicode (`\p{Sc}`, every currency
 * sign), not typed in: a currency somebody forgot to list used to be the gap ("₩iv", "iv USD").
 *
 *  - a currency SIGN is any `\p{Sc}` character. It maps to an ISO code when ICU says that sign is that currency's own
 *    ("$" is USD, "€" EUR, "¥" JPY, "₹" INR); otherwise it is its own currency (`sc:<sign>`), equal only to itself.
 *  - a currency WORD is an ISO code ("usd", "sek") or the last word of the currency's English name, singular or plural
 *    ("dollars", "euro", "yen", "baht"), plus the few colloquial names ICU has no entry for ("buck"). A word that names
 *    several currencies ("pesos", "dinars") is its own currency unless one of them owns a sign and is a reserve currency
 *    ("dollars" is USD, "pounds" GBP; "pesos", "francs" are not).
 *  - a currency NAME word is that list without the ISO codes (`currencyNameWords()`), and the colloquial names are in it:
 *    they are claimed in the same place, so no rule can know "bucks" as money and not know it as a name.
 * Everything is compared lower-cased: callers lower-case first.
 */

// A word that names several currencies ("dollars", "pounds", "pesos") means the one that owns a sign AND is a reserve currency
// (the IMF's Special Drawing Rights basket); otherwise it is its own currency. "10 dollars" is "$10"; "10 pesos" is not "₱10".
const RESERVE = new Set(["usd", "eur", "jpy", "gbp", "cny"]);

// Colloquial names ICU does not carry. They are NAME words like any other, so they are claimed in the same loop that claims
// ICU's names (review round 14, B1: claiming them afterwards left them out of `nameWords`, and every rule built from
// `currencyNameWords()` — the article rule among them — silently did not know the word "buck").
const COLLOQUIAL: ReadonlyArray<readonly [string, string]> = [
  ["buck", "usd"],
  ["bucks", "usd"],
  ["rmb", "cny"],
];

type Table = { signCode: Map<string, string>; wordCode: Map<string, string>; wordAlt: string; nameWords: Set<string> };

let memo: Table | undefined;

function build(): Table {
  const isoCodes = Intl.supportedValuesOf("currency").map((c) => c.toLowerCase());
  const fmt = (currency: string, currencyDisplay: "symbol" | "narrowSymbol" | "name", v = 1) =>
    new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);

  // sign -> code: the one currency (if any) whose own, symbol-display sign is this narrow sign
  const bySign = new Map<string, string[]>();
  for (const code of isoCodes) {
    const narrow = fmt(code, "narrowSymbol").replace(/[\d.,\s ]/g, "");
    if (/^\p{Sc}$/u.test(narrow)) bySign.set(narrow, [...(bySign.get(narrow) ?? []), code]);
  }
  const signCode = new Map<string, string>();
  for (const [sign, codes] of bySign) {
    const own = codes.filter((c) => fmt(c, "symbol").replace(/[\d.,\s ]/g, "") === sign);
    if (own.length === 1) signCode.set(sign, own[0]);
    else if (codes.length === 1) signCode.set(sign, codes[0]);
  }
  const primary = new Set(signCode.values());

  // word -> code(s)
  const claims = new Map<string, Set<string>>();
  const nameWords = new Set<string>();
  const claim = (word: string, code: string) => claims.set(word, (claims.get(word) ?? new Set()).add(code));
  /** A NAME word: claimed for its currency AND added to `nameWords`, together, so the two can never drift apart. */
  const claimName = (word: string, code: string) => {
    claim(word, code);
    nameWords.add(word);
  };
  for (const [word, code] of COLLOQUIAL) claimName(word, code);
  for (const code of isoCodes) {
    claim(code, code);
    if (code.startsWith("x")) continue; // metals, test and fund codes: their names are not amounts ("troy ounces of gold")
    for (const v of [1, 2]) {
      const name = fmt(code, "name", v).replace(/^[\d.,\s ]+/, "").replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
      const last = name.split(/\s+/).pop() ?? "";
      if (/^\p{L}+$/u.test(last)) claimName(last, code);
    }
  }
  const wordCode = new Map<string, string>();
  for (const [word, codes] of claims) {
    const list = [...codes];
    const owner = list.find((c) => primary.has(c) && RESERVE.has(c));
    wordCode.set(word, list.length === 1 ? list[0] : owner ?? `w:${word}`);
  }
  const wordAlt = [...wordCode.keys()].sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return { signCode, wordCode, wordAlt, nameWords };
}

const table = () => (memo ??= build());

/** The currency a sign stands for: an ISO code, or `sc:<sign>` when the sign is not any one currency's own. */
export const currencyOfSign = (sign: string): string => table().signCode.get(sign) ?? `sc:${sign}`;
/** The currency a lower-case word stands for ("dollars" -> "usd"). */
export const currencyOfWord = (word: string): string => table().wordCode.get(word) ?? `w:${word}`;
/** A regex alternation (no group) of every currency word, longest first. */
export const currencyWordAlt = (): string => table().wordAlt;
/** A currency sign: any Unicode currency symbol. Regex source for the `u` flag. */
export const CURRENCY_SIGN = String.raw`\p{Sc}`;
/**
 * The currencies' English NAME words ("dollar", "dollars", "yen", "buck"), not ISO codes (several of those are ordinary
 * words: "try", "all", "top"). ONE source for every rule that needs "a word that names money" — the quantity rules in
 * `faq-checks.ts` build their unit alternation from exactly this set, so the two cannot go out of step (round 14, B1).
 */
export const currencyNameWords = (): ReadonlySet<string> => table().nameWords;
