import { FORGE_CONTRACT_ID } from "../core/contract";
import type { ObservedCaseMetrics, PolicyEvaluation } from "./problem-scoring";

export type CaseVerdict = "accepted" | "wrong-answer" | "runtime-error" | "time-limit" | "judge-error";
export type SubmissionVerdict = "running" | "accepted" | "wrong-answer" | "runtime-error" | "time-limit" | "judge-error" | "compile-error" | "cancelled";

export interface JudgeUiCaseResult {
  number: number;
  verdict: CaseVerdict;
  expected: string;
  actual: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  points?: number;
  outputAccepted?: boolean;
  passedPolicyIds?: readonly string[];
  metrics?: ObservedCaseMetrics;
  policyEvaluations?: readonly PolicyEvaluation[];
}

export interface JudgeUiSession {
  problemId: string;
  verdict: SubmissionVerdict;
  completed: number;
  total: number;
  cases: JudgeUiCaseResult[];
  durationMs: number;
  message?: string;
  score?: {
    numerator: number;
    denominator: number;
    points: number;
    maximumPoints: number;
  };
}

export const JUDGE_PROGRESS_KEY = `${FORGE_CONTRACT_ID}:judge-progress`;

export function decodeSolvedProgress(raw: string | null, validIds: ReadonlySet<string>): Set<string> {
  if (!raw) return new Set();
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("Stored judge progress is invalid.");
  }
  return new Set(parsed.filter((id) => validIds.has(id)));
}
