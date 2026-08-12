const MAX_CONTAINER_RESULT_BYTES = 64 * 1024;
const VERDICTS = new Set([
  "accepted", "wrong-answer", "runtime-error", "instruction-limit", "memory-limit",
  "output-limit", "filesystem-limit", "logical-time-limit", "wall-time-limit", "judge-error",
]);
const POLICY_IDS = ["baseline", "efficient", "optimal"] as const;
const MAX_POLICY_SUMMARY_CASES = 10_000;

export interface VerifiedPolicyAggregate {
  readonly id: (typeof POLICY_IDS)[number];
  readonly earnedCases: number;
  readonly costExceededCases: number;
  readonly memoryExceededCases: number;
  readonly logicalTimeExceededCases: number;
}

export interface VerifiedSubmissionPolicySummary {
  readonly totalCases: number;
  readonly outputAcceptedCases: number;
  readonly policies: readonly VerifiedPolicyAggregate[];
}

export type VerifiedContainerSubmissionResult =
  | { readonly state: "compile-error"; readonly score: 0; readonly fullyPassedCases: 0 }
  | {
    readonly state: "judge-error";
    readonly verdict: "judge-error";
    readonly score: 0;
    readonly fullyPassedCases: 0;
    readonly deterministicCost: number;
    readonly peakMemoryBytes: number;
  }
  | {
    readonly state: "completed";
    readonly verdict: string;
    readonly score: number;
    readonly fullyPassedCases: number;
    readonly deterministicCost: number;
    readonly peakMemoryBytes: number;
    readonly policySummary: VerifiedSubmissionPolicySummary;
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

function parsePolicySummary(value: unknown, fullyPassedCases: number): VerifiedSubmissionPolicySummary {
  const summary = record(value, "Container policy summary");
  exact(summary, ["totalCases", "outputAcceptedCases", "policies"], "Container policy summary");
  const totalCases = safeInteger(summary.totalCases, "Policy summary total cases");
  const outputAcceptedCases = safeInteger(summary.outputAcceptedCases, "Policy summary output-accepted cases");
  if (totalCases < 1 || totalCases > MAX_POLICY_SUMMARY_CASES) {
    throw new TypeError("Policy summary total cases are outside the judge contract.");
  }
  if (outputAcceptedCases > totalCases || outputAcceptedCases !== fullyPassedCases) {
    throw new TypeError("Policy summary output-accepted cases disagree with the terminal result.");
  }
  if (!Array.isArray(summary.policies) || summary.policies.length !== POLICY_IDS.length) {
    throw new TypeError("Policy summary must contain exactly three policies.");
  }
  const policies = summary.policies.map((value, index): VerifiedPolicyAggregate => {
    const policy = record(value, `Policy summary '${POLICY_IDS[index]}'`);
    exact(policy, [
      "id", "earnedCases", "costExceededCases", "memoryExceededCases",
      "logicalTimeExceededCases",
    ], `Policy summary '${POLICY_IDS[index]}'`);
    const id = POLICY_IDS[index];
    if (policy.id !== id) throw new TypeError("Policy summary order is invalid.");
    const earnedCases = safeInteger(policy.earnedCases, `Policy summary '${id}' earned cases`);
    const costExceededCases = safeInteger(policy.costExceededCases, `Policy summary '${id}' cost failures`);
    const memoryExceededCases = safeInteger(policy.memoryExceededCases, `Policy summary '${id}' memory failures`);
    const logicalTimeExceededCases = safeInteger(policy.logicalTimeExceededCases, `Policy summary '${id}' logical-time failures`);
    const counts = [earnedCases, costExceededCases, memoryExceededCases, logicalTimeExceededCases];
    if (counts.some((count) => count > outputAcceptedCases)) {
      throw new TypeError(`Policy summary '${id}' count exceeds output-accepted cases.`);
    }
    for (const failedCases of counts.slice(1)) {
      if (earnedCases + failedCases > outputAcceptedCases) {
        throw new TypeError(`Policy summary '${id}' contradicts its earned cases.`);
      }
    }
    return { id, earnedCases, costExceededCases, memoryExceededCases, logicalTimeExceededCases };
  });
  return { totalCases, outputAcceptedCases, policies };
}

export function parseContainerSubmissionResult(value: unknown): VerifiedContainerSubmissionResult {
  const result = record(value, "Container submission result");
  if (result.state === "compile-error") {
    exact(result, ["state", "score", "fullyPassedCases"], "Compile-error container result");
    if (result.score !== 0 || result.fullyPassedCases !== 0) throw new TypeError("Compile-error result must have zero score and passed cases.");
    return { state: "compile-error", score: 0, fullyPassedCases: 0 };
  }
  if (result.state !== "completed" && result.state !== "judge-error") throw new TypeError("Container submission terminal state is invalid.");
  exact(result, result.state === "completed"
    ? ["state", "verdict", "score", "fullyPassedCases", "deterministicCost", "peakMemoryBytes", "policySummary"]
    : ["state", "verdict", "score", "fullyPassedCases", "deterministicCost", "peakMemoryBytes"], "Container submission result");
  if (typeof result.verdict !== "string" || !VERDICTS.has(result.verdict)) throw new TypeError("Container result verdict is invalid.");
  if (result.state === "judge-error" && result.verdict !== "judge-error") throw new TypeError("Judge-error state and verdict disagree.");
  if (result.state === "completed" && result.verdict === "judge-error") throw new TypeError("Completed state may not carry judge-error.");
  const score = finiteNumber(result.score, "Container result score");
  const fullyPassedCases = safeInteger(result.fullyPassedCases, "Container result passed cases");
  if (score > 100) throw new TypeError("Container result score exceeds the public scoring contract.");
  if (result.state === "judge-error" && (score !== 0 || fullyPassedCases !== 0)) throw new TypeError("Judge-error result must have zero score and passed cases.");
  const deterministicCost = safeInteger(result.deterministicCost, "Container result deterministic cost");
  const peakMemoryBytes = safeInteger(result.peakMemoryBytes, "Container result peak memory");
  if (result.state === "judge-error") {
    return {
      state: "judge-error",
      verdict: "judge-error",
      score: 0,
      fullyPassedCases: 0,
      deterministicCost,
      peakMemoryBytes,
    };
  }
  return {
    state: "completed",
    verdict: result.verdict,
    score,
    fullyPassedCases,
    deterministicCost,
    peakMemoryBytes,
    policySummary: parsePolicySummary(result.policySummary, fullyPassedCases),
  };
}

export async function readContainerSubmissionResult(response: Response): Promise<VerifiedContainerSubmissionResult> {
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
  try {
    return parseContainerSubmissionResult(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Container result is not valid UTF-8 JSON.");
  } finally {
    bytes.fill(0);
  }
}
