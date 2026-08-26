import { describe, expect, it } from "vitest";
import {
  deriveSubmissionAttemptToken,
  parseSubmissionWorkflowParameters,
  type SubmissionWorkflowParameters,
} from "./submission-workflow-identity";

const SUBMISSION_ID = "0198dbd3-5c00-7000-8000-000000000301";
const SECRET = "submission-workflow-test-secret-32-bytes-minimum";

function parameters(): SubmissionWorkflowParameters {
  return { submissionId: SUBMISSION_ID, attempt: 1 };
}

describe("opaque submission Workflow identity", () => {
  it("derives a stable domain-separated capability and rejects persisted sensitive fields", async () => {
    const token = await deriveSubmissionAttemptToken(SECRET, SUBMISSION_ID, 1);
    expect(token).toHaveLength(43);
    expect(await deriveSubmissionAttemptToken(SECRET, SUBMISSION_ID, 1)).toBe(token);
    expect(await deriveSubmissionAttemptToken(SECRET, SUBMISSION_ID, 2)).not.toBe(token);
    expect(parseSubmissionWorkflowParameters(parameters())).toEqual(parameters());
    expect(() => parseSubmissionWorkflowParameters({ ...parameters(), attemptToken: token })).toThrow("Workflow reference is invalid");
    expect(() => parseSubmissionWorkflowParameters({ ...parameters(), sourceR2Key: "sources/private" })).toThrow("Workflow reference is invalid");
    expect(() => parseSubmissionWorkflowParameters({ ...parameters(), expectedBuildId: "a".repeat(40) })).toThrow("Workflow reference is invalid");
  });
});
