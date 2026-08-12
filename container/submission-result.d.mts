export interface FormalSubmissionOutcome {
  readonly state: "completed" | "judge-error";
  readonly score: number;
  readonly fullyPassedCases: number;
}
export function formalSubmissionOutcome(
  verdict: "accepted" | "wrong-answer" | "runtime-error" | "instruction-limit" | "memory-limit" | "output-limit" | "filesystem-limit" | "logical-time-limit" | "wall-time-limit" | "judge-error",
  scoring: { readonly points: number; readonly cases: readonly { readonly outputAccepted: boolean }[] },
): FormalSubmissionOutcome;
