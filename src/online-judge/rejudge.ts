const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

export interface CreateRejudgeRequest {
  readonly problemId: string;
  readonly fromCommit: string;
  readonly toCommit: string;
  readonly contestId?: string;
  readonly idempotencyKey: string;
}

export type RejudgeChildState =
  | "completed"
  | "compile-error"
  | "judge-error"
  | "infrastructure-error"
  | "cancelled";

export type RejudgeChildDisposition = "ready" | "failed";
export type RejudgeProgressState = "running" | "ready" | "failed";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Rejudge request must be an object.");
  return value as Record<string, unknown>;
}

export function parseCreateRejudgeRequest(value: unknown): CreateRejudgeRequest {
  const input = record(value);
  const keys = Object.keys(input);
  const required = ["fromCommit", "idempotencyKey", "problemId", "toCommit"];
  const allowed = new Set([...required, "contestId"]);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(input, key))) {
    throw new TypeError("Rejudge request has an invalid shape.");
  }
  if (typeof input.problemId !== "string" || !UUID_PATTERN.test(input.problemId)) {
    throw new TypeError("problemId must be a UUID.");
  }
  if (typeof input.fromCommit !== "string" || !/^[0-9a-f]{40}$/.test(input.fromCommit)
    || typeof input.toCommit !== "string" || !/^[0-9a-f]{40}$/.test(input.toCommit)) {
    throw new TypeError("fromCommit and toCommit must be lowercase 40-character Git commit SHAs.");
  }
  if (input.fromCommit === input.toCommit) {
    throw new TypeError("Rejudge commits must be different.");
  }
  const contestId = input.contestId === undefined ? undefined : input.contestId;
  if (contestId !== undefined && (typeof contestId !== "string" || !UUID_PATTERN.test(contestId))) throw new TypeError("contestId must be a UUID.");
  if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
    throw new TypeError("idempotencyKey must contain 16–128 safe characters.");
  }
  return {
    problemId: input.problemId,
    fromCommit: input.fromCommit,
    toCommit: input.toCommit,
    ...(contestId ? { contestId } : {}),
    idempotencyKey: input.idempotencyKey,
  };
}

export function classifyRejudgeChildState(state: RejudgeChildState): RejudgeChildDisposition {
  return state === "completed" || state === "compile-error" ? "ready" : "failed";
}

export function classifyRejudgeProgress(input: {
  readonly expected: number;
  readonly materialized: number;
  readonly ready: number;
  readonly failed: number;
}): RejudgeProgressState {
  for (const [label, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} count must be a non-negative safe integer.`);
  }
  if (input.materialized > input.expected || input.ready + input.failed > input.materialized) {
    throw new TypeError("Rejudge progress counts are inconsistent.");
  }
  if (input.failed > 0) return "failed";
  return input.materialized === input.expected && input.ready === input.expected ? "ready" : "running";
}
