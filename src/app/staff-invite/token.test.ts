import { describe, expect, it } from "vitest";
import { hrefWithoutHash, tokenFromHash } from "./token";

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
