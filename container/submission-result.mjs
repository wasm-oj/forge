const VERDICTS = new Set([
  "accepted",
  "wrong-answer",
  "runtime-error",
  "instruction-limit",
  "memory-limit",
  "output-limit",
  "filesystem-limit",
  "logical-time-limit",
  "wall-time-limit",
  "judge-error",
]);

/** Keep judge infrastructure failures out of every success projection. */
export function formalSubmissionOutcome(verdict, scoring) {
  if (!VERDICTS.has(verdict) || !scoring || !Number.isFinite(scoring.points) || !Array.isArray(scoring.cases)) {
    throw new TypeError("Formal judge outcome is invalid.");
  }
  const judgeFailed = verdict === "judge-error";
  return Object.freeze({
    state: judgeFailed ? "judge-error" : "completed",
    score: judgeFailed ? 0 : scoring.points,
    fullyPassedCases: judgeFailed ? 0 : scoring.cases.filter((item) => item?.outputAccepted === true).length,
  });
}
