import { compareLeaderboardEntries, type LeaderboardEntry } from "./contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

export interface CreateRejudgeRequest {
  readonly oldProblemVersionId: string;
  readonly newProblemVersionId: string;
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
  const expected = ["idempotencyKey", "newProblemVersionId", "oldProblemVersionId"];
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(input, key))) {
    throw new TypeError("Rejudge request has an invalid shape.");
  }
  if (typeof input.oldProblemVersionId !== "string" || !UUID_PATTERN.test(input.oldProblemVersionId)) {
    throw new TypeError("oldProblemVersionId must be a UUID.");
  }
  if (typeof input.newProblemVersionId !== "string" || !UUID_PATTERN.test(input.newProblemVersionId)) {
    throw new TypeError("newProblemVersionId must be a UUID.");
  }
  if (input.oldProblemVersionId === input.newProblemVersionId) {
    throw new TypeError("Rejudge versions must be different.");
  }
  if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
    throw new TypeError("idempotencyKey must contain 16–128 safe characters.");
  }
  return {
    oldProblemVersionId: input.oldProblemVersionId,
    newProblemVersionId: input.newProblemVersionId,
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

export interface ContestRejudgeSelection {
  readonly batchId: string;
  readonly stagedProblemVersionId: string;
}

export function parseContestRejudgeSelection(value: string | null): ReadonlyMap<string, ContestRejudgeSelection> {
  if (value === null || value === "") return new Map();
  if (value.length > 16_384) throw new TypeError("Contest rejudge selection is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("Contest rejudge selection is invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Contest rejudge selection must be an object.");
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 100 || entries.some(([problemId, selection]) => {
    if (!UUID_PATTERN.test(problemId) || !selection || typeof selection !== "object" || Array.isArray(selection)) return true;
    const record = selection as Record<string, unknown>;
    return Object.keys(record).length !== 2
      || typeof record.batchId !== "string"
      || !UUID_PATTERN.test(record.batchId)
      || typeof record.stagedProblemVersionId !== "string"
      || !UUID_PATTERN.test(record.stagedProblemVersionId);
  })) {
    throw new TypeError("Contest rejudge selection contains an invalid identifier.");
  }
  return new Map(entries as [string, ContestRejudgeSelection][]);
}

export function encodeContestRejudgeSelection(selection: ReadonlyMap<string, ContestRejudgeSelection>): string {
  return JSON.stringify(Object.fromEntries([...selection].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
}

export interface ProjectedLeaderboardEntry extends LeaderboardEntry {
  readonly submissionId: string;
}

export function mergeEffectiveLeaderboardEntries(
  direct: readonly ProjectedLeaderboardEntry[],
  rejudged: readonly ProjectedLeaderboardEntry[],
  limit: number,
): readonly ProjectedLeaderboardEntry[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Leaderboard limit must be 1–100.");
  const best = new Map<string, ProjectedLeaderboardEntry>();
  for (const entry of [...direct, ...rejudged]) {
    const current = best.get(entry.userId);
    if (!current || compareLeaderboardEntries(entry, current) < 0) best.set(entry.userId, entry);
  }
  return [...best.values()]
    .sort((left, right) => compareLeaderboardEntries(left, right))
    .slice(0, limit);
}

export type SubmissionCompletionOutboxKind = "rejudge-result" | "update-profile";

export function submissionCompletionOutboxKinds(input: {
  readonly rejudge: boolean;
  readonly state: RejudgeChildState;
  readonly contest: boolean;
}): readonly SubmissionCompletionOutboxKind[] {
  if (input.rejudge) return ["rejudge-result"];
  if (input.state !== "completed") return [];
  // Leaderboards are queried directly from authoritative submissions. The
  // only remaining cross-database projection is the practice solve profile.
  if (input.contest) return [];
  return ["update-profile"];
}

export function formalAdmissionCommitWon(changes: number): boolean {
  if (!Number.isSafeInteger(changes) || changes < 0 || changes > 1) throw new TypeError("Formal admission commit count is invalid.");
  return changes === 1;
}

export type FormalAdmissionMarkerState = "pending" | "committed" | "aborted" | null;
export type SubmissionWorkflowFenceDisposition = "start" | "wait" | "reject";

export function submissionWorkflowFenceDisposition(input: {
  readonly rejudge: boolean;
  readonly markerState: FormalAdmissionMarkerState;
}): SubmissionWorkflowFenceDisposition {
  if (input.rejudge) return "start";
  if (input.markerState === "committed") return "start";
  if (input.markerState === "pending") return "wait";
  return "reject";
}
