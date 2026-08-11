import { describe, expect, it } from "vitest";
import { PROBLEMS } from "../judge/problems";
import { parseManagedPublicProblemProjection } from "./public-projection";

const DIGEST = "a".repeat(64);
const problem = PROBLEMS[0]!;

describe("managed public problem projection", () => {
  it("accepts and sanitizes the exact practice role", () => {
    expect(parseManagedPublicProblemProjection({
      schema: "forge-practice-problem-projection-v1",
      problem,
      digest: DIGEST,
    }, "official-practice", DIGEST)).toEqual({
      schema: "forge-practice-problem-projection-v1",
      problem,
      digest: DIGEST,
    });
  });

  it("accepts only samples and an empty editorial in the contest-public role", () => {
    const publicProblem = {
      ...problem,
      editorial: { "zh-TW": "", en: "" },
      judgeCases: problem.judgeCases.filter((testCase) => testCase.kind === "sample"),
    };
    expect(parseManagedPublicProblemProjection({
      schema: "forge-contest-public-problem-projection-v1",
      problem: publicProblem,
      digest: DIGEST,
    }, "contest", DIGEST).problem).toEqual(publicProblem);

    expect(() => parseManagedPublicProblemProjection({
      schema: "forge-contest-public-problem-projection-v1",
      problem: { ...publicProblem, judgeCases: problem.judgeCases },
      digest: DIGEST,
    }, "contest", DIGEST)).toThrow("non-public");
  });

  it("rejects a hidden judge role even when its content address is valid", () => {
    expect(() => parseManagedPublicProblemProjection({
      schema: "forge-server-judge-projection-v1",
      forgeReleaseId: crypto.randomUUID(),
      allowedProfiles: {},
      judge: { kind: "text" },
      problem,
      digest: DIGEST,
    }, "official-practice", DIGEST)).toThrow("problem bundle");
  });
});
