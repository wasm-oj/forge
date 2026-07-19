import type { BuiltinLanguage } from "../core/types";
import type { JudgeCaseResult } from "./engine";
import type { JudgeProblem, ProblemScoringPolicy } from "./problems";

export interface ScoredProblemCase {
  id: string;
  passedPolicyIds: readonly string[];
  points: number;
}

export interface ProblemScore {
  numerator: number;
  denominator: number;
  points: number;
  maximumPoints: number;
  cases: readonly ScoredProblemCase[];
  passedByPolicy: Readonly<Record<string, number>>;
}

function requireMetric(value: number | null, label: string): number {
  if (!Number.isSafeInteger(value) || value === null || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

export function assertProblemCostProfile(
  problem: JudgeProblem,
  language: BuiltinLanguage,
  costProfile: string,
): void {
  const expected = problem.scoring.calibration.profiles[language];
  if (!expected) {
    throw new Error(`Problem '${problem.id}' has no calibrated profile for '${language}'.`);
  }
  if (costProfile !== expected) {
    throw new Error(
      `Problem '${problem.id}' was calibrated for a different '${language}' cost profile.`,
    );
  }
}

function policyPasses(
  policy: ProblemScoringPolicy,
  cost: number,
  memoryBytes: number,
  logicalTimeNs: number | null,
): boolean {
  if (
    cost > policy.limits.instructionBudget
    || memoryBytes > policy.limits.memoryLimitBytes
  ) {
    return false;
  }
  if (policy.limits.logicalTimeLimitMs === undefined) return true;
  const logicalTime = requireMetric(logicalTimeNs, "logicalTimeNs");
  return logicalTime <= policy.limits.logicalTimeLimitMs * 1_000_000;
}

export function scoreProblemResults(
  problem: JudgeProblem,
  language: BuiltinLanguage,
  results: readonly JudgeCaseResult[],
): ProblemScore {
  const expectedIds = problem.judgeCases.map((testCase) => testCase.id);
  if (
    results.length !== expectedIds.length
    || results.some((result, index) => result.id !== expectedIds[index])
  ) {
    throw new Error(`Problem '${problem.id}' execution inventory is incomplete or reordered.`);
  }

  const passedByPolicy = Object.fromEntries(
    problem.scoring.policies.map((policy) => [policy.id, 0]),
  );
  const cases = results.map((result): ScoredProblemCase => {
    if (!result.run || result.verdict !== "accepted" || result.run.termination !== "exited") {
      return { id: result.id, passedPolicyIds: [], points: 0 };
    }
    const metrics = result.run.metrics;
    assertProblemCostProfile(problem, language, metrics.costProfile);
    if (metrics.costModel !== "weighted") {
      throw new Error(`Problem '${problem.id}' received an unsupported cost model.`);
    }
    const cost = requireMetric(metrics.cost, "cost");
    const rawCost = requireMetric(metrics.rawCost, "rawCost");
    const baselineCost = requireMetric(metrics.baselineCost, "baselineCost");
    const memoryBytes = requireMetric(metrics.memoryBytes, "memoryBytes");
    if (cost !== Math.max(0, rawCost - baselineCost)) {
      throw new Error(`Problem '${problem.id}' received inconsistent normalized cost metrics.`);
    }
    const passedPolicyIds: string[] = [];
    let points = 0;
    for (const policy of problem.scoring.policies) {
      if (!policyPasses(policy, cost, memoryBytes, metrics.logicalTimeNs)) continue;
      passedPolicyIds.push(policy.id);
      passedByPolicy[policy.id] += 1;
      points += policy.points;
    }
    return { id: result.id, passedPolicyIds, points };
  });
  const numerator = cases.reduce((total, testCase) => total + testCase.points, 0);
  const denominator = problem.judgeCases.length;
  return {
    numerator,
    denominator,
    points: numerator / denominator,
    maximumPoints: problem.scoring.maximumPoints,
    cases,
    passedByPolicy,
  };
}
