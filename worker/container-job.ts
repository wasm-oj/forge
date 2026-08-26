import { parseSubmissionAttemptToken } from "./submission-workflow-identity";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const BUILD_ID = /^[0-9a-f]{40}$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;

interface ContainerJobBase {
  readonly jobId: string;
  readonly attempt: number;
  readonly attemptToken: string;
  readonly expectedBuildId: string;
  readonly expectedWorkerVersionId: string;
}

export type SubmissionExecuteRequest = ContainerJobBase & {
  readonly kind: "submission";
  readonly submissionId: string;
  readonly sourceId: string;
  readonly sourceR2Key: string;
  readonly sourceSha256: string;
  readonly judgeR2Key: string;
  readonly judgeDigest: string;
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
    expectedBuildId: patterned(value.expectedBuildId, BUILD_ID, "container expectedBuildId", 40),
    expectedWorkerVersionId: patterned(value.expectedWorkerVersionId, VERSION_ID, "container expectedWorkerVersionId", 512),
  };
}

export function parseExecuteRequest(value: unknown): ExecuteRequest {
  const input = object(value, "container job");
  if (input.kind !== "submission") throw new TypeError("container job kind is unsupported.");
  exact(input, [
    "attempt", "attemptToken", "expectedBuildId", "expectedWorkerVersionId", "jobId",
    "judgeDigest", "judgeR2Key", "kind", "sourceId", "sourceR2Key", "sourceSha256", "submissionId",
  ], "submission container job");
  const parsedBase = base(input);
  const submissionId = patterned(input.submissionId, UUID, "container submissionId", 36);
  if (submissionId !== parsedBase.jobId) throw new TypeError("container submission identity is inconsistent.");
  const sourceId = patterned(input.sourceId, UUID, "container sourceId", 36);
  if (input.sourceR2Key !== `submission-sources/v2/${sourceId}`) throw new TypeError("container source key is not bound to its source identity.");
  const sourceSha256 = patterned(input.sourceSha256, DIGEST, "container sourceSha256", 64);
  const judgeDigest = patterned(input.judgeDigest, DIGEST, "container judgeDigest", 64);
  if (input.judgeR2Key !== `judge-packages/v2/${judgeDigest}`) throw new TypeError("container judge key is not bound to its digest.");
  return {
    ...parsedBase,
    kind: "submission",
    submissionId,
    sourceId,
    sourceR2Key: input.sourceR2Key as string,
    sourceSha256,
    judgeR2Key: input.judgeR2Key as string,
    judgeDigest,
  };
}
