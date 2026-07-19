import { GENERATED_PROBLEMS } from "./problems.generated";

export const PROBLEM_LOCALES = ["zh-TW", "en"] as const;
export type ProblemLocale = typeof PROBLEM_LOCALES[number];
export const DEFAULT_PROBLEM_LOCALE: ProblemLocale = "zh-TW";

export type ProblemDifficulty = "easy" | "medium" | "hard";
export type ProblemCaseKind = "sample" | "adversarial" | "regression";

export type LocalizedText = Readonly<Record<ProblemLocale, string>>;

export interface JudgeCase {
  readonly id: string;
  readonly kind: ProblemCaseKind;
  readonly input: string;
  readonly output: string;
}

export interface ProblemPolicyLimits {
  readonly instructionBudget: number;
  readonly memoryLimitBytes: number;
  readonly logicalTimeLimitMs?: number;
}

export interface ProblemScoringPolicy {
  readonly id: string;
  readonly title: LocalizedText;
  readonly points: number;
  readonly limits: ProblemPolicyLimits;
}

export interface ProblemScoring {
  readonly maximumPoints: 100;
  readonly calibration: {
    readonly method: "forge-v1-compiled-average-optimal-rounded-v1";
    readonly profiles: Readonly<Record<string, string>>;
  };
  readonly policies: readonly ProblemScoringPolicy[];
  readonly safetyLimits: { readonly wallTimeLimitMs: number };
}

export interface ProblemComplexity {
  readonly name: LocalizedText;
  readonly time: string;
  readonly space: string;
  readonly accepted: boolean;
}

export interface JudgeProblem {
  readonly id: string;
  readonly number: number;
  readonly title: LocalizedText;
  readonly difficulty: ProblemDifficulty;
  readonly tags: readonly string[];
  readonly statement: LocalizedText;
  readonly editorial: LocalizedText;
  readonly judgeCases: readonly JudgeCase[];
  readonly scoring: ProblemScoring;
  readonly complexities: readonly ProblemComplexity[];
}

export const PROBLEMS: readonly JudgeProblem[] = GENERATED_PROBLEMS;

export function problemById(id: string): JudgeProblem | undefined {
  return PROBLEMS.find((problem) => problem.id === id);
}

export function problemText(problem: JudgeProblem, locale: ProblemLocale) {
  return {
    title: problem.title[locale],
    statement: problem.statement[locale],
    editorial: problem.editorial[locale],
  };
}

export function sampleCases(problem: JudgeProblem): readonly JudgeCase[] {
  return problem.judgeCases.filter((testCase) => testCase.kind === "sample");
}

export function broadestPolicy(problem: JudgeProblem): ProblemScoringPolicy {
  const policy = problem.scoring.policies[0];
  if (!policy) throw new Error(`Problem '${problem.id}' has no scoring policy.`);
  return policy;
}
