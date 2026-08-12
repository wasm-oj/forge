import { sha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";
import { prepareSubmissionEventInsert } from "./submission-events";
import type { HydratedSubmissionWorkflow } from "./submission-workflow-context";

export async function createRetryAttempt(
  env: WasmOjWorkerEnv,
  submission: HydratedSubmissionWorkflow,
  failedAttempt: number,
  nextAttempt: number,
  token: string,
): Promise<void> {
  if (nextAttempt !== failedAttempt + 1) throw new TypeError("Submission retry attempts must be consecutive.");
  const now = new Date().toISOString();
  const tokenHash = await sha256Hex(token);
  await env.DB.batch([
    env.DB.prepare(`UPDATE submission_attempts
        SET state='failed', finished_at=?, failure_code='container-failure'
      WHERE submission_id=? AND attempt=? AND state='running'`)
      .bind(now, submission.submissionId, failedAttempt),
    env.DB.prepare(`INSERT INTO submission_attempts
        (submission_id, attempt, token_hash, state)
      SELECT id, ?, ?, 'created' FROM submissions
       WHERE id=? AND state IN ('preparing','compiling','running','finalizing')
         AND EXISTS (
           SELECT 1 FROM submission_attempts AS failed
            WHERE failed.submission_id=submissions.id
              AND failed.attempt=? AND failed.state='failed'
         )
      ON CONFLICT(submission_id, attempt) DO NOTHING`)
      .bind(nextAttempt, tokenHash, submission.submissionId, failedAttempt),
    env.DB.prepare(`UPDATE submissions
        SET state='preparing', updated_at=?
      WHERE id=? AND state IN ('preparing','compiling','running','finalizing')
        AND EXISTS (
          SELECT 1 FROM submission_attempts
           WHERE submission_id=submissions.id AND attempt=?
             AND token_hash=? AND state='created'
        )`)
      .bind(now, submission.submissionId, nextAttempt, tokenHash),
    prepareSubmissionEventInsert(env.DB, {
      submissionId: submission.submissionId,
      eventKey: `workflow:retry:${nextAttempt}`,
      event: { kind: "state", state: "preparing" },
      timestamp: now,
      requiredState: "preparing",
    }),
  ]);
  const exact = await env.DB.prepare(`SELECT attempts.token_hash, attempts.state,
      failed.state AS failed_state, submissions.state AS submission_state
    FROM submission_attempts AS attempts
    JOIN submission_attempts AS failed
      ON failed.submission_id=attempts.submission_id AND failed.attempt=?
    JOIN submissions ON submissions.id=attempts.submission_id
    WHERE attempts.submission_id=? AND attempts.attempt=?`)
    .bind(failedAttempt, submission.submissionId, nextAttempt)
    .first<{
      readonly token_hash: string;
      readonly state: string;
      readonly failed_state: string;
      readonly submission_state: string;
    }>();
  if (
    !exact
    || exact.token_hash !== tokenHash
    || exact.state !== "created"
    || exact.failed_state !== "failed"
    || exact.submission_state !== "preparing"
  ) {
    throw new Error("Submission retry attempt conflicts with durable state.");
  }
}
