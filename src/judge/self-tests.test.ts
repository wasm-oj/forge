import { describe, expect, it } from "vitest";
import {
  decodeSelfTestCases,
  defaultSelfTestCases,
  encodeSelfTestCases,
  MAX_SELF_TEST_CASES,
  selfTestStorageKey,
} from "./self-tests";

describe("self-test workspace", () => {
  it("starts with one case seeded from the first sample", () => {
    expect(decodeSelfTestCases(null, "3 4\n")).toEqual(defaultSelfTestCases("3 4\n"));
  });

  it("round-trips a bounded multi-case workspace", () => {
    const cases = [
      { id: "first", name: "Small", input: "1\n" },
      { id: "second", name: "Boundary", input: "1000000\n" },
    ];
    expect(decodeSelfTestCases(encodeSelfTestCases(cases), "unused")).toEqual(cases);
  });

  it("rejects malformed, duplicate, and oversized workspaces", () => {
    expect(() => decodeSelfTestCases("{}", "")).toThrow("invalid schema");
    expect(() => encodeSelfTestCases([
      { id: "same", name: "One", input: "" },
      { id: "same", name: "Two", input: "" },
    ])).toThrow("invalid case");
    expect(() => encodeSelfTestCases(Array.from({ length: MAX_SELF_TEST_CASES + 1 }, (_, index) => ({
      id: `case-${index}`,
      name: `Case ${index}`,
      input: "",
    })))).toThrow(`between 1 and ${MAX_SELF_TEST_CASES}`);
  });

  it("names storage by collection and immutable problem identity", () => {
    expect(selfTestStorageKey("github:owner/repo@main", "sum@abc123")).toContain(
      "github%3Aowner%2Frepo%40main:sum@abc123",
    );
  });
});
