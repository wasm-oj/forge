import type { BuiltinLanguage } from "../core/types";
import type { JudgeCaseResult } from "./engine";
import type { JudgeProblem, ProblemScoringPolicy } from "./problems";

export interface ScoredProblemCase {
  id: string;
  outputAccepted: boolean;
  metrics: ObservedCaseMetrics | null;
  policyEvaluations: readonly PolicyEvaluation[];
  passedPolicyIds: readonly string[];
  points: number;
}

export interface ObservedCaseMetrics {
  cost: number | null;
  rawCost: number | null;
  baselineCost: number;
  memoryBytes: number | null;
  logicalTimeNs: number | null;
}

export interface PolicyEvaluation {
  id: string;
  points: number;
  costPassed: boolean;
  memoryPassed: boolean;
  logicalTimePassed: boolean | null;
  resourcePassed: boolean;
  earned: boolean;
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
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function optionalMetric(value: number | null, label: string): number | null {
  return value === null ? null : requireMetric(value, label);
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

function observedMetrics(
  problem: JudgeProblem,
  language: BuiltinLanguage,
  result: JudgeCaseResult,
): ObservedCaseMetrics | null {
  if (!result.run) return null;
  const metrics = result.run.metrics;
  assertProblemCostProfile(problem, language, metrics.costProfile);
  if (metrics.costModel !== "weighted") {
    throw new Error(`Problem '${problem.id}' received an unsupported cost model.`);
  }
  const observed: ObservedCaseMetrics = {
    cost: optionalMetric(metrics.cost, "cost"),
    rawCost: optionalMetric(metrics.rawCost, "rawCost"),
    baselineCost: requireMetric(metrics.baselineCost, "baselineCost"),
    memoryBytes: optionalMetric(metrics.memoryBytes, "memoryBytes"),
    logicalTimeNs: optionalMetric(metrics.logicalTimeNs, "logicalTimeNs"),
  };
  if ((observed.cost === null) !== (observed.rawCost === null)) {
    throw new Error(`Problem '${problem.id}' received incomplete normalized cost metrics.`);
  }
  if (
    observed.cost !== null
    && observed.rawCost !== null
    && observed.cost !== Math.max(0, observed.rawCost - observed.baselineCost)
  ) {
    throw new Error(`Problem '${problem.id}' received inconsistent normalized cost metrics.`);
  }
  return observed;
}

function evaluatePolicy(
  policy: ProblemScoringPolicy,
  metrics: ObservedCaseMetrics | null,
  outputAccepted: boolean,
): PolicyEvaluation {
  const costPassed = metrics !== null
    && metrics.cost !== null
    && metrics.cost <= policy.limits.instructionBudget;
  const memoryPassed = metrics !== null
    && metrics.memoryBytes !== null
    && metrics.memoryBytes <= policy.limits.memoryLimitBytes;
  const logicalTimePassed = policy.limits.logicalTimeLimitMs === undefined
    ? null
    : metrics !== null
      && metrics.logicalTimeNs !== null
      && metrics.logicalTimeNs <= policy.limits.logicalTimeLimitMs * 1_000_000;
  const resourcePassed = costPassed && memoryPassed && logicalTimePassed !== false;
  return {
    id: policy.id,
    points: policy.points,
    costPassed,
    memoryPassed,
    logicalTimePassed,
    resourcePassed,
    earned: outputAccepted && resourcePassed,
  };
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
    if (result.verdict === "accepted" && result.run?.termination !== "exited") {
      throw new Error(`Problem '${problem.id}' accepted a case without a successful execution.`);
    }
    const metrics = observedMetrics(problem, language, result);
    const outputAccepted = result.verdict === "accepted" && result.run?.termination === "exited";
    if (
      outputAccepted
      && (
        metrics === null
        || metrics.cost === null
        || metrics.rawCost === null
        || metrics.memoryBytes === null
      )
    ) {
      throw new Error(`Problem '${problem.id}' accepted a case without complete scoring metrics.`);
    }
    const policyEvaluations = problem.scoring.policies.map((policy) => (
      evaluatePolicy(policy, metrics, outputAccepted)
    ));
    const passedPolicyIds: string[] = [];
    let points = 0;
    for (const evaluation of policyEvaluations) {
      if (!evaluation.earned) continue;
      passedPolicyIds.push(evaluation.id);
      passedByPolicy[evaluation.id] += 1;
      points += evaluation.points;
    }
    return {
      id: result.id,
      outputAccepted,
      metrics,
      policyEvaluations,
      passedPolicyIds,
      points,
    };
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
