import type { WasmOjWorkerEnv } from "./env";
import { assertSubmissionAttemptTokenHash, parseSubmissionWorkflowParameters } from "./submission-workflow-identity";

const BUILD_ID = /^[0-9a-f]{40}$/;

export interface HydratedSubmissionWorkflow {
  readonly submissionId: string;
  readonly userId: string;
  readonly attempt: number;
  readonly attemptToken: string;
  readonly sourceId: string;
  readonly sourceR2Key: string;
  readonly sourceSha256: string;
  readonly judgeR2Key: string;
  readonly judgeDigest: string;
  readonly problemId: string;
  readonly catalogCommit: string;
  readonly buildId: string;
  readonly workerVersionId: string;
  readonly contestId?: string;
  readonly rejudge?: {
    readonly jobId: string;
    readonly batchId: string;
    readonly originSubmissionId: string;
    readonly oldSubmissionId: string;
    readonly fromCommit: string;
  };
}

interface StoredSubmissionWorkflowRow {
  readonly user_id: string;
  readonly problem_id: string;
  readonly catalog_commit: string;
  readonly contest_id: string | null;
  readonly source_id: string;
  readonly content_sha256: string;
  readonly judge_digest: string;
  readonly token_hash: string;
}

export const HYDRATE_SUBMISSION_WORKFLOW_SQL = `SELECT
    submissions.user_id, submissions.problem_id, submissions.catalog_commit,
    submissions.contest_id, submissions.source_id, sources.content_sha256,
    submissions.judge_digest, attempts.token_hash
  FROM submissions
  JOIN submission_sources AS sources ON sources.id=submissions.source_id AND sources.state='ready'
  JOIN submission_attempts AS attempts ON attempts.submission_id=submissions.id AND attempts.attempt=?
  JOIN problem_revisions AS revisions
    ON revisions.problem_id=submissions.problem_id
   AND revisions.commit_sha=submissions.catalog_commit
   AND revisions.judge_digest=submissions.judge_digest
  WHERE submissions.id=?
    AND submissions.state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')
    AND EXISTS (SELECT 1 FROM users WHERE users.id=submissions.user_id AND users.status='active')
    AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=submissions.user_id)`;

function runtimeIdentity(env: WasmOjWorkerEnv): { readonly buildId: string; readonly workerVersionId: string } {
  const buildId = env.WASM_OJ_BUILD_ID;
  const metadata = env.CF_VERSION_METADATA;
  if (!BUILD_ID.test(buildId) || !metadata?.id || metadata.tag !== buildId) {
    throw new Error("Worker version metadata does not match the deployed build ID.");
  }
  return { buildId, workerVersionId: metadata.id };
}

export async function hydrateSubmissionWorkflow(env: WasmOjWorkerEnv, opaque: unknown): Promise<HydratedSubmissionWorkflow> {
  const parameters = parseSubmissionWorkflowParameters(opaque);
  const stored = await env.DB.prepare(HYDRATE_SUBMISSION_WORKFLOW_SQL)
    .bind(parameters.attempt, parameters.submissionId).first<StoredSubmissionWorkflowRow>();
  if (!stored) throw new Error("Submission Workflow reference does not match its immutable submission row.");
  const attemptToken = await assertSubmissionAttemptTokenHash(
    env.ACCOUNT_ERASURE_HMAC_SECRET,
    parameters.submissionId,
    parameters.attempt,
    stored.token_hash,
  );
  const runtime = runtimeIdentity(env);
  const rejudge = await env.DB.prepare(`SELECT id, rejudge_batch_id, origin_submission_id,
      old_submission_id, from_commit
      FROM rejudge_jobs
     WHERE new_submission_id=? AND state IN ('dispatched','ready')`)
    .bind(parameters.submissionId).first<{
      readonly id: string;
      readonly rejudge_batch_id: string;
      readonly origin_submission_id: string;
      readonly old_submission_id: string;
      readonly from_commit: string;
    }>();
  return {
    ...parameters,
    ...runtime,
    userId: stored.user_id,
    attemptToken,
    sourceId: stored.source_id,
    sourceR2Key: `submission-sources/v2/${stored.source_id}`,
    sourceSha256: stored.content_sha256,
    judgeR2Key: `judge-packages/v2/${stored.judge_digest}`,
    judgeDigest: stored.judge_digest,
    problemId: stored.problem_id,
    catalogCommit: stored.catalog_commit,
    ...(stored.contest_id ? { contestId: stored.contest_id } : {}),
    ...(rejudge ? {
      rejudge: {
        jobId: rejudge.id,
        batchId: rejudge.rejudge_batch_id,
        originSubmissionId: rejudge.origin_submission_id,
        oldSubmissionId: rejudge.old_submission_id,
        fromCommit: rejudge.from_commit,
      },
    } : {}),
  };
}
