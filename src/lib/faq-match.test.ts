import { describe, expect, it } from "vitest";
import { matchFaq, stem, stems } from "./faq-match";

const entries = [
  { id: "a", refNo: 1, question: "What is this event?", answer: "An evening of demos." },
  { id: "b", refNo: 3, question: "Where do I park?", answer: "Lamar Street garage next to the venue, $10 for the evening." },
  { id: "c", refNo: 7, question: "Is there Wi-Fi?", answer: "Yes, ask at the front desk." },
  { id: "d", refNo: 9, question: "Can I bring a guest?", answer: "Up to 4 tickets per registration." },
];

describe("stemming", () => {
  it("makes parking, parks and parked the same word", () => {
    expect(new Set(["parking", "parks", "parked", "park"].map(stem))).toEqual(new Set(["park"]));
  });
  it("drops stop words and joins hyphenated words", () => {
    expect([...stems("Where can I get Wi-Fi?")].sort()).toEqual(["wifi"]);
  });
});

describe("matchFaq", () => {
  it("matches a parking question to the parking entry, stemmed", () => {
    expect(matchFaq("Where can I park?", entries)[0]).toMatchObject({ id: "b", refNo: 3 });
    expect(matchFaq("Is there parking?", entries)[0]).toMatchObject({ id: "b" });
  });
  it("matches nothing for a dog question, even though 'bring' appears in an entry", () => {
    expect(matchFaq("Can I bring my dog?", entries)).toEqual([]);
  });
  it("matches nothing for a question with only stop words or noise", () => {
    expect(matchFaq("what is the", entries)).toEqual([]);
    expect(matchFaq("???", entries)).toEqual([]);
  });
  it("needs more than a stray answer word", () => {
    expect(matchFaq("Is the evening good?", entries)).toEqual([]);
  });
  it("returns at most two, best first, ties by ref number", () => {
    const twin = [
      { id: "x", refNo: 2, question: "Is there coffee?", answer: "Yes." },
      { id: "y", refNo: 1, question: "Is there coffee?", answer: "Yes." },
      { id: "z", refNo: 3, question: "Is there coffee?", answer: "Yes." },
    ];
    expect(matchFaq("coffee?", twin).map((m) => m.refNo)).toEqual([1, 2]);
  });
  it("is deterministic and never throws on odd input", () => {
    expect(matchFaq("ü\u0000<script>", entries)).toEqual(matchFaq("ü\u0000<script>", entries));
    expect(matchFaq("park", [])).toEqual([]);
  });
});
