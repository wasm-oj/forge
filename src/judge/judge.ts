import type { RunResult } from "@/src/core/types";

export type CaseVerdict = "accepted" | "wrong-answer" | "runtime-error" | "time-limit";
export type SubmissionVerdict = "running" | "accepted" | "wrong-answer" | "runtime-error" | "time-limit" | "compile-error" | "cancelled";

export interface JudgeCaseResult {
  number: number;
  verdict: CaseVerdict;
  expected: string;
  actual: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export interface JudgeSession {
  problemId: string;
  verdict: SubmissionVerdict;
  completed: number;
  total: number;
  cases: JudgeCaseResult[];
  durationMs: number;
}

export const JUDGE_PROGRESS_KEY = "localwasi-judge-progress";

export class JudgeTimeoutError extends Error {
  constructor() {
    super("The local time limit was exceeded.");
    this.name = "JudgeTimeoutError";
  }
}

export function normalizeJudgeOutput(value: string): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

export function evaluateRun(number: number, expected: string, result: RunResult): JudgeCaseResult {
  const verdict: CaseVerdict = result.code !== 0
    ? "runtime-error"
    : normalizeJudgeOutput(result.stdout) === normalizeJudgeOutput(expected)
      ? "accepted"
      : "wrong-answer";
  return {
    number,
    verdict,
    expected: normalizeJudgeOutput(expected),
    actual: normalizeJudgeOutput(result.stdout),
    stderr: result.stderr,
    exitCode: result.code,
    durationMs: result.durationMs,
  };
}

export function submissionVerdict(cases: JudgeCaseResult[]): SubmissionVerdict {
  return cases.find((test) => test.verdict !== "accepted")?.verdict ?? "accepted";
}

export function decodeSolvedProgress(raw: string | null, validIds: ReadonlySet<string>): Set<string> {
  if (!raw) return new Set();
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("Stored judge progress is invalid.");
  }
  return new Set(parsed.filter((id) => validIds.has(id)));
}
