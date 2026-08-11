const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_CONTAINER_RESULT_BYTES = 2 * 1024 * 1024;
const VERDICTS = new Set([
  "accepted", "wrong-answer", "runtime-error", "instruction-limit", "memory-limit",
  "output-limit", "filesystem-limit", "logical-time-limit", "wall-time-limit", "judge-error",
]);
const TERMINATIONS = new Set([
  "exited", "instruction-limit", "logical-time-limit", "memory-limit", "output-limit",
  "filesystem-limit", "wall-time-limit", "trap",
]);

export interface ContainerResultExpectation {
  readonly submissionId: string;
  readonly attempt: number;
  readonly expectedReleaseId: string;
  readonly expectedManifestSha256: string;
  readonly expectedContainerIdentitySha256: string;
  readonly expectedJudgeProjectionSha256: string;
  readonly expectedProblemBundleDigest: string;
}

export interface VerifiedContainerAudit {
  readonly schema: "forge-submission-audit-v1";
  readonly submissionId: string;
  readonly attempt: number;
  readonly sourceDigest: string;
  readonly forgeReleaseId: string;
  readonly expectedManifestSha256: string;
  readonly expectedContainerIdentitySha256: string;
  readonly actualContainerIdentitySha256: string;
  readonly judgeProjectionSha256: string;
  readonly problemBundleDigest: string;
  readonly cases: readonly {
    readonly verdict: string;
    readonly termination: string | null;
    readonly cost: number | null;
    readonly memoryBytes: number | null;
  }[];
}

export type VerifiedContainerSubmissionResult =
  | { readonly state: "compile-error"; readonly score: 0; readonly fullyPassedCases: 0 }
  | {
    readonly state: "completed" | "judge-error";
    readonly verdict: string;
    readonly score: number;
    readonly fullyPassedCases: number;
    readonly deterministicCost: number;
    readonly peakMemoryBytes: number;
    readonly audit: VerifiedContainerAudit;
  };

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a non-negative safe integer.`);
  return value as number;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be finite and non-negative.`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function equal(value: unknown, expected: string | number, label: string): void {
  if (value !== expected) throw new TypeError(`${label} does not match the immutable job.`);
}

function parseAudit(value: unknown, expected: ContainerResultExpectation): VerifiedContainerAudit {
  const audit = record(value, "Container audit");
  exact(audit, [
    "schema", "submissionId", "attempt", "sourceDigest", "forgeReleaseId",
    "expectedManifestSha256", "expectedContainerIdentitySha256", "actualContainerIdentitySha256",
    "judgeProjectionSha256", "problemBundleDigest", "cases",
  ], "Container audit");
  if (audit.schema !== "forge-submission-audit-v1") throw new TypeError("Container audit schema is unsupported.");
  equal(audit.submissionId, expected.submissionId, "Container audit submission");
  equal(audit.attempt, expected.attempt, "Container audit attempt");
  equal(audit.forgeReleaseId, expected.expectedReleaseId, "Container audit release");
  equal(audit.expectedManifestSha256, expected.expectedManifestSha256, "Container audit manifest");
  equal(audit.expectedContainerIdentitySha256, expected.expectedContainerIdentitySha256, "Container audit expected identity");
  equal(audit.judgeProjectionSha256, expected.expectedJudgeProjectionSha256, "Container audit judge projection");
  equal(audit.problemBundleDigest, expected.expectedProblemBundleDigest, "Container audit problem bundle");
  const sourceDigest = digest(audit.sourceDigest, "Container audit source");
  const actualIdentity = digest(audit.actualContainerIdentitySha256, "Container audit actual identity");
  if (actualIdentity !== expected.expectedContainerIdentitySha256) {
    throw new TypeError("Container audit actual identity does not match the immutable job.");
  }
  if (!Array.isArray(audit.cases) || audit.cases.length > 10_000) throw new TypeError("Container audit cases are invalid.");
  const cases = audit.cases.map((value, index) => {
    const item = record(value, `Container audit case ${index}`);
    exact(item, ["verdict", "termination", "cost", "memoryBytes"], `Container audit case ${index}`);
    if (typeof item.verdict !== "string" || !VERDICTS.has(item.verdict)) throw new TypeError(`Container audit case ${index} verdict is invalid.`);
    if (item.termination !== null && (typeof item.termination !== "string" || !TERMINATIONS.has(item.termination))) {
      throw new TypeError(`Container audit case ${index} termination is invalid.`);
    }
    return {
      verdict: item.verdict,
      termination: item.termination as string | null,
      cost: item.cost === null ? null : safeInteger(item.cost, `Container audit case ${index} cost`),
      memoryBytes: item.memoryBytes === null ? null : safeInteger(item.memoryBytes, `Container audit case ${index} memory`),
    };
  });
  return {
    schema: "forge-submission-audit-v1",
    submissionId: expected.submissionId,
    attempt: expected.attempt,
    sourceDigest,
    forgeReleaseId: expected.expectedReleaseId,
    expectedManifestSha256: expected.expectedManifestSha256,
    expectedContainerIdentitySha256: expected.expectedContainerIdentitySha256,
    actualContainerIdentitySha256: actualIdentity,
    judgeProjectionSha256: expected.expectedJudgeProjectionSha256,
    problemBundleDigest: expected.expectedProblemBundleDigest,
    cases,
  };
}

