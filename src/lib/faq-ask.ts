import "server-only";
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, ne, sql } from "drizzle-orm";
import { assertCan, lockActor, rolesFor } from "@/lib/access";
import { type FaqEntryFacts, answerFaq, buildSources, renderFaqText } from "@/lib/ai/event-faq";
import type { generate } from "@/lib/ai";
import type { Actor } from "@/lib/auth/rbac";
import { type Db, db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { CodedConflictError, NotFoundError, TooManyRequestsError } from "@/lib/errors";
import { idParam } from "@/lib/event-schema";
import { ownsEventNow } from "@/lib/faq";
import type { SourceMap } from "@/lib/faq-checks";
import { BOT_BUSY, EVENT_ASKS_CAPPED, FAQ_LIMITS, TOO_MANY_ASKS, TOO_MANY_CACHED, askInput, normalizeQuestion, questionsQuery } from "@/lib/faq-schema";
import { log } from "@/lib/log";
import { type Tx, advisoryLock, consumeRate, reserveDaily, releaseDaily, releaseRate } from "@/lib/usage";
import { spendRead } from "@/lib/write-tx";

/**
 * The FAQ bot (spec "AI feature", 15.5): `POST /api/events/[id]/ask` and the organiser's question list.
 *
 * One ask, in order (every refusal before the charge costs one `api_read`, nothing else):
 *  1. signed in, role `user` or `organizer` (`faq:ask`; admin is 403); one `api_read` spent;
 *  2. the body is parsed (400, no charge); the event and its FAQ are read as ONE snapshot (REPEATABLE READ, read only), so
 *     the prompt, the citation map and the `faq_version` the answer is stored under all describe the same moment;
 *  3. draft, hidden and missing events are the same 404; a cancelled one is 409 `event_cancelled`; the event's own
 *     organiser may try the bot on any of their events (nothing of that is stored);
 *  4. a retry (same op id) returns the first answer: no charge, no model call; the same op id for another question is 409;
 *  5. a cached answer for the same (event, `faq_version`, normalised question) from the last 24 h is returned and recorded
 *     under the op id as a small pointer to the answering row (a replay returns it even after the FAQ changed, unless the
 *     row is gone, which re-asks normally); no model charge, but its own 60-per-hour allowance;
 *  6. otherwise ONE short transaction claims the ask (the op-ledger row, the user's `ai` allowance 10/hour, the event's
 *     300-per-day count, the app-wide `AI_DAILY_CAP`) and, for an attendee, inserts the `faq_ask` row as `pending`, so
 *     the per-event count is exact even with answers in flight; a refusal anywhere rolls all of it back;
 *  7. the model is called OUTSIDE any transaction; a failure releases the charge and the claim (the retry runs fresh);
 *  8. the answer is checked (`faq-checks`), the `faq_ask` row and the ledger result are finished in one transaction.
 *
 * Lock order of the claim: user row FOR SHARE, op-ledger row, the `ai` allowance, the event's advisory lock, the event
 * row FOR SHARE, the app-wide counter. Nothing else takes the `ai` allowance or that advisory lock, and writers take the
 * event row FOR UPDATE only after their own user and allowance locks, so the orders never cross.
 *
 * `faq_ask` has no user id, by design; `created_at` is stored to the hour; rows older than 30 days are deleted (a bounded
 * batch on every ask) and never shown. A cached answer inserts no row, so repeating one question can't fill the day's cap.
 */

const E = schema.event;
const F = schema.faqEntry;
const T = schema.ticketType;
const A = schema.faqAsk;
const L = schema.opLedger;

const KIND = "faq-ask";
const opHash = (payload: string) => createHash("sha256").update(`${KIND}\n${payload}`).digest("hex");
const qHashOf = (q: string) => createHash("sha256").update(normalizeQuestion(q)).digest("hex");

export type FaqCitation = { id: string; kind: "event" | "faq"; refNo: number | null; label: string };
export type AskResponse = {
  status: "answered" | "not_in_faq" | "off_topic";
  /** `cached` when this answer was given to an earlier identical question; `answerMode` is then how it was first made. */
  mode: "model" | "quoted" | "lookup" | "cached";
  answerMode: "model" | "quoted" | "lookup";
  /** Plain text to show: the model's words, the cited sources verbatim, or the fixed "not covered" line. */
  text: string;
  citations: FaqCitation[];
  /** True when this answer is a recorded demo answer, not a live model's. */
  demo: boolean;
};

type Snapshot = {
  event: {
    id: string;
    title: string;
    description: string;
    venueName: string;
    address: string;
    timeZone: string;
    startsAt: Date;
    endsAt: Date;
    doorsAt: Date | null;
    registrationClosesAt: Date;
    contactEmail: string | null;
    status: string;
    hiddenAt: Date | null;
    organizerId: string;
    faqVersion: number;
  };
  ticketTypeNames: string[];
  entries: FaqEntryFacts[];
};

/** Event, ticket type names and entries as of one instant. Everything the prompt and the checks use comes from here. */
async function loadSnapshot(eventId: string): Promise<Snapshot | null> {
  return db().transaction(
    async (tx) => {
      const [event] = await tx
        .select({
          id: E.id,
          title: E.title,
          description: E.description,
          venueName: E.venueName,
          address: E.address,
          timeZone: E.timeZone,
          startsAt: E.startsAt,
          endsAt: E.endsAt,
          doorsAt: E.doorsAt,
          registrationClosesAt: E.registrationClosesAt,
          contactEmail: E.contactEmail,
          status: E.status,
          hiddenAt: E.hiddenAt,
          organizerId: E.organizerId,
          faqVersion: E.faqVersion,
        })
        .from(E)
        .where(eq(E.id, eventId));
      if (!event) return null;
      const types = await tx.select({ name: T.name }).from(T).where(eq(T.eventId, eventId)).orderBy(asc(T.position), asc(T.name));
      const entries = await tx
        .select({ id: F.id, refNo: F.refNo, question: F.question, answer: F.answer })
        .from(F)
        .where(eq(F.eventId, eventId))
        .orderBy(asc(F.position), asc(F.refNo));
      return { event, ticketTypeNames: types.map((t) => t.name), entries };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Who may ask about which event. The event's own organiser may try the bot on any status; everyone else only on a published, not hidden event. */
function gate(ev: { status: string; hiddenAt: Date | null }, owner: boolean) {
  if (owner) return;
  if (ev.status === "draft" || ev.hiddenAt) throw new NotFoundError();
  if (ev.status === "cancelled") throw new CodedConflictError("event_cancelled", "This event was cancelled.");
}

const citationViews = (sources: SourceMap, ids: string[]): FaqCitation[] =>
  ids.flatMap((id) => {
    const s = sources.get(id);
    return s ? [{ id, kind: s.kind, refNo: s.refNo ?? null, label: s.label }] : [];
  });

async function readLedger(reader: Pick<Db, "select">, actorId: string, opId: string) {
  const [row] = await reader.select().from(L).where(and(eq(L.actorId, actorId), eq(L.clientOpId, opId)));
  return row;
}

/** What a cache-hit ask leaves in the ledger: a pointer to the `faq_ask` row it was served from, never the text. */
type CacheRef = { ref: string };

/** The first answer for this op id (or, for a cache hit, the pointer to it), or the error that says why there isn't one. */
function interpret(first: typeof L.$inferSelect, hash: string): AskResponse | CacheRef {
  if (first.kind !== KIND || first.payloadHash !== hash) {
    throw new CodedConflictError("op_id_reused", "That request id was already used for a different request.");
  }
  if (first.result) return first.result as unknown as AskResponse | CacheRef;
  throw new CodedConflictError("retry", "That question is still being answered. Try again in a moment.");
}

const STILL_RUNNING = "That question is still being answered. Try again in a moment.";

/**
 * Answer a replayed cache-hit ask from the row it pointed at. Same `faq_version`: exactly the original answer. The FAQ
 * changed since: a model answer or a "not covered" line is still returned as it was (the model's own text needs no
 * entries; citations are dropped, since their numbers may now mean other entries); a `quoted` or `lookup` answer can't be
 * rendered from entries that changed, so it is null and the ask runs normally. A row that is gone (pruned, or its event
 * edited away) is null too.
 */
async function resolveRef(ref: CacheRef, snap: Snapshot, sources: SourceMap): Promise<AskResponse | null> {
  const [row] = await db()
    .select({ status: A.status, mode: A.mode, answer: A.answer, citations: A.citations, flags: A.flags, faqVersion: A.faqVersion })
    .from(A)
    .where(and(eq(A.id, ref.ref), eq(A.eventId, snap.event.id), sql`not (${A.flags} && array['pending']::text[])`));
  if (!row) return null;
  if (row.faqVersion === snap.event.faqVersion) return fromStored(row, snap, sources);
  const answerMode = row.mode === "quoted" || row.mode === "lookup" ? row.mode : "model";
  if (row.status === "answered" && (answerMode !== "model" || !row.answer)) return null;
  return {
    status: row.status,
    mode: "cached",
    answerMode,
    text: renderFaqText({ status: row.status, mode: answerMode, answer: row.answer, citations: [] }, sources, snap.event.contactEmail),
    citations: [],
    demo: row.flags.includes("demo"),
  };
}

/** Drop a ledger row that points at an answer that can't be returned any more, so the op id can run normally. */
async function forgetRef(actorId: string, opId: string) {
  await db().delete(L).where(and(eq(L.actorId, actorId), eq(L.clientOpId, opId), eq(L.kind, KIND), sql`jsonb_exists(${L.result}, 'ref')`));
}

/** Retention in bounded batches, run by every ask and cache hit: `faq_ask` rows past 30 days, ask ledger rows past 48 hours. SKIP LOCKED keeps concurrent batches from deadlocking. */
async function pruneOld(tx: Tx) {
  await tx.execute(sql`
    delete from faq_ask where id in (
      select id from faq_ask where created_at < now() - make_interval(days => ${FAQ_LIMITS.retentionDays}) limit 200 for update skip locked
    )
  `);
  await tx.execute(sql`
    delete from op_ledger where (actor_id, client_op_id) in (
      select actor_id, client_op_id from op_ledger
      where kind = ${KIND} and created_at < now() - make_interval(hours => ${FAQ_LIMITS.ledgerHours}) limit 200 for update skip locked
    )
  `);
}

type Stored = Pick<typeof A.$inferSelect, "status" | "mode" | "answer" | "citations" | "flags">;

/** A stored answer rendered against THIS snapshot's sources (same `faq_version`, so the same text), or null when it can't be. */
function fromStored(row: Stored, snap: Snapshot, sources: SourceMap): AskResponse | null {
  if (row.citations.some((id) => !sources.has(id))) return null;
  const answerMode = row.mode === "quoted" || row.mode === "lookup" ? row.mode : "model";
  if (row.status === "answered" && answerMode === "model" && !row.answer) return null;
  return {
    status: row.status,
    mode: "cached",
    answerMode,
    text: renderFaqText({ status: row.status, mode: answerMode, answer: row.answer, citations: row.citations }, sources, snap.event.contactEmail),
    citations: citationViews(sources, row.citations),
    demo: row.flags.includes("demo"),
  };
}

async function findCached(snap: Snapshot, qHash: string, sources: SourceMap): Promise<{ askId: string; response: AskResponse } | null> {
  const rows = await db()
    .select({ id: A.id, status: A.status, mode: A.mode, answer: A.answer, citations: A.citations, flags: A.flags })
    .from(A)
    .where(
      and(
        eq(A.eventId, snap.event.id),
        eq(A.qHash, qHash),
        eq(A.faqVersion, snap.event.faqVersion),
        gt(A.createdAt, sql`now() - make_interval(hours => ${FAQ_LIMITS.cacheHours})`),
        sql`not (${A.flags} && array['pending', 'uncached']::text[])`,
      ),
    )
    .orderBy(desc(A.createdAt))
    .limit(1);
  const response = rows[0] ? fromStored(rows[0], snap, sources) : null;
  return rows[0] && response ? { askId: rows[0].id, response } : null;
}

/**
 * Record a cache-hit ask under its op id so a retry after a lost response gets the same answer without a model call. The
 * ledger row is small (a pointer), cache hits have their own allowance (`cachedPerHour`, counted from these rows, 429 over
 * it), and `pruneOld` removes the rows after 48 hours, so a cache-hit loop can't grow the table without bound.
 * Returns what an identical earlier request left (a parallel duplicate), or null when this request wrote the row.
 */
async function recordCacheHit(actor: Actor, opId: string, hash: string, askId: string, version: number): Promise<typeof L.$inferSelect | null> {
  return db().transaction(async (tx) => {
    await advisoryLock(tx, `faq-cached:${actor.id}`);
    const [{ n }] = await tx
      .select({ n: count() })
      .from(L)
      .where(and(eq(L.actorId, actor.id), eq(L.kind, KIND), sql`jsonb_exists(${L.result}, 'ref')`, gt(L.createdAt, sql`now() - interval '1 hour'`)));
    if (n >= FAQ_LIMITS.cachedPerHour) throw new TooManyRequestsError(TOO_MANY_CACHED);
    const [mine] = await tx
      .insert(L)
      .values({ actorId: actor.id, clientOpId: opId, kind: KIND, payloadHash: hash, result: { ref: askId, v: version } })
      .onConflictDoNothing()
      .returning({ id: L.clientOpId });
    await pruneOld(tx);
    if (mine) return null;
    const first = await readLedger(tx, actor.id, opId);
    if (!first) throw new CodedConflictError("retry", STILL_RUNNING);
    return first;
  });
}

type Claim = { replay: AskResponse } | { askId: string | null };

/**
 * Now, rounded down to the hour IN THE EVENT'S ZONE: in a half-hour zone (Asia/Calcutta) a UTC-hour boundary would put a
 * question just after local midnight on the previous local day. Computed here from the zone's own minutes and seconds
 * rather than with `at time zone` in SQL, so a zone Node knows but the database's tzdata doesn't can't fail an ask.
 */
export function hourInZone(timeZone: string, now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(now);
  const num = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return new Date(Math.floor(now.getTime() / 1000) * 1000 - (num("minute") * 60 + num("second")) * 1000);
}

async function claim(actor: Actor, snap: Snapshot, data: { question: string; clientOpId: string }, hash: string, qHash: string): Promise<Claim> {
  const eventId = snap.event.id;
  return db().transaction(async (tx) => {
    const role = await lockActor(tx, actor, rolesFor("faq:ask"));
    const [mine] = await tx
      .insert(L)
      .values({ actorId: actor.id, clientOpId: data.clientOpId, kind: KIND, payloadHash: hash })
      .onConflictDoNothing()
      .returning({ id: L.clientOpId });
    if (!mine) {
      const first = await readLedger(tx, actor.id, data.clientOpId);
      if (!first) throw new CodedConflictError("retry", STILL_RUNNING);
      const prior = interpret(first, hash);
      // A pointer to a cached answer here is a parallel duplicate of a cache-hit ask: let the caller resolve it.
      if ("ref" in prior) throw new CodedConflictError("retry", STILL_RUNNING);
      return { replay: prior };
    }
    await consumeRate(tx, actor.id, "ai", FAQ_LIMITS.asksPerHour, TOO_MANY_ASKS);
    await advisoryLock(tx, `faq-ask:${eventId}`);
    // The event as it is NOW (the snapshot is a few milliseconds old): hidden or cancelled in between is refused here.
    const [ev] = await tx
      .select({ status: E.status, hiddenAt: E.hiddenAt, organizerId: E.organizerId })
      .from(E)
      .where(eq(E.id, eventId))
      .for("share");
    if (!ev) throw new NotFoundError();
    const owner = role === "organizer" && ev.organizerId === actor.id;
    gate(ev, owner);
    let askId: string | null = null;
    if (!owner) {
      const [{ n }] = await tx
        .select({ n: count() })
        .from(A)
        .where(and(eq(A.eventId, eventId), sql`${A.createdAt} >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc') - interval '1 hour'`));
      if (n >= FAQ_LIMITS.asksPerEventPerDay) throw new TooManyRequestsError(EVENT_ASKS_CAPPED);
      const [row] = await tx
        .insert(A)
        .values({ eventId, question: data.question, qHash, faqVersion: snap.event.faqVersion, status: "not_in_faq", citations: [], mode: "model", flags: ["pending"], createdAt: hourInZone(snap.event.timeZone) })
        .returning({ id: A.id });
      askId = row.id;
    }
    if (!(await reserveDaily(tx, "ai", env().AI_DAILY_CAP))) throw new TooManyRequestsError(BOT_BUSY);
    return { askId };
  });
}

/** The model call failed or the answer couldn't be stored: give the charge and the claim back, so a retry runs fresh. */
async function abandon(actor: Actor, askId: string | null, opId: string): Promise<void> {
  try {
    await db().transaction(async (tx) => {
      await tx.delete(L).where(and(eq(L.actorId, actor.id), eq(L.clientOpId, opId), sql`${L.result} is null`));
      if (askId) await tx.delete(A).where(eq(A.id, askId));
      await releaseRate(tx, actor.id, "ai");
      await releaseDaily(tx, "ai");
    });
  } catch {
    log.error("faq.ask.release_failed");
  }
}

/**
 * Ask the FAQ bot: body `{ question, clientOpId }`. See the file comment for the order of events. `opts.run` replaces
 * `generate` (tests only). 200 with an `AskResponse` and `replayed`.
 */
export async function askFaq(actor: Actor | null, rawEventId: string, input: unknown, opts: { run?: typeof generate } = {}) {
  assertCan(actor, "faq:ask");
  await spendRead(actor);
  const eventId = idParam.parse(rawEventId);
  const data = askInput.parse(input);
  const snap = await loadSnapshot(eventId);
  if (!snap) throw new NotFoundError();
  const sessionOwner = actor.role === "organizer" && snap.event.organizerId === actor.id;
  gate(snap.event, sessionOwner);

  const hash = opHash(`${eventId}\n${data.question}`);
  const sources = buildSources(snap);
  const prior = await readLedger(db(), actor.id, data.clientOpId);
  if (prior) {
    const first = interpret(prior, hash);
    if (!("ref" in first)) return { ...first, replayed: true };
    const again = await resolveRef(first, snap, sources);
    if (again) return { ...again, replayed: true };
    await forgetRef(actor.id, data.clientOpId);
  }

  const qHash = qHashOf(data.question);
  if (!sessionOwner) {
    const cached = await findCached(snap, qHash, sources);
    if (cached) {
      const dup = await recordCacheHit(actor, data.clientOpId, hash, cached.askId, snap.event.faqVersion);
      if (!dup) return { ...cached.response, replayed: false };
      const first = interpret(dup, hash);
      if ("ref" in first) {
        const again = await resolveRef(first, snap, sources);
        if (again) return { ...again, replayed: true };
      } else {
        return { ...first, replayed: true };
      }
      throw new CodedConflictError("retry", STILL_RUNNING);
    }
  }

  const claimed = await claim(actor, snap, data, hash, qHash);
  if ("replay" in claimed) return { ...claimed.replay, replayed: true };

  // From here on a failure of any kind gives the charge and the claim back (the model call is the slow, fallible part).
  let result: Awaited<ReturnType<typeof answerFaq>>;
  let response: AskResponse;
  try {
    result = await answerFaq(snap, data.question, opts.run);
    const flags = [...result.flags, ...(result.demo ? ["demo"] : [])];
    // A recorded answer made because a live model failed must not be served from cache once the model is back.
    if (result.demo && env().AI_PROVIDER !== "demo") flags.push("uncached");
    response = {
      status: result.status,
      mode: result.mode,
      answerMode: result.mode,
      text: renderFaqText(result, sources, snap.event.contactEmail),
      citations: citationViews(sources, result.citations),
      demo: result.demo,
    };
    await db().transaction(async (tx) => {
      if (claimed.askId) {
        await tx
          .update(A)
          .set({ status: result.status, answer: result.mode === "model" ? result.answer : null, citations: result.citations, mode: result.mode, flags })
          .where(eq(A.id, claimed.askId));
      }
      await tx
        .update(L)
        .set({ result: response })
        .where(and(eq(L.actorId, actor.id), eq(L.clientOpId, data.clientOpId)));
      await pruneOld(tx);
    });
  } catch (err) {
    await abandon(actor, claimed.askId, data.clientOpId);
    throw err;
  }
  // No question, answer, user or event text here: task-level facts only.
  log.info("faq.ask", { eventId, status: result.status, mode: result.mode, flags: result.flags, citations: result.citations.length, demo: result.demo, latencyMs: result.latencyMs });
  return { ...response, replayed: false };
}

export type QuestionRow = { question: string; status: "answered" | "not_in_faq" | "off_topic"; mode: "model" | "quoted" | "lookup" | "cached"; citations: string[] };

/**
 * GET /api/organizer/events/[id]/questions[?unanswered=1]: what attendees asked in the last 30 days, newest first, grouped
 * by day in the event's time zone (at most 200 rows). No user, no timestamp finer than the day: the questions are
 * anonymous. Pending asks (still being answered, or abandoned) are left out. 404 for another organiser's event.
 * `unansweredCount` counts every `not_in_faq` and `off_topic` question of the window, whatever the filter.
 */
export async function listQuestions(actor: Actor | null, rawEventId: string, query: unknown = {}) {
  assertCan(actor, "event:manage");
  await spendRead(actor);
  const id = idParam.parse(rawEventId);
  const { unanswered } = questionsQuery.parse(query);
  if (!(await ownsEventNow(actor, id))) throw new NotFoundError();
  const [ev] = await db().select({ timeZone: E.timeZone }).from(E).where(eq(E.id, id));
  if (!ev) throw new NotFoundError();

  const fresh = and(
    eq(A.eventId, id),
    gt(A.createdAt, sql`now() - make_interval(days => ${FAQ_LIMITS.retentionDays})`),
    sql`not (${A.flags} && array['pending']::text[])`,
  );
  const rows = await db()
    .select({ question: A.question, status: A.status, mode: A.mode, citations: A.citations, createdAt: A.createdAt })
    .from(A)
    .where(unanswered ? and(fresh, ne(A.status, "answered")) : fresh)
    .orderBy(desc(A.createdAt), desc(A.id))
    .limit(FAQ_LIMITS.questionsListMax);
  const [{ n }] = await db().select({ n: count() }).from(A).where(and(fresh, ne(A.status, "answered")));

  const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: ev.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const days: { day: string; questions: QuestionRow[] }[] = [];
  for (const r of rows) {
    const day = dayOf.format(r.createdAt);
    let bucket = days[days.length - 1];
    if (!bucket || bucket.day !== day) {
      bucket = { day, questions: [] };
      days.push(bucket);
    }
    bucket.questions.push({ question: r.question, status: r.status, mode: r.mode, citations: r.citations });
  }
  return { days, unansweredCount: n, retentionDays: FAQ_LIMITS.retentionDays };
}

