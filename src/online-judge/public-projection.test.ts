import { describe, expect, it } from "vitest";
import { PROBLEMS } from "../judge/problems";
import { parseContestPublicProblemProjection } from "./public-projection";

const problem = PROBLEMS[0]!;

describe("contest public problem projection", () => {
  it("accepts only samples and an empty editorial", () => {
    const publicProblem = {
      ...problem,
      editorial: { "zh-TW": "", en: "" },
      judgeCases: problem.judgeCases.filter((testCase) => testCase.kind === "sample"),
    };
    expect(parseContestPublicProblemProjection({
      schema: "wasm-oj-platform/contest-public-problem-projection/v1",
      problem: publicProblem,
    }).problem).toEqual(publicProblem);

    expect(() => parseContestPublicProblemProjection({
      schema: "wasm-oj-platform/contest-public-problem-projection/v1",
      problem: { ...publicProblem, judgeCases: problem.judgeCases },
    })).toThrow("non-public");
  });

  it("rejects extra component identity and an incorrect role", () => {
    const publicProblem = { ...problem, editorial: { "zh-TW": "", en: "" }, judgeCases: [] };
    expect(() => parseContestPublicProblemProjection({
      schema: "wasm-oj-platform/contest-public-problem-projection/v1",
      problem: publicProblem,
      digest: "a".repeat(64),
    })).toThrow("invalid shape");
    expect(() => parseContestPublicProblemProjection({
      schema: "wasm-oj-platform/practice-problem-projection/v1",
      problem: publicProblem,
    })).toThrow("schema");
  });
});
