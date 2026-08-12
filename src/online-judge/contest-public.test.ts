import { describe, expect, it } from "vitest";
import { PROBLEMS } from "../judge/problems";
import { deriveContestPublic, derivePracticePublic } from "./contest-public";

describe("contest-public derivation", () => {
  it("separates author-only cases before applying contest editorial redaction", () => {
    const authored = structuredClone(PROBLEMS[0]!);
    const practice = derivePracticePublic(authored);
    const projection = deriveContestPublic(practice);
    expect(practice.judgeCases.every((testCase) => testCase.kind === "sample")).toBe(true);
    expect(projection.editorial).toEqual({ "zh-TW": "", en: "" });
    expect(projection.judgeCases.every((testCase) => testCase.kind === "sample")).toBe(true);
    expect(authored).toEqual(PROBLEMS[0]);
    expect(projection).not.toBe(practice);
  });

  it("fails closed when a caller tries to publish authored hidden data as practice", () => {
    expect(() => deriveContestPublic(PROBLEMS[0]!)).toThrow("non-sample judge data");
  });
});
