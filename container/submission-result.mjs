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

const RELEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * A published judge projection remains executable after the active runtime
 * release changes. Its release ID records validation provenance; the immutable
 * bundle digest is the admission boundary for the problem being judged.
 */
export function isSubmissionProjectionAdmitted(projection, expectedProblemBundleDigest) {
  return Boolean(
    projection
    && typeof projection === "object"
    && RELEASE_ID.test(projection.forgeReleaseId ?? "")
    && SHA256.test(expectedProblemBundleDigest ?? "")
    && projection.digest === expectedProblemBundleDigest
  );
}

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
