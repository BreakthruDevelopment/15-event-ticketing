import { describe, expect, it } from "vitest";
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

const view = (s: string) => s.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/[。｡]/g, ".").toLowerCase();
const DOMAIN_CRUDE = /[\p{L}\p{N}\p{M}-]+\.\p{L}{2,}/gu;
const EMAIL_CRUDE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.\p{L}{2,}/gu;
const HOST_AFTER_SCHEME = /[a-z][a-z0-9+.-]*:\/\/([^\s/?#\\]+)/g;

/** Everything in the answer that names a place and is not in the source, per the crude scan. */
function ungrounded(answer: string, source: string): string[] {
  const a = view(answer);
  const s = view(source);
  const found = [...(a.match(DOMAIN_CRUDE) ?? []), ...(a.match(EMAIL_CRUDE) ?? []), ...[...a.matchAll(HOST_AFTER_SCHEME)].map((m) => m[1])];
  return found.filter((f) => !s.includes(f));
}

const SOURCES = [
  "Buy at https://tickets.example.com/EventPass today. Email hello@austinproductmeetup.example.",
  "Doors open at 6:30 PM CST. Parking is $10 in the Lamar Street garage.",
  "Visit tickets.example.com today, or write to hello@austinproductmeetup.example.",
];
const mapFor = (text: string): SourceMap => new Map([["F1", { id: "F1", kind: "faq", label: "Q", text: `Q\n${text}` }]]);

const HOSTS = [
  "evil.test", "Evil.TEST", "evil.test.", "tickets.example.com", "TICKETS.example.com", "www.tickets.example.com", "tickets.example.com.evil.test",
  "evil-tickets.example.com", "ticket5.example.com", "xn--e1aybc.xn--p1ai", "тест.рф", "bücher.example", "例え.jp", "раураl.com",
  "evil。test", "evil．test", "evil｡test", "evil​.test", "evil.te­st", "ev⁠il.test", "evil.﻿ test".replace(" ", ""),
  `${"a".repeat(60)}.test`, `${"a-".repeat(30)}b.test`, "a.b.c.d.e.f.g.test", "hello@austinproductmeetup.example", "hello@austinproductmeetup.example@evil.test",
  "evil@austinproductmeetup.example", "hello@evil.test", "localhost", "10.0.0.1", "evil",
];
const WRAPS = ["", "(", "[", "<", "‹", "“", "**", "_", "[x](", "see:", "see/", "see(", "tickets—", "\\", "//", "x", "mailto:", "https://", "http://", "HTTPS://", "xhttps://", "www.", "ftp://", "https://user@", "https:\\\\", "https:/\\", " "];
const TAILS = ["", "/", "/x", "/EventPass", "?q=1", "#f", "\\x", "\\..\\admin", "@evil.test", "-x/x#tickets.example.com/EventPass", "%2Fx", "%2fx", "/..", "//", "/%2e%2e/", ":443", ":8443", "?next=https://evil.test/x", "#@evil.test", "​/x", "~x", "+x", "=x", "&x"];
const CLOSERS = ["", ")", ">", "]", ".", ",", ").", "’", "**", "_", "”", "!", "?", "‹"];
const SPACES = [" ", " ", " ", "  ", " ", " ", "　", "\t", "​", "⁠"];
const FRAMES = ["Buy at %s today.", "Refunds: %s.", "See %s", "Write to %s for details.", "%s", "Go here: %s, then pay.", "[%s]", "<%s>", "Tickets are at %s today and %s tomorrow."];

function answerFrom(r: () => number): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const one = () => `${pick(WRAPS)}${pick(HOSTS)}${pick(TAILS)}${pick(CLOSERS)}`;
  const frame = pick(FRAMES);
  let out = frame.replace(/%s/g, one);
  if (r() < 0.2) out = out.replace(" ", pick(SPACES)); // odd whitespace between words
  if (r() < 0.15) out = `${out} ${one()}`; // a second, separate candidate
  return out;
}

describe("grounding property: an ungrounded domain, email or host never passes as the model's answer", () => {
  it("holds for 6000 seeded hostile answers against three sources", () => {
    // FAQ_PROPERTY_SEED / FAQ_PROPERTY_RUNS widen the hunt locally; CI uses the fixed defaults.
    const r = rng(Number(process.env.FAQ_PROPERTY_SEED ?? 20261115));
    const failures: string[] = [];
    let hostile = 0;
    const runs = Number(process.env.FAQ_PROPERTY_RUNS ?? 6000);
    for (let i = 0; i < runs; i++) {
      const answer = answerFrom(r);
      const source = SOURCES[i % SOURCES.length];
      if (ungrounded(answer, source).length === 0) continue;
      hostile++;
      const out = checkFaqAnswer({ status: "answered", answer, citations: ["F1"] }, mapFor(source));
      if (out.mode === "model") failures.push(`${JSON.stringify(answer)} against source #${i % SOURCES.length}`);
    }
    expect(failures.slice(0, 15), `${failures.length} bypasses`).toEqual([]);
    expect(hostile).toBeGreaterThan(runs / 2); // the generator really is producing hostile answers
  });

  it("the crude scan itself sees what it must (so the property is not vacuous)", () => {
    expect(ungrounded("Buy at тест.рф/pay", SOURCES[0])).toEqual(["тест.рф"]);
    expect(ungrounded("evil.test-x/x#tickets.example.com/EventPass", SOURCES[0])).toContain("evil.test");
    expect(ungrounded("hello@austinproductmeetup.example@evil.test", SOURCES[0])).toContain("evil.test");
    expect(ungrounded("Buy at https://tickets.example.com/EventPass", SOURCES[0])).toEqual([]);
  });
});
