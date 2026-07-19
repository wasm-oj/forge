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
    expect(score.cases[0].metrics).toMatchObject({
      cost: 200,
      rawCost: 210,
      baselineCost: 10,
      memoryBytes: 900,
    });
    expect(score.cases[0].policyEvaluations.map((policy) => policy.earned)).toEqual([
      true,
      true,
      true,
    ]);
    expect(score.cases[1].policyEvaluations.map((policy) => policy.earned)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("explains a cumulative partial score and the resource that blocks the next policy", () => {
    const score = scoreProblemResults(problem, language, [
      accepted("sample-01", 200, 1_200),
      accepted("adversarial-01", 200, 1_200),
    ]);
    expect(score.points).toBe(50);
    expect(score.cases[0].passedPolicyIds).toEqual(["baseline", "efficient"]);
    expect(score.cases[0].policyEvaluations).toEqual([
      expect.objectContaining({ id: "baseline", resourcePassed: true, earned: true }),
      expect.objectContaining({ id: "efficient", resourcePassed: true, earned: true }),
      expect.objectContaining({
        id: "optimal",
        costPassed: true,
        memoryPassed: false,
        resourcePassed: false,
        earned: false,
      }),
    ]);
  });

  it("reports resource status without awarding points when output is wrong", () => {
    const wrongAnswer = accepted("sample-01", 100);
    wrongAnswer.verdict = "wrong-answer";
    const score = scoreProblemResults(problem, language, [
      wrongAnswer,
      accepted("adversarial-01", 100),
    ]);
    expect(score.cases[0].outputAccepted).toBe(false);
    expect(score.cases[0].points).toBe(0);
    expect(score.cases[0].policyEvaluations.every((policy) => policy.resourcePassed)).toBe(true);
    expect(score.cases[0].policyEvaluations.every((policy) => !policy.earned)).toBe(true);
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

    const missingMetrics = accepted("sample-01", 0);
    missingMetrics.run!.metrics.memoryBytes = null;
    expect(() => scoreProblemResults(problem, language, [
      missingMetrics,
      accepted("adversarial-01", 0),
    ])).toThrow("complete scoring metrics");

    const asymmetricCost = accepted("sample-01", 0);
    asymmetricCost.run!.metrics.cost = null;
    expect(() => scoreProblemResults(problem, language, [
      asymmetricCost,
      accepted("adversarial-01", 0),
    ])).toThrow("incomplete normalized cost metrics");

    const reverseAsymmetricCost = accepted("sample-01", 0);
    reverseAsymmetricCost.run!.metrics.rawCost = null;
    expect(() => scoreProblemResults(problem, language, [
      reverseAsymmetricCost,
      accepted("adversarial-01", 0),
    ])).toThrow("incomplete normalized cost metrics");

    expect(() => scoreProblemResults(problem, language, [
      { id: "sample-01", verdict: "accepted" },
      accepted("adversarial-01", 0),
    ])).toThrow("successful execution");
  });
});
