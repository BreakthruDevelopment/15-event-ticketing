/**
 * Character sets the FAQ checks need, DERIVED from an authoritative source instead of written out by hand. Every earlier
 * round of review found one more member a hand-written list had missed; these cannot miss one, because nobody lists them.
 *
 *  - Numerals: the Unicode Character Database's Numeric_Type (generated table + the runtime's own \p{N}).
 *  - Characters the URL parser deletes: found by asking the URL parser (the one a browser's link click would use).
 *
 * Nothing here is a judgement about what is "probably" a numeral or an invisible character.
 */
import { NUMERIC_TYPE_RANGES } from "./unicode-numeric.generated";

// ---------------------------------------------------------------------------------------------------------------------
// Numerals

function inRanges(cp: number): boolean {
  let lo = 0;
  let hi = NUMERIC_TYPE_RANGES.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < NUMERIC_TYPE_RANGES[mid * 2]) hi = mid - 1;
    else if (cp > NUMERIC_TYPE_RANGES[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Whether a character has a numeric value in Unicode (Numeric_Type of Decimal, Digit or Numeric): digits of every script,
 * fractions, superscripts, circled and Roman numerals, and the CJK ideographs ("十", "卄") that are letters (Lo) with a
 * numeric value. The runtime's \p{N} covers every category-N character of ITS Unicode version; the generated table covers
 * the rest of Numeric_Type, which \p{N} does not.
 */
export function hasNumericValue(ch: string): boolean {
  return /\p{N}/u.test(ch) || inRanges(ch.codePointAt(0) as number);
}

// ---------------------------------------------------------------------------------------------------------------------
// What the URL parser deletes

/** Whether `http://a<ch>b.test` resolves to the host `ab.test`: IDNA mapping deleted the character (ZWSP, soft hyphen...). */
function deletedFromHost(cp: number): boolean {
  try {
    return new URL(`http://a${String.fromCodePoint(cp)}b.test`).hostname === "ab.test";
  } catch {
    return false;
  }
}

/** Whether the URL parser's preprocessing strips the character from anywhere in a URL (the spec's "ASCII tab or newline"). */
function strippedFromUrl(cp: number): boolean {
  try {
    return new URL(`http://a/b${String.fromCodePoint(cp)}c`).pathname === "/bc";
  } catch {
    return false;
  }
}

// Only these categories can be deleted from a host; `deletedCodePoints(true)` checks every code point to prove it.
const CANDIDATE = /[\p{Cc}\p{Cf}\p{Mn}\p{Default_Ignorable_Code_Point}]/u;

function scan(all: boolean, probe: (cp: number) => boolean): number[] {
  const found: number[] = [];
  for (let cp = 0; cp < 0x110000; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (!all && !CANDIDATE.test(String.fromCodePoint(cp))) continue;
    if (probe(cp)) found.push(cp);
  }
  return found;
}

/**
 * Every code point the URL parser deletes from a host (`ignorable`: ZWSP, soft hyphen, word joiner, BOM, variation
 * selectors...) and every one it strips from a URL before parsing (`stripped`: TAB, LF, CR). `all` probes the whole code
 * space (about 5 s) instead of the categories that can hold such characters (about 80 ms); a test proves they agree.
 */
export function deletedCodePoints(all = false): { ignorable: number[]; stripped: number[] } {
  return { ignorable: scan(all, deletedFromHost), stripped: scan(all, strippedFromUrl) };
}

let memo: { ignorable: number[]; stripped: number[] } | undefined;
const derived = () => (memo ??= deletedCodePoints());

/** A regex character-class body (for the `u` flag) matching exactly `cps`. */
export function classOf(cps: number[]): string {
  const hex = (n: number) => `\\u{${n.toString(16)}}`;
  const parts: string[] = [];
  for (let i = 0; i < cps.length; ) {
    let j = i;
    while (j + 1 < cps.length && cps[j + 1] === cps[j] + 1) j++;
    parts.push(j > i ? `${hex(cps[i])}-${hex(cps[j])}` : hex(cps[i]));
    i = j + 1;
  }
  return parts.join("");
}

/** Class body matching every character the URL parser deletes from a host, TAB/LF/CR included. */
export const parserDeletedClass = () => classOf([...new Set([...derived().ignorable, ...derived().stripped])].sort((a, b) => a - b));
/** Class body matching the characters the URL parser strips from anywhere in a URL (TAB, LF, CR). */
export const parserStrippedClass = () => classOf(derived().stripped);
