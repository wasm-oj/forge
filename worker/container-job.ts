import { parseSubmissionAttemptToken } from "./submission-workflow-identity";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;

interface ContainerJobBase {
  readonly jobId: string;
  readonly attempt: number;
  readonly attemptToken: string;
  readonly expectedReleaseId: string;
  readonly expectedManifestSha256: string;
  readonly expectedContainerIdentitySha256: string;
}

export type SubmissionExecuteRequest = ContainerJobBase & {
  readonly kind: "submission";
  readonly submissionId: string;
  readonly sourceId: string;
  readonly sourceR2Key: string;
  readonly sourceSha256: string;
  readonly judgeR2Key: string;
  readonly executionSemanticSha256: string;
};

export type ExecuteRequest = SubmissionExecuteRequest;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new TypeError(`${label} has an invalid shape.`);
}

function patterned(value: unknown, pattern: RegExp, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function base(value: Record<string, unknown>): ContainerJobBase {
  const jobId = patterned(value.jobId, UUID, "container jobId", 36);
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1 || (value.attempt as number) > 2) throw new TypeError("container attempt is invalid.");
  return {
    jobId,
    attempt: value.attempt as number,
    attemptToken: parseSubmissionAttemptToken(value.attemptToken),
    expectedReleaseId: patterned(value.expectedReleaseId, UUID, "container expectedReleaseId", 36),
    expectedManifestSha256: patterned(value.expectedManifestSha256, DIGEST, "container expectedManifestSha256", 64),
    expectedContainerIdentitySha256: patterned(value.expectedContainerIdentitySha256, DIGEST, "container expectedContainerIdentitySha256", 64),
  };
}

export function parseExecuteRequest(value: unknown): ExecuteRequest {
  const input = object(value, "container job");
  if (input.kind !== "submission") throw new TypeError("container job kind is unsupported.");
  exact(input, [
    "attempt", "attemptToken", "executionSemanticSha256", "expectedContainerIdentitySha256",
    "expectedManifestSha256", "expectedReleaseId", "jobId", "judgeR2Key", "kind",
    "sourceId", "sourceR2Key", "sourceSha256", "submissionId",
  ], "submission container job");
  const parsedBase = base(input);
  const submissionId = patterned(input.submissionId, UUID, "container submissionId", 36);
  if (submissionId !== parsedBase.jobId) throw new TypeError("container submission identity is inconsistent.");
  const sourceId = patterned(input.sourceId, UUID, "container sourceId", 36);
  if (input.sourceR2Key !== `submission-sources/v2/${sourceId}`) {
    throw new TypeError("container source key is not bound to its source identity.");
  }
  const sourceSha256 = patterned(input.sourceSha256, DIGEST, "container sourceSha256", 64);
  const executionSemanticSha256 = patterned(input.executionSemanticSha256, DIGEST, "container executionSemanticSha256", 64);
  if (input.judgeR2Key !== `judge-packages/v2/${executionSemanticSha256}`) {
    throw new TypeError("container judge key is not bound to its execution semantic digest.");
  }
  return {
    ...parsedBase,
    kind: "submission",
    submissionId,
    sourceId,
    sourceR2Key: input.sourceR2Key as string,
    sourceSha256,
    judgeR2Key: input.judgeR2Key as string,
    executionSemanticSha256,
  };
}
