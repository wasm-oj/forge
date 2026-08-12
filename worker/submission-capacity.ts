import type { WasmOjWorkerEnv } from "./env";
import capacity from "../config/capacity.json";

export const MAX_QUEUED_SUBMISSIONS_PER_USER = capacity.submission.perUserQueued;
export const MAX_EXECUTING_SUBMISSIONS = capacity.submission.globalActive;
export const MAX_QUEUED_SUBMISSIONS = capacity.submission.globalQueued;
export const MAX_EXECUTING_REJUDGES = capacity.submission.rejudgeActive;

export const EXECUTING_SUBMISSION_STATES = [
  "preparing",
  "compiling",
  "running",
  "finalizing",
] as const;

const EXECUTING_SQL = EXECUTING_SUBMISSION_STATES.map(() => "?").join(",");

export interface SubmissionCapacitySnapshot {
  readonly globalQueued: number;
  readonly userQueued: number;
}

export async function submissionCapacitySnapshot(
  env: WasmOjWorkerEnv,
  userId: string,
): Promise<SubmissionCapacitySnapshot> {
  const [global, user] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM submissions WHERE state IN ('admitting','queued')",
    ).first<{ readonly count: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM submissions WHERE user_id=? AND state IN ('admitting','queued')",
    ).bind(userId).first<{ readonly count: number }>(),
  ]);
  return {
    globalQueued: global?.count ?? 0,
    userQueued: user?.count ?? 0,
  };
}

export async function submissionHasExecutionSlot(env: WasmOjWorkerEnv, submissionId: string): Promise<boolean> {
  const existing = await env.DB.prepare(`SELECT state FROM submissions WHERE id=? AND state IN (${EXECUTING_SQL})`)
    .bind(submissionId, ...EXECUTING_SUBMISSION_STATES).first<{ readonly state: string }>();
  return existing !== null;
}