export function parseContainerSubmissionResult(
  value: unknown,
  expected: ContainerResultExpectation,
): VerifiedContainerSubmissionResult {
  if (!UUID.test(expected.expectedReleaseId) || !Number.isSafeInteger(expected.attempt) || expected.attempt < 1) {
    throw new TypeError("Container result expectation is invalid.");
  }
  for (const [label, value] of Object.entries({
    manifest: expected.expectedManifestSha256,
    identity: expected.expectedContainerIdentitySha256,
    projection: expected.expectedJudgeProjectionSha256,
    bundle: expected.expectedProblemBundleDigest,
  })) digest(value, `Expected ${label}`);
  const result = record(value, "Container submission result");
  if (result.state === "compile-error") {
    exact(result, ["state", "score", "fullyPassedCases"], "Compile-error container result");
    if (result.score !== 0 || result.fullyPassedCases !== 0) throw new TypeError("Compile-error result must have zero score and passed cases.");
    return { state: "compile-error", score: 0, fullyPassedCases: 0 };
  }
  if (result.state !== "completed" && result.state !== "judge-error") throw new TypeError("Container submission terminal state is invalid.");
  exact(result, ["state", "verdict", "score", "fullyPassedCases", "deterministicCost", "peakMemoryBytes", "audit"], "Container submission result");
  if (typeof result.verdict !== "string" || !VERDICTS.has(result.verdict)) throw new TypeError("Container result verdict is invalid.");
  if (result.state === "judge-error" && result.verdict !== "judge-error") throw new TypeError("Judge-error state and verdict disagree.");
  if (result.state === "completed" && result.verdict === "judge-error") throw new TypeError("Completed state may not carry judge-error.");
  const score = finiteNumber(result.score, "Container result score");
  const fullyPassedCases = safeInteger(result.fullyPassedCases, "Container result passed cases");
  if (score > 100) throw new TypeError("Container result score exceeds the public scoring contract.");
  if (result.state === "judge-error" && (score !== 0 || fullyPassedCases !== 0)) throw new TypeError("Judge-error result must have zero score and passed cases.");
  const audit = parseAudit(result.audit, expected);
  if (fullyPassedCases > audit.cases.length) throw new TypeError("Container result passed cases exceed its bounded audit inventory.");
  return {
    state: result.state,
    verdict: result.verdict,
    score,
    fullyPassedCases,
    deterministicCost: safeInteger(result.deterministicCost, "Container result deterministic cost"),
    peakMemoryBytes: safeInteger(result.peakMemoryBytes, "Container result peak memory"),
    audit,
  };
}

export async function readContainerSubmissionResult(
  response: Response,
  expected: ContainerResultExpectation,
): Promise<VerifiedContainerSubmissionResult> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 1 || Number(declared) > MAX_CONTAINER_RESULT_BYTES)) {
    throw new TypeError("Container result exceeds its bounded response contract.");
  }
  if (!response.body) throw new TypeError("Container result has no response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CONTAINER_RESULT_BYTES) throw new TypeError("Container result exceeds its bounded response contract.");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("Container result is not valid UTF-8 JSON.");
  } finally {
    bytes.fill(0);
  }
  return parseContainerSubmissionResult(parsed, expected);
}
