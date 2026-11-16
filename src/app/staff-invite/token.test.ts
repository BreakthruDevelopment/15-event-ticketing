import { describe, expect, it } from "vitest";
import { acceptThenClear, hrefWithoutHash, keepToken, tokenFromHash, type FragmentToken } from "./token";

describe("tokenFromHash", () => {
  it("reads the token from the fragment only", () => {
    expect(tokenFromHash("#t=abc_DEF-123")).toEqual({ status: "ok", token: "abc_DEF-123" });
    expect(tokenFromHash("#t=ab%2Fc")).toEqual({ status: "ok", token: "ab/c" });
    expect(tokenFromHash("")).toEqual({ status: "missing" });
    expect(tokenFromHash("#joined")).toEqual({ status: "missing" });
    expect(tokenFromHash("#t=")).toEqual({ status: "invalid" });
    expect(tokenFromHash(`#t=${"a".repeat(201)}`)).toEqual({ status: "invalid" });
    expect(tokenFromHash("#t=a\0b")).toEqual({ status: "invalid" });
  });

  it("never treats a query string or a path as the token", () => {
    expect(tokenFromHash("?t=from-query")).toEqual({ status: "missing" });
    expect(tokenFromHash("t=from-query")).toEqual({ status: "missing" });
    expect(tokenFromHash("/staff-invite/from-path")).toEqual({ status: "missing" });
    expect(tokenFromHash("/staff-invite?t=from-query")).toEqual({ status: "missing" });
  });
});

describe("hrefWithoutHash", () => {
  it("drops the fragment and keeps the path", () => {
    expect(hrefWithoutHash("https://app.example/staff-invite#t=secret")).toBe("/staff-invite");
    expect(hrefWithoutHash("https://app.example/staff-invite?x=1#t=secret")).toBe("/staff-invite?x=1");
    expect(hrefWithoutHash("/staff-invite#t=secret")).toBe("/staff-invite");
  });
});

/** What the component does on each render: fold the hash it sees into the invite it holds. */
function held(hashes: string[]): FragmentToken {
  return hashes.reduce<FragmentToken>((h, hash) => keepToken(h, tokenFromHash(hash)), { status: "missing" });
}

describe("keepToken", () => {
  it("keeps the invite when a keyboard user activates the shell's skip link (#main)", () => {
    expect(held(["#t=abc", "#main"])).toEqual({ status: "ok", token: "abc" });
    expect(held(["#t=abc", "#main", "", "#other"])).toEqual({ status: "ok", token: "abc" });
  });

  it("starts missing and stays missing without a token", () => {
    expect(held([])).toEqual({ status: "missing" });
    expect(held(["", "#main"])).toEqual({ status: "missing" });
  });

  it("replaces the held invite when a different token arrives", () => {
    expect(held(["#t=first", "#main", "#t=second"])).toEqual({ status: "ok", token: "second" });
    expect(held(["#t=first", "#t="])).toEqual({ status: "invalid" });
    expect(held(["#t=", "#t=good"])).toEqual({ status: "ok", token: "good" });
  });

  it("returns the same object when nothing changed, so a render never loops", () => {
    const first = keepToken({ status: "missing" }, tokenFromHash("#t=abc"));
    expect(keepToken(first, tokenFromHash("#t=abc"))).toBe(first);
    expect(keepToken(first, tokenFromHash("#main"))).toBe(first);
  });
});

describe("acceptThenClear", () => {
  it("clears the fragment after a successful accept, and only then", async () => {
    let cleared = 0;
    const result = await acceptThenClear(async () => ({ ok: true as const, title: "T" }), () => void (cleared += 1));
    expect(result.ok).toBe(true);
    expect(cleared).toBe(1);
  });

  it("leaves the fragment in place after a rejected accept, so it can be retried", async () => {
    let cleared = 0;
    const result = await acceptThenClear(async () => ({ ok: false as const, error: "x" }), () => void (cleared += 1));
    expect(result.ok).toBe(false);
    expect(cleared).toBe(0);
  });

  it("leaves the fragment in place when the accept throws", async () => {
    let cleared = 0;
    await expect(acceptThenClear(async () => { throw new Error("network"); }, () => void (cleared += 1))).rejects.toThrow("network");
    expect(cleared).toBe(0);
  });
});
