/**
 * FAQ constants, input schemas and the budget arithmetic (spec "FAQ bot retrieval" and "Rate limits and caps"). Pure
 * (no database, no `server-only`), so the editor's budget meter and the prompt builder use the same numbers as the
 * data layer, and the CHECK constraints in `src/lib/db/schema.ts` are the second layer.
 *
 * The prompt budget. `MAX_PROMPT_CHARS` is 12,000 and every part of the prompt has a cap:
 *   event block <= 2,600 (E1-E5, labels included)   FAQ entries <= 8,500 (as they appear in the prompt)
 *   attendee question <= 300                        tags and labels <= 500 (the wrapper tags and the headings)
 *   2,600 + 8,500 + 300 + 500 = 11,900, which leaves 100 spare.
 * The FAQ budget counts each entry the way the prompt prints it, `F<ref_no> Q: <question> A: <answer>` plus a newline,
 * so the entry labels are inside the 8,500 and not in the 500. If `test/faq.integration.test.ts` or
 * `src/lib/ai/event-faq.test.ts` ever fails at the maximum sizes, `maxChars` shrinks in steps of 250 and the editor's
 * meter follows; the event block and question caps stay as they are.
 */
import { z } from "zod";
import { text } from "@/lib/text";
import { idArg } from "@/lib/ticket-schema";

export const FAQ_LIMITS = {
  maxEntries: 40,
  maxChars: 8_500,
  questionMax: 200,
  answerMax: 800,
  /** Highest `ref_no`: the column's CHECK, and `event.faq_next_ref` stops at 10,000. */
  maxRefNo: 9_999,
  maxPosition: 999,
  askQuestionMax: 300,
  eventBlockMax: 2_600,
  /** The model's answer text (and `faq_ask.answer`). */
  answerTextMax: 600,
  asksPerHour: 10,
  asksPerEventPerDay: 300,
  cacheHours: 24,
  retentionDays: 30,
  /** Rows the organiser's question list returns (newest first). */
  questionsListMax: 200,
} as const;

export const TOO_MANY_ASKS = "You've asked a lot of questions this hour. Try again later.";
export const EVENT_ASKS_CAPPED = "This event's FAQ bot has answered a lot of questions today. Try again tomorrow, or contact the organiser.";
export const BOT_BUSY = "The FAQ bot is busy right now. Try again later.";

/** How one entry appears in the prompt, and what the budget counts. */
export function entryChars(refNo: number, question: string, answer: string): number {
  return `F${refNo} Q: ${question} A: ${answer}\n`.length;
}

export type FaqBudget = { entries: number; maxEntries: number; chars: number; maxChars: number };

export function faqBudget(rows: { refNo: number; question: string; answer: string }[]): FaqBudget {
  return {
    entries: rows.length,
    maxEntries: FAQ_LIMITS.maxEntries,
    chars: rows.reduce((n, r) => n + entryChars(r.refNo, r.question, r.answer), 0),
    maxChars: FAQ_LIMITS.maxChars,
  };
}

const question = text(FAQ_LIMITS.questionMax, { min: 1, minMessage: "Question is required" });
const answer = text(FAQ_LIMITS.answerMax, { min: 1, minMessage: "Answer is required" });
const position = z.number().int().min(0).max(FAQ_LIMITS.maxPosition);
const version = z.number().int().min(1);

/** One id per click (`opFor`): a retry returns the first result, even after the entry was edited in between. */
export const newFaqEntryInput = z.strictObject({ question, answer, position: position.optional(), clientOpId: idArg });
export type NewFaqEntryInput = z.input<typeof newFaqEntryInput>;

export const updateFaqEntryInput = z
  .strictObject({ question: question.optional(), answer: answer.optional(), position: position.optional(), version, clientOpId: idArg })
  .refine((v) => v.question !== undefined || v.answer !== undefined || v.position !== undefined, "Nothing to change");
export type UpdateFaqEntryInput = z.input<typeof updateFaqEntryInput>;

/** Body of the DELETE: the version the editor loaded (stale is a 409) and the op id. */
export const deleteFaqEntryInput = z.strictObject({ version, clientOpId: idArg });
export type DeleteFaqEntryInput = z.input<typeof deleteFaqEntryInput>;

export const askInput = z.strictObject({
  question: text(FAQ_LIMITS.askQuestionMax, { min: 1, minMessage: "Ask a question" }),
  /** One id per click (`opFor`): a retry returns the first answer and is not charged again. */
  clientOpId: idArg,
});
export type AskInput = z.input<typeof askInput>;

export const questionsQuery = z.strictObject({
  unanswered: z
    .enum(["0", "1"])
    .default("0")
    .transform((v) => v === "1"),
});

/** The question as the cache and the organiser's list see it: case, spacing and a trailing `?` or `.` don't make a new question. */
export function normalizeQuestion(q: string): string {
  return q
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s?!.]+$/g, "")
    .trim();
}
