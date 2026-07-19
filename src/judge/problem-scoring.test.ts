import { describe, expect, it } from "vitest";
import type { BuiltinLanguage, RunResult } from "../core/types";
import type { JudgeCaseResult } from "./engine";
import { assertProblemCostProfile, scoreProblemResults } from "./problem-scoring";
import type { JudgeProblem } from "./problems";

const language: BuiltinLanguage = "c";
const profile = "calibrated-c-profile";
const problem: JudgeProblem = {
  id: "test-problem",
  number: 1,
  title: { "zh-TW": "測試", en: "Test" },
  difficulty: "medium",
  tags: ["test"],
  statement: { "zh-TW": "statement", en: "statement" },
  editorial: { "zh-TW": "editorial", en: "editorial" },
  judgeCases: [
    { id: "sample-01", kind: "sample", input: "", output: "" },
    { id: "adversarial-01", kind: "adversarial", input: "", output: "" },
  ],
  scoring: {
    maximumPoints: 100,
    calibration: {
      method: "forge-v1-reference-order-statistics-rounded-v1",
      profiles: { c: profile },
    },
    policies: [
      {
        id: "baseline",
        title: { "zh-TW": "寬鬆資源", en: "Baseline Resources" },
        points: 20,
        limits: { instructionBudget: 1_000, memoryLimitBytes: 2_000 },
      },
      {
        id: "efficient",
        title: { "zh-TW": "進階效率", en: "Efficient Solution" },
        points: 30,
        limits: { instructionBudget: 500, memoryLimitBytes: 1_500 },
      },
      {
        id: "optimal",
        title: { "zh-TW": "最佳解", en: "Optimal Solution" },
        points: 50,
        limits: { instructionBudget: 200, memoryLimitBytes: 1_000 },
      },
    ],
    safetyLimits: { wallTimeLimitMs: 60_000 },
  },
  complexities: [
    { name: { "zh-TW": "暴力", en: "Brute force" }, time: "O(N²)", space: "O(1)", accepted: false },
    { name: { "zh-TW": "最佳", en: "Optimal" }, time: "O(N)", space: "O(1)", accepted: true },
  ],
};

function accepted(id: string, cost: number, memoryBytes = 900): JudgeCaseResult {
  return {
    id,
    verdict: "accepted",
    run: {
      code: 0,
      stdout: "",
      stderr: "",
      files: {},
      durationMs: 1,
      determinism: {
        randomSeed: 0,
        realtimeEpochMs: 0,
        clockStepNs: 1,
      },
      resources: {
        instructionBudget: 1_000,
        logicalTimeLimitMs: 60_000,
        memoryLimitBytes: 2_000,
        outputLimitBytes: 65_536,
        filesystemWriteLimitBytes: 65_536,
        filesystemEntryLimit: 1,
        wallTimeLimitMs: 60_000,
      },
      termination: "exited",
      metrics: {
        cost,
        rawCost: cost + 10,
        baselineCost: 10,
        costProfile: profile,
        costModel: "weighted",
        operations: {},
        memoryBytes,
        logicalTimeNs: 0,
        filesystemBytes: 0,
        filesystemEntries: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
      },
    } satisfies RunResult,
  };
}

describe("problem policy scoring", () => {
  it("averages cumulative policy points over the complete case set", () => {
    const score = scoreProblemResults(problem, language, [
      accepted("sample-01", 200),
      accepted("adversarial-01", 800),
    ]);
    expect(score.points).toBe(60);
    expect(score.numerator).toBe(120);
    expect(score.denominator).toBe(2);
    expect(score.passedByPolicy).toEqual({ baseline: 2, efficient: 1, optimal: 1 });
  });

  it("fails closed on profile and execution-inventory mismatches", () => {
    expect(() => assertProblemCostProfile(problem, language, "wrong")).toThrow("different");
    expect(() => scoreProblemResults(problem, language, [accepted("sample-01", 0)])).toThrow("inventory");
    const wrongProfile = accepted("sample-01", 0);
    wrongProfile.run!.metrics.costProfile = "wrong";
    expect(() => scoreProblemResults(problem, language, [
      wrongProfile,
      accepted("adversarial-01", 0),
    ])).toThrow("different");
  });
});
