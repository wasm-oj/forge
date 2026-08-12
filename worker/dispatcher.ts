import capacity from "../config/capacity.json";
import type { WasmOjWorkerEnv } from "./env";
import { prepareSubmissionEventInsert } from "./submission-events";
import type { SubmissionWorkflowParameters } from "./submission-workflow-identity";
import { operationalLog } from "./structured-log";
import { workflowInstanceNotFound } from "./workflow-instance-status";

interface ClaimedSubmission {
  readonly id: string;
  readonly wasm_oj_release_id: string;
  readonly wasm_oj_manifest_sha256: string;
  readonly attempt: number;
}

const CLAIM_OLDEST_SUBMISSION_SQL = `UPDATE submissions
   SET state='preparing', updated_at=?
 WHERE id=(
   SELECT candidate.id
     FROM submissions AS candidate
    WHERE candidate.state='queued'
      AND EXISTS (
        SELECT 1 FROM workflow_outbox
         WHERE submission_id=candidate.id AND state='pending'
      )
      AND NOT EXISTS (
        SELECT 1 FROM submissions AS active
         WHERE active.user_id=candidate.user_id
           AND active.id<>candidate.id
           AND active.state IN ('preparing','compiling','running','finalizing')
      )
      AND (
        NOT EXISTS (SELECT 1 FROM rejudge_jobs WHERE new_submission_id=candidate.id)
        OR (
          SELECT COUNT(*)
            FROM submissions AS active_rejudge
           WHERE active_rejudge.state IN ('preparing','compiling','running','finalizing')
             AND EXISTS (SELECT 1 FROM rejudge_jobs WHERE new_submission_id=active_rejudge.id)
        ) < ${capacity.submission.rejudgeActive}
      )
    ORDER BY candidate.created_at ASC, candidate.id ASC
    LIMIT 1
 )
   AND (
     SELECT COUNT(*) FROM submissions
      WHERE state IN ('preparing','compiling','running','finalizing')
   ) < ${capacity.submission.globalActive}
 RETURNING id, wasm_oj_release_id, wasm_oj_manifest_sha256,
   (SELECT MAX(attempt) FROM submission_attempts WHERE submission_id=submissions.id) AS attempt`;

export async function claimOldestSubmission(env: WasmOjWorkerEnv, now = new Date()): Promise<ClaimedSubmission | null> {
  return env.DB.prepare(CLAIM_OLDEST_SUBMISSION_SQL).bind(now.toISOString()).first<ClaimedSubmission>();
}

async function deliverClaimedSubmission(env: WasmOjWorkerEnv, claimed: ClaimedSubmission, now: Date): Promise<void> {
  if (!Number.isSafeInteger(claimed.attempt) || claimed.attempt < 1) throw new Error("Claimed submission has no active attempt.");
  const parameters = {
    submissionId: claimed.id,
    attempt: claimed.attempt,
    expectedReleaseId: claimed.wasm_oj_release_id,
    expectedManifestSha256: claimed.wasm_oj_manifest_sha256,
  } satisfies SubmissionWorkflowParameters;
  const timestamp = now.toISOString();
  const recordDeferred = async (error: unknown, incrementAttempts: boolean): Promise<void> => {
    const message = error instanceof Error ? error.message.slice(0, 500) : "workflow-delivery-failed";
    await env.DB.prepare(`UPDATE workflow_outbox
        SET attempts=attempts+?, last_error=?, updated_at=?
      WHERE submission_id=? AND state='pending'`)
      .bind(incrementAttempts ? 1 : 0, message, timestamp, claimed.id).run();
    operationalLog("warn", {
      event: "workflow.delivery-deferred",
      outcome: "deferred",
      code: "start-submission-workflow",
      aggregateType: "submission",
      aggregateId: claimed.id,
    });
  };
  const markDelivered = async (incrementAttempts: boolean): Promise<void> => {
    await env.DB.batch([
      env.DB.prepare(`UPDATE workflow_outbox
          SET state='delivered', settled_at=?, attempts=attempts+?, last_error=NULL, updated_at=?
        WHERE submission_id=? AND state='pending'`)
        .bind(timestamp, incrementAttempts ? 1 : 0, timestamp, claimed.id),
      prepareSubmissionEventInsert(env.DB, {
        submissionId: claimed.id,
        eventKey: "dispatcher:preparing",
        event: { kind: "state", state: "preparing" },
        timestamp,
        requiredState: "preparing",
      }),
    ]);
  };

  let status: { readonly status: string };
  try {
    status = await (await env.SUBMISSION_WORKFLOW.get(claimed.id)).status();
  } catch (error) {
    if (workflowInstanceNotFound(error)) status = { status: "unknown" };
    else {
      await recordDeferred(error, false);
      return;
    }
  }
  if (status.status !== "unknown") {
    await markDelivered(false);
    return;
  }

  try {
    await env.SUBMISSION_WORKFLOW.create({ id: claimed.id, params: parameters });
    await markDelivered(true);
  } catch (createError) {
    try {
      const observed = await (await env.SUBMISSION_WORKFLOW.get(claimed.id)).status();
      if (observed.status !== "unknown") {
        await markDelivered(true);
        return;
      }
    } catch (statusError) {
      if (!workflowInstanceNotFound(statusError)) {
        await recordDeferred(statusError, false);
        return;
      }
    }
    await recordDeferred(createError, true);
  }
}

export async function dispatchSubmissionJobs(env: WasmOjWorkerEnv, maximum = capacity.submission.globalActive): Promise<number> {
  let dispatched = 0;
  for (; dispatched < maximum; dispatched += 1) {
    const now = new Date();
    const claimed = await claimOldestSubmission(env, now);
    if (!claimed) break;
    await deliverClaimedSubmission(env, claimed, now);
  }
  return dispatched;
}

export async function redeliverClaimedSubmission(env: WasmOjWorkerEnv, submissionId: string): Promise<boolean> {
  const claimed = await env.DB.prepare(`SELECT submissions.id, submissions.wasm_oj_release_id,
      submissions.wasm_oj_manifest_sha256,
      (SELECT MAX(attempt) FROM submission_attempts WHERE submission_id=submissions.id) AS attempt
    FROM submissions
    JOIN workflow_outbox ON workflow_outbox.submission_id=submissions.id
      AND workflow_outbox.state='pending'
    WHERE submissions.id=? AND submissions.state='preparing'`)
    .bind(submissionId).first<ClaimedSubmission>();
  if (!claimed) return false;
  await deliverClaimedSubmission(env, claimed, new Date());
  return true;
}
