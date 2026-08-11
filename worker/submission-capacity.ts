import type { ForgeWorkerEnv } from "./env";
import { prepareSubmissionEventInsert } from "./submission-events";

export const MAX_QUEUED_SUBMISSIONS_PER_USER = 3;
export const MAX_EXECUTING_SUBMISSIONS = 50;
export const MAX_NONTERMINAL_SUBMISSIONS = 500;

export const NONTERMINAL_SUBMISSION_STATES = [
  "admitting",
  "queued",
  "waiting-capacity",
  "preparing",
  "compiling",
  "running",
  "finalizing",
] as const;

export const EXECUTING_SUBMISSION_STATES = [
  "preparing",
  "compiling",
  "running",
  "finalizing",
] as const;

const EXECUTING_SQL = EXECUTING_SUBMISSION_STATES.map(() => "?").join(",");

export const CLAIM_SUBMISSION_EXECUTION_SLOT_SQL = `UPDATE submissions
   SET state='preparing', updated_at=?
 WHERE id=?
   AND state IN ('queued','waiting-capacity')
   AND (
     SELECT COUNT(*) FROM submissions
      WHERE state IN ('preparing','compiling','running','finalizing')
   ) < ${MAX_EXECUTING_SUBMISSIONS}
   AND NOT EXISTS (
     SELECT 1 FROM submissions AS active
      WHERE active.user_id=submissions.user_id
        AND active.id<>submissions.id
        AND active.state IN ('preparing','compiling','running','finalizing')
   )`;

export interface SubmissionCapacitySnapshot {
  readonly globalNonterminal: number;
  readonly userQueued: number;
}

export async function submissionCapacitySnapshot(
  env: ForgeWorkerEnv,
  userId: string,
): Promise<SubmissionCapacitySnapshot> {
  const [global, user] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM submissions WHERE state IN (${NONTERMINAL_SUBMISSION_STATES.map(() => "?").join(",")})`,
    ).bind(...NONTERMINAL_SUBMISSION_STATES).first<{ readonly count: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM submissions WHERE user_id=? AND state IN ('admitting','queued','waiting-capacity')",
    ).bind(userId).first<{ readonly count: number }>(),
  ]);
  return {
    globalNonterminal: global?.count ?? 0,
    userQueued: user?.count ?? 0,
  };
}

export async function claimSubmissionExecutionSlot(
  env: ForgeWorkerEnv,
  submissionId: string,
  now = new Date(),
): Promise<boolean> {
  const timestamp = now.toISOString();
  const [claimed] = await env.DB.batch([
    env.DB.prepare(CLAIM_SUBMISSION_EXECUTION_SLOT_SQL)
      .bind(timestamp, submissionId),
    prepareSubmissionEventInsert(env.DB, {
      submissionId,
      eventKey: "workflow:execution-slot",
      event: { kind: "state", state: "preparing" },
      timestamp,
      requiredState: "preparing",
    }),
  ]);
  if (claimed?.meta.changes === 1) return true;
  const existing = await env.DB.prepare(
    `SELECT state FROM submissions WHERE id=? AND state IN (${EXECUTING_SQL})`,
  ).bind(submissionId, ...EXECUTING_SUBMISSION_STATES).first<{ readonly state: string }>();
  return existing !== null;
}
