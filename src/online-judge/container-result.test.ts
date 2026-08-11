import { describe, expect, it } from "vitest";
import { parseContainerSubmissionResult, readContainerSubmissionResult } from "../../worker/container-result";

const digest = "a".repeat(64);
const identity = "b".repeat(64);
const expected = {
  submissionId: "submission-1",
  attempt: 1,
  expectedReleaseId: "12345678-1234-4123-8123-123456789abc",
  expectedManifestSha256: digest,
  expectedContainerIdentitySha256: identity,
  expectedJudgeProjectionSha256: "c".repeat(64),
  expectedProblemBundleDigest: "d".repeat(64),
} as const;

const result = {
  state: "completed",
  verdict: "accepted",
  score: 100,
  fullyPassedCases: 1,
  deterministicCost: 10,
  peakMemoryBytes: 65_536,
  audit: {
    schema: "forge-submission-audit-v1",
    submissionId: expected.submissionId,
    attempt: expected.attempt,
    sourceDigest: "e".repeat(64),
    forgeReleaseId: expected.expectedReleaseId,
    expectedManifestSha256: expected.expectedManifestSha256,
    expectedContainerIdentitySha256: expected.expectedContainerIdentitySha256,
    actualContainerIdentitySha256: expected.expectedContainerIdentitySha256,
    judgeProjectionSha256: expected.expectedJudgeProjectionSha256,
    problemBundleDigest: expected.expectedProblemBundleDigest,
    cases: [{ verdict: "accepted", termination: "exited", cost: 10, memoryBytes: 65_536 }],
  },
} as const;

describe("container result boundary", () => {
  it("accepts only the exact hidden-safe result and immutable identities", () => {
    expect(parseContainerSubmissionResult(result, expected)).toEqual(result);
    expect(() => parseContainerSubmissionResult({ ...result, stdout: "hidden" }, expected)).toThrow("shape");
    expect(() => parseContainerSubmissionResult({
      ...result,
      audit: { ...result.audit, actualContainerIdentitySha256: digest },
    }, expected)).toThrow("actual identity");
    expect(() => parseContainerSubmissionResult({ ...result, score: 101 }, expected)).toThrow("scoring contract");
    expect(() => parseContainerSubmissionResult({ ...result, fullyPassedCases: 2 }, expected)).toThrow("audit inventory");
  });

  it("keeps judge errors out of a completed result", () => {
    expect(() => parseContainerSubmissionResult({ ...result, verdict: "judge-error" }, expected)).toThrow("Completed state");
    expect(parseContainerSubmissionResult({
      ...result,
      state: "judge-error",
      verdict: "judge-error",
      score: 0,
      fullyPassedCases: 0,
      audit: { ...result.audit, cases: [{ ...result.audit.cases[0], verdict: "judge-error" }] },
    }, expected).state).toBe("judge-error");
  });

  it("bounds and parses the response before Workflow persistence", async () => {
    const response = new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    await expect(readContainerSubmissionResult(response, expected)).resolves.toEqual(result);
    const oversized = new Response("x", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } });
    await expect(readContainerSubmissionResult(oversized, expected)).rejects.toThrow("bounded response");
  });
});
