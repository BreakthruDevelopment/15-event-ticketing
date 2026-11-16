/**
 * FAQ entries and the grounded FAQ bot against a real Postgres (TEST_DATABASE_URL): budget and ref numbers under
 * concurrency, idempotent CRUD, access rules, the answer cache, charges (once, never on a refusal or a replay), the
 * anonymous question store, and hidden, draft and cancelled events. The model is a stub; no test calls a real one.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { generate } from "@/lib/ai";
import type { FaqModelOutput } from "@/lib/ai/event-faq";
import { AiError } from "@/lib/ai/types";
import { DEMO_FAQ_PARKING_ID } from "@/lib/demo/ids";
import { entryChars, FAQ_LIMITS } from "@/lib/faq-schema";
import { type TestActor, cleanup, eventInput, fillRate, makeUser } from "./helpers";

const url = process.env.TEST_DATABASE_URL;
const P = "fq";
const uuid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!url)("FAQ entries and the FAQ bot (Postgres)", () => {
  let sql: postgres.Sql;
  let org: TestActor;
  let org2: TestActor;
  let att: TestActor;
  let att2: TestActor;
  let admin: TestActor;
  let EV: typeof import("@/lib/events");
  let TT: typeof import("@/lib/ticket-types");
  let FAQ: typeof import("@/lib/faq");
  let ASK: typeof import("@/lib/faq-ask");
  let ENV: typeof import("@/lib/env");

  type Ev = { id: string; version: number };

  /** A published event with one ticket type. */
  const mkEvent = async (who: TestActor = org, o: Record<string, unknown> = {}): Promise<Ev> => {
    const e = (await EV.createEvent(who, eventInput(o))).event;
    await TT.createTicketType(who, e.id, { name: "General", capacity: 10, clientOpId: uuid() });
    const pub = await EV.updateEvent(who, e.id, { version: e.version, status: "published" });
    return { id: pub.id, version: pub.version };
  };
  const mkDraft = async (who: TestActor = org) => (await EV.createEvent(who, eventInput())).event;
  const add = async (ev: { id: string }, question: string, answer: string, who: TestActor = org) =>
    (await FAQ.createFaqEntry(who, ev.id, { question, answer, clientOpId: uuid() })).entry;
  const faqVersion = async (id: string) => (await sql`select faq_version from event where id = ${id}`)[0].faq_version as number;
  const nextRef = async (id: string) => (await sql`select faq_next_ref from event where id = ${id}`)[0].faq_next_ref as number;
  const count = async (table: string, userId: string, kind: string) =>
    (await sql`select count(*)::int as n from rate_event where user_id = ${userId} and kind = ${kind}`)[0].n as number;
  const entryRows = async (id: string) => await sql`select ref_no, question, answer, version from faq_entry where event_id = ${id} order by ref_no`;
  const askRows = async (id: string) => await sql`select * from faq_ask where event_id = ${id} order by created_at`;
  const dailyAi = async () => (await sql`select coalesce(sum(count), 0)::int as n from daily_usage where kind = 'ai' and day = (now() at time zone 'utc')::date`)[0].n as number;
  const q = (question: string) => ({ question, clientOpId: uuid() });

  /** A stand-in for `generate()` that returns `out`, counting calls. */
  const model = (out: FaqModelOutput | (() => FaqModelOutput), delay = 0) =>
    vi.fn(async () => {
      if (delay) await sleep(delay);
      return { data: typeof out === "function" ? out() : out, provider: "stub", model: "stub", demo: false, latencyMs: 1 };
    }) as unknown as typeof generate & ReturnType<typeof vi.fn>;
  const PARK: FaqModelOutput = { status: "answered", answer: "Park in the Lamar Street garage, $10 for the evening.", citations: ["F1"] };
  const withParking = async (who = org) => {
    const ev = await mkEvent(who);
    await add(ev, "Where do I park?", "Lamar Street garage next to the venue, $10 for the evening.", who);
    return ev;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.AI_PROVIDER = "demo";
    process.env.LOG_LEVEL = "info";
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup(sql, P);
    org = await makeUser(sql, P, "org", "organizer");
    org2 = await makeUser(sql, P, "org2", "organizer");
    att = await makeUser(sql, P, "att", "user");
    att2 = await makeUser(sql, P, "att2", "user");
    admin = await makeUser(sql, P, "admin", "admin");
    EV = await import("@/lib/events");
    TT = await import("@/lib/ticket-types");
    FAQ = await import("@/lib/faq");
    ASK = await import("@/lib/faq-ask");
    ENV = await import("@/lib/env");
  });

  beforeEach(async () => {
    await sql`delete from event where organizer_id like ${`${P}-%`}`;
    await sql`delete from rate_event where user_id like ${`${P}-%`}`;
    await sql`delete from op_ledger where actor_id like ${`${P}-%`}`;
    await sql`delete from faq_entry where id = ${DEMO_FAQ_PARKING_ID}`;
    await sql`delete from daily_usage where kind = 'ai' and day = (now() at time zone 'utc')::date`;
    process.env.AI_PROVIDER = "demo";
    delete process.env.AI_DAILY_CAP;
    ENV.resetEnvCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(sql, P);
    await sql.end();
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("entries: refs, budget, versions", () => {
    it("creates entries with consecutive ref numbers, and every write bumps faq_version once", async () => {
      const ev = await mkEvent();
      const v0 = await faqVersion(ev.id);
      const a = await add(ev, "Where do I park?", "Garage.");
      const b = await add(ev, "Is there Wi-Fi?", "Yes.");
      expect([a.refNo, b.refNo]).toEqual([1, 2]);
      expect(await faqVersion(ev.id)).toBe(v0 + 2);
      await FAQ.updateFaqEntry(org, ev.id, a.id, { answer: "Garage on Lamar.", version: a.version, clientOpId: uuid() });
      expect(await faqVersion(ev.id)).toBe(v0 + 3);
      await FAQ.deleteFaqEntry(org, ev.id, b.id, { version: b.version, clientOpId: uuid() });
      expect(await faqVersion(ev.id)).toBe(v0 + 4);
    });

    it("a 41st entry is refused (409 faq_entry_limit) and burns no ref number", async () => {
      const ev = await mkEvent();
      for (let i = 0; i < FAQ_LIMITS.maxEntries; i++) await add(ev, `Question ${i}`, "A.");
      await expect(FAQ.createFaqEntry(org, ev.id, { question: "One more", answer: "No.", clientOpId: uuid() })).rejects.toMatchObject({ status: 409, code: "faq_entry_limit" });
      expect(await entryRows(ev.id)).toHaveLength(40);
      expect(await nextRef(ev.id)).toBe(41);
    });

    it("the 8,501st character is refused: ten entries fill 8,500 exactly, one more character fails on create and on update", async () => {
      const ev = await mkEvent();
      // 850 characters each as the prompt prints them: F<n> Q: <50 chars> A: <answer>\n
      const answerLen = (ref: number) => 850 - entryChars(ref, "x".repeat(50), "");
      const made = [];
      for (let ref = 1; ref <= 10; ref++) made.push(await add(ev, "x".repeat(50), "a".repeat(answerLen(ref))));
      const total = (await entryRows(ev.id)).reduce((n, r) => n + entryChars(r.ref_no, r.question, r.answer), 0);
      expect(total).toBe(FAQ_LIMITS.maxChars);
      await expect(FAQ.createFaqEntry(org, ev.id, { question: "q", answer: "a", clientOpId: uuid() })).rejects.toMatchObject({ status: 409, code: "faq_budget" });
      await expect(FAQ.updateFaqEntry(org, ev.id, made[0].id, { answer: "a".repeat(answerLen(1) + 1), version: made[0].version, clientOpId: uuid() })).rejects.toMatchObject({ status: 409, code: "faq_budget" });
      // Giving one character back makes room for exactly that character.
      const shrunk = await FAQ.updateFaqEntry(org, ev.id, made[0].id, { answer: "a".repeat(answerLen(1) - 1), version: made[0].version, clientOpId: uuid() });
      expect(shrunk.budget.chars).toBe(FAQ_LIMITS.maxChars - 1);
      await expect(FAQ.createFaqEntry(org, ev.id, { question: "q", answer: "a", clientOpId: uuid() })).rejects.toMatchObject({ code: "faq_budget" });
      expect(await nextRef(ev.id)).toBe(11);
    });

    it("field limits: question 200, answer 800, no NUL byte, no unknown keys (all 400)", async () => {
      const ev = await mkEvent();
      const bad = [
        { question: "q".repeat(201), answer: "a" },
        { question: "q", answer: "a".repeat(801) },
        { question: "", answer: "a" },
        { question: "q\0", answer: "a" },
        { question: "q", answer: "a\0" },
        { question: "q", answer: "a", extra: 1 },
        { question: "q", answer: "a", position: 1000 },
        { question: "q", answer: "a", clientOpId: "nope" },
      ];
      for (const b of bad) await expect(FAQ.createFaqEntry(org, ev.id, { clientOpId: uuid(), ...b }), JSON.stringify(b).slice(0, 40)).rejects.toMatchObject({ name: "ZodError" });
      await expect(FAQ.createFaqEntry(org, ev.id, { question: "q", answer: "a" })).rejects.toMatchObject({ name: "ZodError" });
      expect(await entryRows(ev.id)).toHaveLength(0);
      // exact maximum is fine
      await FAQ.createFaqEntry(org, ev.id, { question: "q".repeat(200), answer: "a".repeat(800), clientOpId: uuid() });
    });

    it("a refused write (bad body, NUL id, stale version, over budget) costs one api_write", async () => {
      const ev = await mkEvent();
      const e = await add(ev, "Q", "A");
      const before = await count("", org.id, "api_write");
      await expect(FAQ.createFaqEntry(org, ev.id, { question: "q\0", answer: "a", clientOpId: uuid() })).rejects.toMatchObject({ name: "ZodError" });
      await expect(FAQ.updateFaqEntry(org, ev.id, "not\0a-uuid", { answer: "x", version: 1, clientOpId: uuid() })).rejects.toMatchObject({ name: "ZodError" });
      await expect(FAQ.updateFaqEntry(org, ev.id, e.id, { answer: "x", version: 99, clientOpId: uuid() })).rejects.toMatchObject({ status: 409 });
      await expect(FAQ.deleteFaqEntry(org, ev.id, uuid(), { version: 1, clientOpId: uuid() })).rejects.toMatchObject({ status: 404 });
      expect(await count("", org.id, "api_write")).toBe(before + 4);
    });

    it("ref numbers are never reused after a delete", async () => {
      const ev = await mkEvent();
      const [a, b, c] = [await add(ev, "1", "a"), await add(ev, "2", "a"), await add(ev, "3", "a")];
      await FAQ.deleteFaqEntry(org, ev.id, c.id, { version: c.version, clientOpId: uuid() });
      await FAQ.deleteFaqEntry(org, ev.id, b.id, { version: b.version, clientOpId: uuid() });
      const d = await add(ev, "4", "a");
      expect([a.refNo, d.refNo]).toEqual([1, 4]);
      expect((await entryRows(ev.id)).map((r) => r.ref_no)).toEqual([1, 4]);
    });

    it("the 9,999th ref number is the last: after that 409 faq_refs_exhausted", async () => {
      const ev = await mkEvent();
      await sql`update event set faq_next_ref = 9999 where id = ${ev.id}`;
      expect((await add(ev, "last", "a")).refNo).toBe(9999);
      await expect(FAQ.createFaqEntry(org, ev.id, { question: "more", answer: "a", clientOpId: uuid() })).rejects.toMatchObject({ status: 409, code: "faq_refs_exhausted" });
      expect(await nextRef(ev.id)).toBe(10000);
      expect((await FAQ.readFaq(org, ev.id)).view === "owner" && (await FAQ.readFaq(org, ev.id))).toMatchObject({ nextRefNo: null });
    });

    it("45 parallel creates: exactly 40 succeed, refs 1 to 40 once each, the rest 409", async () => {
      const ev = await mkEvent();
      const results = await Promise.allSettled(Array.from({ length: 45 }, (_, i) => FAQ.createFaqEntry(org, ev.id, { question: `Q${i}`, answer: "A", clientOpId: uuid() })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(40);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 409, code: "faq_entry_limit" });
      expect((await entryRows(ev.id)).map((r) => r.ref_no)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    });

    it("parallel creates racing for the character budget never pass it", async () => {
      const ev = await mkEvent();
      const results = await Promise.allSettled(Array.from({ length: 14 }, (_, i) => FAQ.createFaqEntry(org, ev.id, { question: `Q${i}`, answer: "a".repeat(800), clientOpId: uuid() })));
      const rows = await entryRows(ev.id);
      const total = rows.reduce((n, r) => n + entryChars(r.ref_no, r.question, r.answer), 0);
      expect(total).toBeLessThanOrEqual(FAQ_LIMITS.maxChars);
      expect(rows.length).toBe(results.filter((r) => r.status === "fulfilled").length);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 409, code: "faq_budget" });
      expect(rows.length).toBeGreaterThanOrEqual(10);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("entries: idempotency and versions", () => {
    it("create: the same op id returns the first entry and adds nothing, even after the entry was edited", async () => {
      const ev = await mkEvent();
      const body = { question: "Where?", answer: "Here.", clientOpId: uuid() };
      const a = await FAQ.createFaqEntry(org, ev.id, body);
      expect(a.replayed).toBe(false);
      await FAQ.updateFaqEntry(org, ev.id, a.entry.id, { answer: "There.", version: a.entry.version, clientOpId: uuid() });
      const v = await faqVersion(ev.id);
      const b = await FAQ.createFaqEntry(org, ev.id, body);
      expect(b.replayed).toBe(true);
      expect(b.entry).toEqual(a.entry);
      expect(await entryRows(ev.id)).toHaveLength(1);
      expect(await faqVersion(ev.id)).toBe(v);
    });

    it("create: the same op id for a different request is 409 op_id_reused, and nothing changes", async () => {
      const ev = await mkEvent();
      const id = uuid();
      await FAQ.createFaqEntry(org, ev.id, { question: "A", answer: "a", clientOpId: id });
      await expect(FAQ.createFaqEntry(org, ev.id, { question: "B", answer: "a", clientOpId: id })).rejects.toMatchObject({ status: 409, code: "op_id_reused" });
      await expect(FAQ.updateFaqEntry(org, ev.id, uuid(), { answer: "x", version: 1, clientOpId: id })).rejects.toMatchObject({ code: "op_id_reused" });
      expect(await entryRows(ev.id)).toHaveLength(1);
    });

    it("create: parallel duplicates with one op id make one entry", async () => {
      const ev = await mkEvent();
      const body = { question: "Once", answer: "a", clientOpId: uuid() };
      const out = await Promise.all(Array.from({ length: 5 }, () => FAQ.createFaqEntry(org, ev.id, body)));
      expect(out.filter((o) => !o.replayed)).toHaveLength(1);
      expect(new Set(out.map((o) => o.entry.id)).size).toBe(1);
      expect(await entryRows(ev.id)).toHaveLength(1);
    });

    it("update: a stale version is 409 version_conflict with the current entry; a retry replays the first result", async () => {
      const ev = await mkEvent();
      const e = await add(ev, "Q", "A");
      const body = { answer: "B", version: e.version, clientOpId: uuid() };
      const first = await FAQ.updateFaqEntry(org, ev.id, e.id, body);
      expect(first).toMatchObject({ changed: true, replayed: false, entry: { answer: "B", version: e.version + 1 } });
      const again = await FAQ.updateFaqEntry(org, ev.id, e.id, body);
      expect(again).toMatchObject({ replayed: true, entry: first.entry });
      const stale = await FAQ.updateFaqEntry(org, ev.id, e.id, { answer: "C", version: e.version, clientOpId: uuid() }).catch((err) => err);
      expect(stale).toMatchObject({ status: 409, current: { entry: { answer: "B", version: e.version + 1 } } });
      expect((await entryRows(ev.id))[0].answer).toBe("B");
    });

    it("update: changing nothing is not a write (no version bump, no cache churn)", async () => {
      const ev = await mkEvent();
      const e = await add(ev, "Q", "A");
      const v = await faqVersion(ev.id);
      const r = await FAQ.updateFaqEntry(org, ev.id, e.id, { question: "Q", answer: "A", version: e.version, clientOpId: uuid() });
      expect(r.changed).toBe(false);
      expect(await faqVersion(ev.id)).toBe(v);
      expect((await entryRows(ev.id))[0].version).toBe(e.version);
    });

    it("update: reordering (position) is a write", async () => {
      const ev = await mkEvent();
      const a = await add(ev, "First", "a");
      const b = await add(ev, "Second", "a");
      const v = await faqVersion(ev.id);
      await FAQ.updateFaqEntry(org, ev.id, b.id, { position: 0, version: b.version, clientOpId: uuid() });
      await FAQ.updateFaqEntry(org, ev.id, a.id, { position: 1, version: a.version, clientOpId: uuid() });
      expect(await faqVersion(ev.id)).toBe(v + 2);
      const list = await FAQ.readFaq(org, ev.id);
      expect(list.entries.map((x) => x.question)).toEqual(["Second", "First"]);
    });

    it("delete: stale version 409, then ok; the same op id answers deleted again; a second delete with a new id is 404", async () => {
      const ev = await mkEvent();
      const e = await add(ev, "Q", "A");
      await expect(FAQ.deleteFaqEntry(org, ev.id, e.id, { version: 7, clientOpId: uuid() })).rejects.toMatchObject({ status: 409 });
      const body = { version: e.version, clientOpId: uuid() };
      expect(await FAQ.deleteFaqEntry(org, ev.id, e.id, body)).toMatchObject({ deleted: true, replayed: false });
      expect(await FAQ.deleteFaqEntry(org, ev.id, e.id, body)).toMatchObject({ deleted: true, replayed: true });
      await expect(FAQ.deleteFaqEntry(org, ev.id, e.id, { version: e.version, clientOpId: uuid() })).rejects.toMatchObject({ status: 404 });
    });

    it("a cancelled event's FAQ is read-only (409 event_cancelled), a replay still answers", async () => {
      const ev = await mkEvent();
      const body = { question: "Q", answer: "A", clientOpId: uuid() };
      await FAQ.createFaqEntry(org, ev.id, body);
      await EV.updateEvent(org, ev.id, { version: ev.version, status: "cancelled" });
      await expect(FAQ.createFaqEntry(org, ev.id, { question: "Q2", answer: "A", clientOpId: uuid() })).rejects.toMatchObject({ status: 409, code: "event_cancelled" });
      expect(await FAQ.createFaqEntry(org, ev.id, body)).toMatchObject({ replayed: true });
    });

    it("mixed parallel writes with event and ticket type edits: no deadlock, no 500, consistent state", async () => {
      const ev = await mkEvent();
      const seed = await Promise.all([add(ev, "A", "a"), add(ev, "B", "b"), add(ev, "C", "c")]);
      const t = (await EV.getMyEvent(org, ev.id)).ticketTypes[0];
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 6; i++) {
        ops.push(FAQ.createFaqEntry(org, ev.id, { question: `N${i}`, answer: "n", clientOpId: uuid() }));
        ops.push(FAQ.updateFaqEntry(org, ev.id, seed[i % 3].id, { answer: `x${i}`, version: seed[i % 3].version, clientOpId: uuid() }));
        ops.push(FAQ.deleteFaqEntry(org, ev.id, seed[i % 3].id, { version: seed[i % 3].version, clientOpId: uuid() }));
        ops.push(TT.updateTicketType(org, ev.id, t.id, { name: `General ${i}`, version: t.version + i }));
        ops.push(EV.updateEvent(org, ev.id, { version: ev.version, title: `Retitled ${i}` }));
        ops.push(ASK.askFaq(att, ev.id, q(`Question ${i}?`), { run: model({ status: "not_in_faq", answer: "", citations: [] }) }));
      }
      const results = await Promise.allSettled(ops);
      for (const r of results) if (r.status === "rejected") expect([404, 409, 429]).toContain((r.reason as { status?: number }).status);
      const rows = await entryRows(ev.id);
      expect(new Set(rows.map((r) => r.ref_no)).size).toBe(rows.length);
      expect(await nextRef(ev.id)).toBeGreaterThan(Math.max(0, ...rows.map((r) => r.ref_no)));
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("entries: access", () => {
    it("only the event's organiser may write: attendee and admin 403, nobody 401, another organiser 404", async () => {
      const ev = await mkEvent();
      const e = await add(ev, "Q", "A");
      const body = { question: "Q2", answer: "A", clientOpId: uuid() };
      for (const who of [att, admin]) {
        await expect(FAQ.createFaqEntry(who, ev.id, body)).rejects.toMatchObject({ status: 403 });
        await expect(FAQ.updateFaqEntry(who, ev.id, e.id, { answer: "x", version: 1, clientOpId: uuid() })).rejects.toMatchObject({ status: 403 });
        await expect(FAQ.deleteFaqEntry(who, ev.id, e.id, { version: 1, clientOpId: uuid() })).rejects.toMatchObject({ status: 403 });
      }
      await expect(FAQ.createFaqEntry(null, ev.id, body)).rejects.toMatchObject({ status: 401 });
      await expect(FAQ.createFaqEntry(org2, ev.id, body)).rejects.toMatchObject({ status: 404 });
      await expect(FAQ.updateFaqEntry(org2, ev.id, e.id, { answer: "x", version: 1, clientOpId: uuid() })).rejects.toMatchObject({ status: 404 });
      await expect(FAQ.deleteFaqEntry(org2, ev.id, e.id, { version: 1, clientOpId: uuid() })).rejects.toMatchObject({ status: 404 });
      await expect(FAQ.createFaqEntry(org, uuid(), body)).rejects.toMatchObject({ status: 404 });
      await expect(FAQ.createFaqEntry(org, "not\0uuid", body)).rejects.toMatchObject({ name: "ZodError" });
      expect(await entryRows(ev.id)).toHaveLength(1);
    });

    it("a revoked organiser can't write (the role is re-read from the database)", async () => {
      const ev = await mkEvent();
      await sql`update "user" set role = 'user' where id = ${org.id}`;
      try {
        await expect(FAQ.createFaqEntry(org, ev.id, { question: "Q", answer: "A", clientOpId: uuid() })).rejects.toMatchObject({ status: 403 });
      } finally {
        await sql`update "user" set role = 'organizer' where id = ${org.id}`;
      }
    });

    it("an entry of another event is a 404 under this event's id", async () => {
      const a = await mkEvent();
      const b = await mkEvent();
      const e = await add(a, "Q", "A");
      await expect(FAQ.updateFaqEntry(org, b.id, e.id, { answer: "x", version: e.version, clientOpId: uuid() })).rejects.toMatchObject({ status: 404 });
      await expect(FAQ.deleteFaqEntry(org, b.id, e.id, { version: e.version, clientOpId: uuid() })).rejects.toMatchObject({ status: 404 });
      expect(await entryRows(a.id)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("reading the FAQ", () => {
    it("the public sees a published event's entries (refNo, question, answer only) and spends no read", async () => {
      const ev = await mkEvent();
      await add(ev, "Where do I park?", "Garage.");
      const before = await count("", att.id, "api_read");
      const r = await FAQ.readFaq(att, ev.id);
      expect(r).toEqual({ view: "public", entries: [{ refNo: 1, question: "Where do I park?", answer: "Garage." }] });
      expect(await FAQ.readFaq(null, ev.id)).toEqual(r);
      expect(await count("", att.id, "api_read")).toBe(before);
    });

    it("a draft, a hidden event and a missing id are the same 404 for everyone but the owner; the other organiser is a visitor", async () => {
      const draft = await mkDraft();
      await add(draft, "Q", "A");
      const hidden = await mkEvent();
      await add(hidden, "Q", "A");
      await sql`update event set hidden_at = now(), hidden_reason = 'test' where id = ${hidden.id}`;
      for (const id of [draft.id, hidden.id, uuid()]) {
        for (const who of [null, att, org2, admin]) await expect(FAQ.readFaq(who, id)).rejects.toMatchObject({ status: 404 });
      }
      await expect(FAQ.readFaq(org, "not\0uuid")).rejects.toMatchObject({ name: "ZodError" });
    });

    it("a cancelled event's FAQ stays readable (its page still shows)", async () => {
      const ev = await mkEvent();
      await add(ev, "Q", "A");
      await EV.updateEvent(org, ev.id, { version: ev.version, status: "cancelled" });
      expect((await FAQ.readFaq(null, ev.id)).entries).toHaveLength(1);
    });

    it("the owner sees ids, versions, the budget and the next ref for any status, and spends one api_read", async () => {
      const draft = await mkDraft();
      const e = await add(draft, "Q", "Answer");
      const before = await count("", org.id, "api_read");
      const r = await FAQ.readFaq(org, draft.id);
      expect(r).toMatchObject({
        view: "owner",
        entries: [{ id: e.id, refNo: 1, version: 1 }],
        budget: { entries: 1, maxEntries: 40, chars: entryChars(1, "Q", "Answer"), maxChars: 8500 },
        nextRefNo: 2,
      });
      expect(await count("", org.id, "api_read")).toBe(before + 1);
    });

    it("a revoked organiser with a stale session role loses the owner view and the question list at once", async () => {
      const draft = await mkDraft();
      await add(draft, "Q", "A");
      await sql`update "user" set role = 'user' where id = ${org.id}`;
      try {
        // the session still says organizer: the database decides
        await expect(FAQ.readFaq({ id: org.id, role: "organizer" }, draft.id)).rejects.toMatchObject({ status: 404 });
        await expect(ASK.listQuestions({ id: org.id, role: "organizer" }, draft.id)).rejects.toMatchObject({ status: 404 });
      } finally {
        await sql`update "user" set role = 'organizer' where id = ${org.id}`;
      }
      await expect(FAQ.readFaq(org, draft.id)).resolves.toMatchObject({ view: "owner" });
    });

    it("the owner read is limited to the api_read allowance (429)", async () => {
      const ev = await mkEvent();
      await fillRate(sql, org.id, 1200, "api_read");
      await expect(FAQ.readFaq(org, ev.id)).rejects.toMatchObject({ status: 429 });
      // the public view of the same event doesn't need the allowance
      await expect(FAQ.readFaq(att, ev.id)).resolves.toMatchObject({ view: "public" });
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("asking: access, refusals and charges", () => {
    it("answers a signed-in attendee, spends one read and one ask, and stores one anonymous row", async () => {
      const ev = await withParking();
      const run = model(PARK);
      const r = await ASK.askFaq(att, ev.id, q("Where can I leave my car?"), { run });
      expect(r).toMatchObject({ status: "answered", mode: "model", answerMode: "model", demo: false, replayed: false, citations: [{ id: "F1", kind: "faq", refNo: 1 }] });
      expect(r.text).toBe(PARK.answer);
      expect(run).toHaveBeenCalledTimes(1);
      expect(await count("", att.id, "ai")).toBe(1);
      expect(await count("", att.id, "api_read")).toBe(1);
      expect(await askRows(ev.id)).toHaveLength(1);
    });

    it("anonymous 401, admin 403, malformed input 400 with no ask charged (the read is spent, nothing else)", async () => {
      const ev = await withParking();
      const run = model(PARK);
      await expect(ASK.askFaq(null, ev.id, q("hi"), { run })).rejects.toMatchObject({ status: 401 });
      await expect(ASK.askFaq(admin, ev.id, q("hi"), { run })).rejects.toMatchObject({ status: 403 });
      for (const bad of [{ question: "", clientOpId: uuid() }, { question: "x".repeat(301), clientOpId: uuid() }, { question: "a\0b", clientOpId: uuid() }, { question: "hi" }, { question: "hi", clientOpId: uuid(), extra: 1 }]) {
        await expect(ASK.askFaq(att, ev.id, bad, { run })).rejects.toMatchObject({ name: "ZodError" });
      }
      await expect(ASK.askFaq(att, "x\0y", q("hi"), { run })).rejects.toMatchObject({ name: "ZodError" });
      expect(run).not.toHaveBeenCalled();
      expect(await count("", att.id, "ai")).toBe(0);
      expect(await count("", att.id, "api_read")).toBe(6);
      expect(await dailyAi()).toBe(0);
      expect(await askRows(ev.id)).toHaveLength(0);
    });

    it("a 300-character question is the maximum", async () => {
      const ev = await withParking();
      await expect(ASK.askFaq(att, ev.id, q("x".repeat(300)), { run: model(PARK) })).resolves.toMatchObject({ status: "answered" });
    });

    it("draft, hidden and missing events are the same 404; cancelled is 409; none is charged an ask or stored", async () => {
      const run = model(PARK);
      const draft = await mkDraft();
      const hidden = await mkEvent();
      await sql`update event set hidden_at = now(), hidden_reason = 'x' where id = ${hidden.id}`;
      const cancelled = await mkEvent();
      await EV.updateEvent(org, cancelled.id, { version: cancelled.version, status: "cancelled" });
      for (const id of [draft.id, hidden.id, uuid()]) await expect(ASK.askFaq(att, id, q("hi"), { run })).rejects.toMatchObject({ status: 404 });
      await expect(ASK.askFaq(att, cancelled.id, q("hi"), { run })).rejects.toMatchObject({ status: 409, code: "event_cancelled" });
      // another organiser asks as an attendee: same rules
      await expect(ASK.askFaq(org2, draft.id, q("hi"), { run })).rejects.toMatchObject({ status: 404 });
      expect(run).not.toHaveBeenCalled();
      expect(await count("", att.id, "ai")).toBe(0);
      expect(await dailyAi()).toBe(0);
      expect((await sql`select count(*)::int as n from faq_ask where event_id in ${sql([draft.id, hidden.id, cancelled.id])}`)[0].n).toBe(0);
    });

    it("the event's own organiser can try the bot on a draft: nothing is stored and the cache is not used or filled", async () => {
      const draft = await mkDraft();
      await add(draft, "Where do I park?", "Lamar Street garage next to the venue, $10 for the evening.");
      const run = model(PARK);
      const a = await ASK.askFaq(org, draft.id, q("Where do I park?"), { run });
      const b = await ASK.askFaq(org, draft.id, q("Where do I park?"), { run });
      expect(a.mode).toBe("model");
      expect(b.mode).toBe("model");
      expect(run).toHaveBeenCalledTimes(2);
      expect(await askRows(draft.id)).toHaveLength(0);
      expect(await count("", org.id, "ai")).toBe(2);
    });

    it("a stale organiser role can't use the owner path: the role is re-read at the claim", async () => {
      const draft = await mkDraft();
      await sql`update "user" set role = 'user' where id = ${org.id}`;
      try {
        await expect(ASK.askFaq({ id: org.id, role: "organizer" }, draft.id, q("hi"), { run: model(PARK) })).rejects.toMatchObject({ status: 404 });
        expect(await count("", org.id, "ai")).toBe(0);
      } finally {
        await sql`update "user" set role = 'organizer' where id = ${org.id}`;
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("asking: replay, cache and caps", () => {
    it("a retry with the same op id returns the first answer, charges nothing more and calls no model", async () => {
      const ev = await withParking();
      const run = model(PARK);
      const body = q("Where can I leave my car?");
      const a = await ASK.askFaq(att, ev.id, body, { run });
      const b = await ASK.askFaq(att, ev.id, body, { run });
      expect(b).toEqual({ ...a, replayed: true });
      expect(run).toHaveBeenCalledTimes(1);
      expect(await count("", att.id, "ai")).toBe(1);
      expect(await dailyAi()).toBe(1);
      expect(await askRows(ev.id)).toHaveLength(1);
    });

    it("the same op id for another question (or another event) is 409 op_id_reused and charges no ask", async () => {
      const ev = await withParking();
      const other = await withParking();
      const run = model(PARK);
      const body = q("Where can I leave my car?");
      await ASK.askFaq(att, ev.id, body, { run });
      await expect(ASK.askFaq(att, ev.id, { ...body, question: "Something else?" }, { run })).rejects.toMatchObject({ status: 409, code: "op_id_reused" });
      await expect(ASK.askFaq(att, other.id, body, { run })).rejects.toMatchObject({ status: 409, code: "op_id_reused" });
      expect(run).toHaveBeenCalledTimes(1);
      expect(await count("", att.id, "ai")).toBe(1);
    });

    it("parallel duplicates with one op id: one model call, one charge, the other sees the first answer or a 409 retry", async () => {
      const ev = await withParking();
      const run = model(PARK, 60);
      const body = q("Where can I leave my car?");
      const results = await Promise.allSettled([ASK.askFaq(att, ev.id, body, { run }), ASK.askFaq(att, ev.id, body, { run })]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(lost?.reason).toMatchObject({ status: 409, code: "retry" });
      expect(run).toHaveBeenCalledTimes(1);
      expect(await count("", att.id, "ai")).toBe(1);
      // once the first finished, the retry returns its answer
      expect(await ASK.askFaq(att, ev.id, body, { run })).toMatchObject({ replayed: true, status: "answered" });
    });

    it("the same question again (new op id) is a cache hit for anyone: no model, no ask charged, no new row", async () => {
      const ev = await withParking();
      const run = model(PARK);
      await ASK.askFaq(att, ev.id, q("Where can I leave my car?"), { run });
      const hit = await ASK.askFaq(att2, ev.id, q("  where can I leave my CAR  "), { run });
      expect(hit).toMatchObject({ status: "answered", mode: "cached", answerMode: "model", text: PARK.answer, demo: false });
      expect(run).toHaveBeenCalledTimes(1);
      expect(await count("", att2.id, "ai")).toBe(0);
      expect(await count("", att2.id, "api_read")).toBe(1);
      expect(await dailyAi()).toBe(1);
      expect(await askRows(ev.id)).toHaveLength(1);
    });

    it("the cache misses after an FAQ edit (create, update, delete) and hits again on the new version", async () => {
      const ev = await withParking();
      const run = model(PARK);
      const ask = () => ASK.askFaq(att, ev.id, q("Where can I leave my car?"), { run });
      await ask();
      expect((await ask()).mode).toBe("cached");
      const extra = await add(ev, "Is there Wi-Fi?", "Yes.");
      expect((await ask()).mode).toBe("model");
      expect((await ask()).mode).toBe("cached");
      await FAQ.updateFaqEntry(org, ev.id, extra.id, { answer: "Yes, free.", version: extra.version, clientOpId: uuid() });
      expect((await ask()).mode).toBe("model");
      await FAQ.deleteFaqEntry(org, ev.id, extra.id, { version: extra.version + 1, clientOpId: uuid() });
      expect((await ask()).mode).toBe("model");
      expect((await ask()).mode).toBe("cached");
      expect(run).toHaveBeenCalledTimes(4);
    });

    it("the cache misses after an event-detail edit (doors time changed) and after a ticket type rename, and survives an edit that isn't in the prompt", async () => {
      const ev = await withParking();
      const run = model({ status: "answered", answer: "Doors open shortly before the start.", citations: ["E1"] });
      const ask = () => ASK.askFaq(att, ev.id, q("When do doors open?"), { run });
      await ask();
      expect((await ask()).mode).toBe("cached");
      const cur = await EV.getMyEvent(org, ev.id);
      const doors = new Date(new Date(cur.startsAt).getTime() - 30 * 60_000).toISOString();
      const v1 = await faqVersion(ev.id);
      const after = await EV.updateEvent(org, ev.id, { version: cur.version, doorsAt: doors });
      expect(await faqVersion(ev.id)).toBe(v1 + 1);
      expect((await ask()).mode).toBe("model");
      expect((await ask()).mode).toBe("cached");
      await TT.updateTicketType(org, ev.id, after.ticketTypes[0].id, { name: "General admission", version: after.ticketTypes[0].version });
      expect((await ask()).mode).toBe("model");
      expect((await ask()).mode).toBe("cached");
      // capacity and max-per-registration aren't in the prompt
      const t2 = (await EV.getMyEvent(org, ev.id)).ticketTypes[0];
      await TT.updateTicketType(org, ev.id, t2.id, { capacity: 20, version: t2.version });
      await EV.updateEvent(org, ev.id, { version: (await EV.getMyEvent(org, ev.id)).version, maxPerRegistration: 2 });
      expect((await ask()).mode).toBe("cached");
      expect(run).toHaveBeenCalledTimes(3);
    });

    it("a cached answer older than 24 hours is not served; a pending or uncached row is never served", async () => {
      const ev = await withParking();
      const run = model(PARK);
      const ask = () => ASK.askFaq(att, ev.id, q("Where can I leave my car?"), { run });
      await ask();
      await sql`update faq_ask set created_at = now() - interval '25 hours' where event_id = ${ev.id}`;
      expect((await ask()).mode).toBe("model");
      await sql`update faq_ask set flags = array['uncached'] where event_id = ${ev.id}`;
      expect((await ask()).mode).toBe("model");
      await sql`update faq_ask set flags = array['pending'] where event_id = ${ev.id}`;
      expect((await ask()).mode).toBe("model");
    });

    it("10 asks per user per hour: the 11th is 429 and rolls everything back; a cached answer still works", async () => {
      const ev = await withParking();
      const run = model(PARK);
      for (let i = 0; i < FAQ_LIMITS.asksPerHour; i++) await ASK.askFaq(att, ev.id, q(`Question ${i}?`), { run });
      const dailyBefore = await dailyAi();
      const body = q("One too many?");
      await expect(ASK.askFaq(att, ev.id, body, { run })).rejects.toMatchObject({ status: 429 });
      expect(await count("", att.id, "ai")).toBe(10);
      expect(await dailyAi()).toBe(dailyBefore);
      expect(await askRows(ev.id)).toHaveLength(10);
      expect((await sql`select count(*)::int as n from op_ledger where actor_id = ${att.id} and client_op_id = ${body.clientOpId}`)[0].n).toBe(0);
      expect((await ASK.askFaq(att, ev.id, q("question 3"), { run })).mode).toBe("cached");
    });

    it("300 asks per event per day: the 301st is 429, nothing charged; another event is unaffected", async () => {
      const ev = await withParking();
      const other = await withParking();
      await sql`insert into faq_ask (event_id, question, q_hash, faq_version, status, mode) select ${ev.id}, 'q' || g, 'h' || g, 1, 'answered', 'model' from generate_series(1, ${FAQ_LIMITS.asksPerEventPerDay}::int) g`;
      const run = model(PARK);
      await expect(ASK.askFaq(att, ev.id, q("Too many today?"), { run })).rejects.toMatchObject({ status: 429 });
      expect(run).not.toHaveBeenCalled();
      expect(await count("", att.id, "ai")).toBe(0);
      expect(await dailyAi()).toBe(0);
      await expect(ASK.askFaq(att, other.id, q("Fine here?"), { run })).resolves.toMatchObject({ status: "answered" });
    });

    it("the per-event daily cap is exact with answers in flight: 12 parallel askers, 5 slots left, exactly 5 answered", async () => {
      const ev = await withParking();
      await sql`insert into faq_ask (event_id, question, q_hash, faq_version, status, mode) select ${ev.id}, 'q' || g, 'h' || g, 1, 'answered', 'model' from generate_series(1, ${FAQ_LIMITS.asksPerEventPerDay - 5}::int) g`;
      const users = await Promise.all(Array.from({ length: 12 }, (_, i) => makeUser(sql, P, `par${i}`, "user")));
      const run = model(PARK, 80);
      const results = await Promise.allSettled(users.map((u, i) => ASK.askFaq(u, ev.id, q(`Parallel question ${i}?`), { run })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 429 });
      expect(await askRows(ev.id)).toHaveLength(FAQ_LIMITS.asksPerEventPerDay);
      expect((await sql`select count(*)::int as n from faq_ask where event_id = ${ev.id} and 'pending' = any(flags)`)[0].n).toBe(0);
    });

    it("the app-wide daily cap (AI_DAILY_CAP) is 429 and refunds the user's allowance", async () => {
      const ev = await withParking();
      await sql`delete from daily_usage where kind = 'ai' and day = (now() at time zone 'utc')::date`;
      process.env.AI_DAILY_CAP = "2";
      ENV.resetEnvCache();
      const run = model(PARK);
      await ASK.askFaq(att, ev.id, q("One?"), { run });
      await ASK.askFaq(att2, ev.id, q("Two?"), { run });
      const body = q("Three?");
      await expect(ASK.askFaq(att, ev.id, body, { run })).rejects.toMatchObject({ status: 429 });
      expect(await count("", att.id, "ai")).toBe(1);
      expect(await dailyAi()).toBe(2);
      expect(await askRows(ev.id)).toHaveLength(2);
      expect((await sql`select count(*)::int as n from op_ledger where client_op_id = ${body.clientOpId}`)[0].n).toBe(0);
      await sql`delete from daily_usage where kind = 'ai' and day = (now() at time zone 'utc')::date`;
    });

    it("a failing model call gives the charge, the daily slot and the claim back, and the retry with the same op id runs fresh", async () => {
      const ev = await withParking();
      const body = q("Where can I leave my car?");
      const dailyBefore = await dailyAi();
      const broken = vi.fn(async () => {
        throw new AiError("down", "provider", 503);
      }) as unknown as typeof generate;
      await expect(ASK.askFaq(att, ev.id, body, { run: broken })).rejects.toBeInstanceOf(AiError);
      expect(await count("", att.id, "ai")).toBe(0);
      expect(await dailyAi()).toBe(dailyBefore);
      expect(await askRows(ev.id)).toHaveLength(0);
      expect((await sql`select count(*)::int as n from op_ledger where client_op_id = ${body.clientOpId}`)[0].n).toBe(0);
      const ok = await ASK.askFaq(att, ev.id, body, { run: model(PARK) });
      expect(ok).toMatchObject({ status: "answered", replayed: false });
      expect(await count("", att.id, "ai")).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("asking: grounding, storage and privacy", () => {
    it("a citation of another event's entry is dropped: not_in_faq, no $25, nothing of the other event stored", async () => {
      const a = await mkEvent();
      for (const [qq, aa] of [["One", "1"], ["Two", "2"], ["Where do I park?", "Garage A, $25."]]) await add(a, qq, aa);
      const b = await mkEvent(org2);
      await add(b, "Only entry", "Hello.", org2);
      const r = await ASK.askFaq(att, b.id, q("Where do I park?"), { run: model({ status: "answered", answer: "Parking is $25.", citations: ["F3", "F99"] }) });
      expect(r).toMatchObject({ status: "not_in_faq", mode: "model", citations: [] });
      expect(r.text).not.toContain("$25");
      expect(r.text).toContain("doesn't cover that");
      const [row] = await askRows(b.id);
      expect(row).toMatchObject({ status: "not_in_faq", answer: null, mode: "model" });
      expect(row.citations).toEqual([]);
      expect(row.flags).toEqual(expect.arrayContaining(["unknown_citation", "no_valid_citation"]));
    });

    it("an event whose entry sits at the same ref number in another event is cited against ITS OWN text", async () => {
      const a = await mkEvent();
      await add(a, "Where do I park?", "Garage A, $25.");
      const b = await mkEvent(org2);
      await add(b, "Where do I park?", "Street parking, free.", org2);
      const r = await ASK.askFaq(att, b.id, q("Where do I park?"), { run: model({ status: "answered", answer: "Garage A costs $25.", citations: ["F1"] }) });
      expect(r.mode).toBe("quoted");
      expect(r.text).toContain("Street parking, free.");
      expect(r.text).not.toContain("$25");
    });

    it("a quoted answer stores answer null and renders from the cited entries; the cache renders it the same", async () => {
      const ev = await withParking();
      const run = model({ status: "answered", answer: "It costs $12.", citations: ["F1"] });
      const first = await ASK.askFaq(att, ev.id, q("How much is parking?"), { run });
      expect(first).toMatchObject({ status: "answered", mode: "quoted", answerMode: "quoted" });
      expect(first.text).toBe("From the organiser's FAQ:\n\nWhere do I park?\nLamar Street garage next to the venue, $10 for the evening.");
      const [row] = await askRows(ev.id);
      expect(row).toMatchObject({ answer: null, mode: "quoted", citations: ["F1"] });
      const hit = await ASK.askFaq(att2, ev.id, q("how much is parking"), { run });
      expect(hit).toMatchObject({ mode: "cached", answerMode: "quoted", text: first.text });
    });

    it("not_in_faq renders the fixed line with the contact email, stores answer null", async () => {
      const ev = await mkEvent(org, { contactEmail: "hello@example.org" });
      await add(ev, "Where do I park?", "Garage.");
      const r = await ASK.askFaq(att, ev.id, q("Can I bring my dog?"), { run: model({ status: "not_in_faq", answer: "Sure!", citations: ["F1"] }) });
      expect(r.text).toBe("The organiser's FAQ doesn't cover that. You can contact the organiser at hello@example.org.");
      expect(r.citations).toEqual([]);
      expect((await askRows(ev.id))[0]).toMatchObject({ answer: null, status: "not_in_faq" });
    });

    it("demo mode shows the recorded parking answer only when matchFaq agrees, against an entry with DEMO_FAQ_PARKING_ID", async () => {
      const ev = await mkEvent();
      await add(ev, "What kind of meetup is this?", "A product meetup.");
      await sql`insert into faq_entry (id, event_id, ref_no, question, answer, position) values (${DEMO_FAQ_PARKING_ID}, ${ev.id}, 3, 'Where do I park?', 'Lamar Street garage next to the venue, $10 for the evening.', 2)`;
      await sql`update event set faq_next_ref = 4, faq_version = faq_version + 1 where id = ${ev.id}`;
      const parking = await ASK.askFaq(att, ev.id, q("Where can I park?"));
      expect(parking).toMatchObject({ status: "answered", mode: "model", demo: true, citations: [{ id: "F3", refNo: 3 }] });
      expect(parking.text).toContain("Recorded demo answer");
      const dog = await ASK.askFaq(att, ev.id, q("Can I bring my dog?"));
      expect(dog).toMatchObject({ status: "not_in_faq", demo: true, citations: [] });
      expect(dog.text).not.toContain("Lamar");
      const what = await ASK.askFaq(att, ev.id, q("What kind of meetup?"));
      expect(what).toMatchObject({ status: "answered", mode: "lookup", citations: [{ id: "F1" }] });
      expect(what.text).toBe("From the organiser's FAQ:\n\nWhat kind of meetup is this?\nA product meetup.");
      // a lookup answer stores answer null
      expect((await sql`select answer, mode from faq_ask where event_id = ${ev.id} and q_hash = ${(await askRows(ev.id)).at(-1)!.q_hash}`)[0]).toMatchObject({ answer: null, mode: "lookup" });
    });

    it("another event never gets the recorded parking answer, even for a parking question", async () => {
      const ev = await mkEvent();
      await add(ev, "Where do I park?", "On the street.");
      const r = await ASK.askFaq(att, ev.id, q("Where can I park?"));
      expect(r).toMatchObject({ mode: "lookup", demo: true });
      expect(r.text).toContain("On the street.");
      expect(r.text).not.toContain("Lamar");
    });

    it("demo answers are cached when AI_PROVIDER is demo, but a demo fallback made while a live provider is set is not", async () => {
      const ev = await mkEvent();
      await add(ev, "Where do I park?", "On the street.");
      expect((await ASK.askFaq(att, ev.id, q("Where can I park?"))).mode).toBe("lookup");
      expect((await ASK.askFaq(att2, ev.id, q("Where can I park?"))).mode).toBe("cached");
      process.env.AI_PROVIDER = "gemini";
      process.env.GEMINI_API_KEY = ""; // no key: the provider is "configured" but missing, so generate() answers from the fixture
      ENV.resetEnvCache();
      const ev2 = await mkEvent();
      await add(ev2, "Where do I park?", "On the street.");
      const live = (n: string) => ASK.askFaq(att, ev2.id, q(n));
      expect((await live("Where can I park?")).mode).toBe("lookup");
      expect((await sql`select flags from faq_ask where event_id = ${ev2.id}`)[0].flags).toEqual(expect.arrayContaining(["demo", "uncached"]));
      expect((await live("Where can I park?")).mode).toBe("lookup");
    });

    it("faq_ask has no user column, created_at is stored to the hour, and the row holds nothing that names the asker", async () => {
      const ev = await withParking();
      await ASK.askFaq(att, ev.id, q("Where can I leave my car?"), { run: model(PARK) });
      const cols = (await sql`select column_name from information_schema.columns where table_name = 'faq_ask'`).map((c) => c.column_name as string);
      expect(cols.filter((c) => /user|actor|owner|ip|session/i.test(c))).toEqual([]);
      const rows = await askRows(ev.id);
      expect(rows).toHaveLength(1);
      expect((await sql`select (created_at = date_trunc('hour', created_at)) as ok from faq_ask where event_id = ${ev.id}`)[0].ok).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(att.id);
    });

    it("logs carry task facts only: never the question, the answer, a user id or an email", async () => {
      const ev = await mkEvent(org, { contactEmail: "contact@example.org" });
      await add(ev, "Where do I park?", "Lamar Street garage next to the venue, $10 for the evening.");
      const lines: string[] = [];
      for (const fn of ["log", "error", "warn"] as const) vi.spyOn(console, fn).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
      await ASK.askFaq(att, ev.id, q("SECRET-QUESTION-TEXT where can I leave my car?"), { run: model(PARK) });
      await ASK.askFaq(att, ev.id, q("SECRET-QUESTION-TWO dogs?"), { run: model({ status: "not_in_faq", answer: "", citations: [] }) });
      const all = lines.join("\n");
      expect(all).toContain("faq.ask");
      for (const secret of ["SECRET-QUESTION", "Lamar Street", att.id, "contact@example.org", PARK.answer]) expect(all).not.toContain(secret);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("organiser's question list", () => {
    const seedRow = (eventId: string, question: string, status: string, ageHours: number, flags = "{}") =>
      sql`insert into faq_ask (event_id, question, q_hash, faq_version, status, mode, flags, created_at)
          values (${eventId}, ${question}, ${question}, 1, ${status}, 'model', ${flags}::text[], date_trunc('hour', now() - make_interval(hours => ${ageHours})))`;

    it("groups the last 30 days by day, newest first, with no user and no time of day; pending and older rows are left out", async () => {
      const ev = await mkEvent(org, { timeZone: "UTC" });
      await seedRow(ev.id, "today a", "answered", 0);
      await seedRow(ev.id, "today b", "not_in_faq", 0);
      await seedRow(ev.id, "two days ago", "off_topic", 50);
      await seedRow(ev.id, "29 days ago", "answered", 29 * 24);
      await seedRow(ev.id, "31 days ago", "not_in_faq", 31 * 24);
      await seedRow(ev.id, "still pending", "not_in_faq", 0, "{pending}");
      const before = await count("", org.id, "api_read");
      const r = await ASK.listQuestions(org, ev.id);
      expect(await count("", org.id, "api_read")).toBe(before + 1);
      const flat = r.days.flatMap((d) => d.questions.map((x) => x.question));
      expect(flat).toEqual(expect.arrayContaining(["today a", "today b", "two days ago", "29 days ago"]));
      expect(flat).not.toContain("31 days ago");
      expect(flat).not.toContain("still pending");
      expect(r.days.map((d) => d.day)).toEqual([...r.days.map((d) => d.day)].sort().reverse());
      expect(r.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day))).toBe(true);
      expect(r.unansweredCount).toBe(2);
      expect(r.retentionDays).toBe(30);
      expect(Object.keys(r.days[0].questions[0]).sort()).toEqual(["citations", "mode", "question", "status"]);
      expect((await ASK.listQuestions(org, ev.id, { unanswered: "1" })).days.flatMap((d) => d.questions).every((x) => x.status !== "answered")).toBe(true);
    });

    it("only the event's organiser reads them: attendee and admin 403, another organiser and a missing id 404, a bad query 400", async () => {
      const ev = await mkEvent();
      await expect(ASK.listQuestions(att, ev.id)).rejects.toMatchObject({ status: 403 });
      await expect(ASK.listQuestions(admin, ev.id)).rejects.toMatchObject({ status: 403 });
      await expect(ASK.listQuestions(null, ev.id)).rejects.toMatchObject({ status: 401 });
      await expect(ASK.listQuestions(org2, ev.id)).rejects.toMatchObject({ status: 404 });
      await expect(ASK.listQuestions(org, uuid())).rejects.toMatchObject({ status: 404 });
      await expect(ASK.listQuestions(org, ev.id, { unanswered: "yes" })).rejects.toMatchObject({ name: "ZodError" });
      await expect(ASK.listQuestions(org, ev.id, { other: "1" })).rejects.toMatchObject({ name: "ZodError" });
    });

    it("returns at most 200 questions and is limited to the api_read allowance", async () => {
      const ev = await mkEvent();
      await sql`insert into faq_ask (event_id, question, q_hash, faq_version, status, mode) select ${ev.id}, 'q' || g, 'h' || g, 1, 'not_in_faq', 'model' from generate_series(1, 250) g`;
      const r = await ASK.listQuestions(org, ev.id);
      expect(r.days.flatMap((d) => d.questions)).toHaveLength(FAQ_LIMITS.questionsListMax);
      expect(r.unansweredCount).toBe(250);
      await fillRate(sql, org.id, 1200, "api_read");
      await expect(ASK.listQuestions(org, ev.id)).rejects.toMatchObject({ status: 429 });
    });

    it("an ask prunes rows past 30 days", async () => {
      const ev = await withParking();
      await seedRow(ev.id, "ancient", "not_in_faq", 31 * 24);
      await ASK.askFaq(att, ev.id, q("Where can I leave my car?"), { run: model(PARK) });
      expect((await askRows(ev.id)).map((r) => r.question)).not.toContain("ancient");
    });

    it("deleting the event removes its entries and questions (cascade)", async () => {
      const ev = await mkEvent();
      await add(ev, "Q", "A");
      await seedRow(ev.id, "asked", "not_in_faq", 0);
      await EV.updateEvent(org, ev.id, { version: ev.version, status: "cancelled" });
      await EV.deleteEvent(org, ev.id);
      expect((await sql`select count(*)::int as n from faq_entry where event_id = ${ev.id}`)[0].n).toBe(0);
      expect((await sql`select count(*)::int as n from faq_ask where event_id = ${ev.id}`)[0].n).toBe(0);
    });
  });
});
