/**
 * `matchFaq`: deterministic word overlap between an attendee's question and an event's FAQ entries. Used only by demo
 * mode (a recorded answer must never be shown for a question it doesn't answer: "Can I bring my dog?" must not get the
 * parking answer) and for its `lookup` answers. Pure; the real bot never calls it.
 *
 * Stop words are dropped and words are stemmed lightly ("parking", "parks" and "parked" all become "park"). An entry's
 * score is 2 per question word found in the entry's QUESTION plus 1 per question word found in its ANSWER; an entry
 * needs a score of at least 2 AND more than half of the question's words found in it, so one stray word ("bring" in
 * "Can I bring my dog?" against "Can I bring a guest?") isn't a match. Demo mode would rather say "not covered" than
 * show a wrong entry.
 */

const STOP_WORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from get got had has have how i if in is it its " +
    "me my of on or our should so that the their there they this to up us was we were what when where which who " +
    "whom why will with would you your yours about any am into just not no yes please tell know want need there's " +
    "i'm it's"
  ).split(" "),
);

/** Light stemming: enough for plurals and "-ing"/"-ed" forms, deliberately not a real stemmer. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  // "parking" -> "park", "parked" -> "park", "stopped" -> "stopp" -> "stop"
  if (w.length > 3 && /([^aeiou])\1$/.test(w)) w = w.slice(0, -1);
  return w;
}

export function stems(input: string): Set<string> {
  const out = new Set<string>();
  // "Wi-Fi" and "wifi" are one word.
  const joined = input.toLowerCase().normalize("NFKC").replace(/(\p{L})-(?=\p{L})/gu, "$1");
  for (const raw of joined.split(/[^\p{L}\p{N}']+/u)) {
    const word = raw.replace(/^'+|'+$/g, "");
    if (word.length < 2 || STOP_WORDS.has(word)) continue;
    out.add(stem(word));
  }
  return out;
}

export type FaqMatch = { id: string; refNo: number; score: number };

export const MIN_SCORE = 2;

/**
 * The best-matching entries, best first (ties by `refNo`): at most two, the second only when it scores at least 75% of
 * the first. Empty when nothing reaches `MIN_SCORE`.
 */
export function matchFaq(question: string, entries: { id: string; refNo: number; question: string; answer: string }[]): FaqMatch[] {
  const q = stems(question);
  if (q.size === 0) return [];
  const scored: FaqMatch[] = [];
  for (const e of entries) {
    const inQuestion = stems(e.question);
    const inAnswer = stems(e.answer);
    let score = 0;
    let found = 0;
    for (const w of q) {
      if (inQuestion.has(w)) score += 2;
      else if (inAnswer.has(w)) score += 1;
      if (inQuestion.has(w) || inAnswer.has(w)) found += 1;
    }
    if (score >= MIN_SCORE && found * 2 > q.size) scored.push({ id: e.id, refNo: e.refNo, score });
  }
  scored.sort((a, b) => b.score - a.score || a.refNo - b.refNo);
  const top = scored[0];
  if (!top) return [];
  return scored.slice(0, 2).filter((m, i) => i === 0 || m.score >= top.score * 0.75);
}
