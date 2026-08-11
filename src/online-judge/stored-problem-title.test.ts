import { describe, expect, it } from "vitest";
import { parseStoredProblemTitle } from "./stored-problem-title";

describe("stored problem title projection", () => {
  it("returns only the exact bilingual public title", () => {
    expect(parseStoredProblemTitle(JSON.stringify({ "zh-TW": "題目", en: "Problem" }))).toEqual({ "zh-TW": "題目", en: "Problem" });
  });

  it("rejects malformed, extended, empty, or untrimmed stored data", () => {
    for (const value of [
      "not-json",
      JSON.stringify({ en: "Problem" }),
      JSON.stringify({ "zh-TW": "題目", en: "Problem", hidden: "data" }),
      JSON.stringify({ "zh-TW": "", en: "Problem" }),
      JSON.stringify({ "zh-TW": "題目", en: " Problem" }),
    ]) expect(() => parseStoredProblemTitle(value)).toThrow("invalid");
  });
});
