import type { BuiltinLanguage } from "../core/types";
import type { JudgeCaseResult } from "./engine";
import type { JudgeProblem, ProblemScoringPolicy } from "./problem-model";
import type { JudgeData } from "../online-judge/judge-data";

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

export const PERFORMANCE_POLICY_IDS = ["baseline", "efficient", "optimal"] as const;

export type PerformancePolicyId = (typeof PERFORMANCE_POLICY_IDS)[number];

export interface PolicyPerformanceAggregate {
  readonly id: PerformancePolicyId;
  readonly earnedCases: number;
  readonly costExceededCases: number;
  readonly memoryExceededCases: number;
  readonly logicalTimeExceededCases: number;
}

export interface SubmissionPolicySummary {
  readonly totalCases: number;
  readonly outputAcceptedCases: number;
  readonly policies: readonly PolicyPerformanceAggregate[];
}

/**
 * Collapse case-level judge details into the only policy data allowed to cross
 * the container boundary. Resource failures are counted only after output
 * acceptance, so an output error is never mislabeled as an efficiency error.
 */
export function summarizeProblemPolicies(score: ProblemScore): SubmissionPolicySummary {
  const totals = PERFORMANCE_POLICY_IDS.map((id) => ({
    id,
    earnedCases: 0,
    costExceededCases: 0,
    memoryExceededCases: 0,
    logicalTimeExceededCases: 0,
  }));
  let outputAcceptedCases = 0;
  for (const testCase of score.cases) {
    if (testCase.policyEvaluations.length !== PERFORMANCE_POLICY_IDS.length) {
      throw new Error("Policy summary requires exactly three scoring policies.");
    }
    if (testCase.outputAccepted) outputAcceptedCases += 1;
    for (let index = 0; index < PERFORMANCE_POLICY_IDS.length; index += 1) {
      const evaluation = testCase.policyEvaluations[index];
      const total = totals[index];
      if (evaluation?.id !== total?.id) {
        throw new Error("Policy summary requires baseline, efficient, and optimal order.");
      }
      if (evaluation.earned) total.earnedCases += 1;
      if (!testCase.outputAccepted) continue;
      if (!evaluation.costPassed) total.costExceededCases += 1;
      if (!evaluation.memoryPassed) total.memoryExceededCases += 1;
      if (evaluation.logicalTimePassed === false) total.logicalTimeExceededCases += 1;
    }
  }
  return {
    totalCases: score.cases.length,
    outputAcceptedCases,
    policies: totals,
  };
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

export function assertJudgeDataCostProfile(
  data: JudgeData,
  language: BuiltinLanguage,
  costProfile: string,
): void {
  const expected = data.scoring.calibration.profiles[language];
  if (!expected || costProfile !== expected) {
    throw new Error(`Judge data was calibrated for a different '${language}' cost profile.`);
  }
}

function observedMetrics(
  problem: JudgeProblem,
  language: BuiltinLanguage,
  result: JudgeCaseResult,
): ObservedCaseMetrics | null {
  const metrics = result.run?.metrics ?? result.interaction?.contestant.metrics;
  if (!metrics) return null;
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
  policy: Pick<ProblemScoringPolicy, "id" | "points" | "limits">,
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
  return scoreResults(
    problem.id,
    problem.judgeCases.map((testCase) => testCase.id),
    problem.scoring,
    (result) => observedMetrics(problem, language, result),
    results,
  );
}

function scoreResults(
  label: string,
  expectedIds: readonly string[],
  scoring: {
    readonly maximumPoints: number;
    readonly policies: readonly Pick<ProblemScoringPolicy, "id" | "points" | "limits">[];
  },
  metricsFor: (result: JudgeCaseResult) => ObservedCaseMetrics | null,
  results: readonly JudgeCaseResult[],
): ProblemScore {
  if (
    results.length !== expectedIds.length
    || results.some((result, index) => result.id !== expectedIds[index])
  ) {
    throw new Error(`${label} execution inventory is incomplete or reordered.`);
  }

  const passedByPolicy = Object.fromEntries(
    scoring.policies.map((policy) => [policy.id, 0]),
  );
  const cases = results.map((result): ScoredProblemCase => {
    const contestantTermination = result.run?.termination ?? result.interaction?.contestant.termination;
    if (result.verdict === "accepted" && contestantTermination !== "exited") {
      throw new Error(`${label} accepted a case without a successful execution.`);
    }
    const metrics = metricsFor(result);
    const outputAccepted = result.verdict === "accepted" && contestantTermination === "exited";
    if (
      outputAccepted
      && (
        metrics === null
        || metrics.cost === null
        || metrics.rawCost === null
        || metrics.memoryBytes === null
      )
    ) {
      throw new Error(`${label} accepted a case without complete scoring metrics.`);
    }
    const policyEvaluations = scoring.policies.map((policy) => (
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
  const denominator = expectedIds.length;
  return {
    numerator,
    denominator,
    points: numerator / denominator,
    maximumPoints: scoring.maximumPoints,
    cases,
    passedByPolicy,
  };
}

/** Score immutable execution-only judge data without reconstructing a public problem bundle. */
export function scoreJudgeDataResults(
  data: JudgeData,
  language: BuiltinLanguage,
  results: readonly JudgeCaseResult[],
): ProblemScore {
  return scoreResults(
    "Immutable judge data",
    data.cases.map((testCase) => testCase.id),
    data.scoring,
    (result) => observedJudgeDataMetrics(data, language, result),
    results,
  );
}

function observedJudgeDataMetrics(
  data: JudgeData,
  language: BuiltinLanguage,
  result: JudgeCaseResult,
): ObservedCaseMetrics | null {
  const metrics = result.run?.metrics ?? result.interaction?.contestant.metrics;
  if (!metrics) return null;
  assertJudgeDataCostProfile(data, language, metrics.costProfile);
  if (metrics.costModel !== "weighted") throw new Error("Immutable judge data received an unsupported cost model.");
  const observed: ObservedCaseMetrics = {
    cost: optionalMetric(metrics.cost, "cost"),
    rawCost: optionalMetric(metrics.rawCost, "rawCost"),
    baselineCost: requireMetric(metrics.baselineCost, "baselineCost"),
    memoryBytes: optionalMetric(metrics.memoryBytes, "memoryBytes"),
    logicalTimeNs: optionalMetric(metrics.logicalTimeNs, "logicalTimeNs"),
  };
  if ((observed.cost === null) !== (observed.rawCost === null)) throw new Error("Immutable judge data received incomplete normalized cost metrics.");
  if (
    observed.cost !== null
    && observed.rawCost !== null
    && observed.cost !== Math.max(0, observed.rawCost - observed.baselineCost)
  ) throw new Error("Immutable judge data received inconsistent normalized cost metrics.");
  return observed;
}
