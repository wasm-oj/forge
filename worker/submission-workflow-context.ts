import type { WasmOjWorkerEnv } from "./env";
import { assertActiveRelease } from "./release";
import { assertSubmissionAttemptTokenHash, parseSubmissionWorkflowParameters } from "./submission-workflow-identity";

export interface HydratedSubmissionWorkflow {
  readonly submissionId: string;
  readonly userId: string;
  readonly attempt: number;
  readonly attemptToken: string;
  readonly sourceId: string;
  readonly sourceR2Key: string;
  readonly sourceSha256: string;
  readonly judgeR2Key: string;
  readonly executionSemanticSha256: string;
  readonly problemVersionId: string;
  readonly expectedReleaseId: string;
  readonly expectedManifestSha256: string;
  readonly expectedContainerIdentitySha256: string;
  readonly contestId?: string;
  readonly rejudge?: {
    readonly jobId: string;
    readonly batchId: string;
    readonly originSubmissionId: string;
    readonly oldSubmissionId: string;
    readonly oldProblemVersionId: string;
  };
}

interface StoredSubmissionWorkflowRow {
  readonly user_id: string;
  readonly problem_version_id: string;
  readonly contest_id: string | null;
  readonly source_id: string;
  readonly content_sha256: string;
  readonly execution_semantic_sha256: string;
  readonly wasm_oj_release_id: string;
  readonly wasm_oj_manifest_sha256: string;
  readonly token_hash: string;
}

export const HYDRATE_SUBMISSION_WORKFLOW_SQL = `SELECT
    submissions.user_id, submissions.problem_version_id, submissions.contest_id,
    submissions.source_id, sources.content_sha256,
    submissions.execution_semantic_sha256, submissions.wasm_oj_release_id,
    submissions.wasm_oj_manifest_sha256, attempts.token_hash
  FROM submissions
  JOIN submission_sources AS sources ON sources.id=submissions.source_id AND sources.state='ready'
  JOIN submission_attempts AS attempts ON attempts.submission_id=submissions.id AND attempts.attempt=?
  JOIN problem_version_details AS versions
    ON versions.id=submissions.problem_version_id
   AND versions.execution_semantic_sha256=submissions.execution_semantic_sha256
  JOIN judge_packages AS packages
    ON packages.sha256=submissions.execution_semantic_sha256 AND packages.state='ready'
  WHERE submissions.id=?
    AND submissions.state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')
    AND EXISTS (SELECT 1 FROM users WHERE users.id=submissions.user_id AND users.status='active')
    AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=submissions.user_id)`;

export async function hydrateSubmissionWorkflow(env: WasmOjWorkerEnv, opaque: unknown): Promise<HydratedSubmissionWorkflow> {
  const parameters = parseSubmissionWorkflowParameters(opaque);
  const stored = await env.DB.prepare(HYDRATE_SUBMISSION_WORKFLOW_SQL)
    .bind(parameters.attempt, parameters.submissionId).first<StoredSubmissionWorkflowRow>();
  if (!stored || stored.wasm_oj_release_id !== parameters.expectedReleaseId || stored.wasm_oj_manifest_sha256 !== parameters.expectedManifestSha256) {
    throw new Error("Submission Workflow reference does not match its immutable submission row.");
  }
  const attemptToken = await assertSubmissionAttemptTokenHash(
    env.ACCOUNT_ERASURE_HMAC_SECRET,
    parameters.submissionId,
    parameters.attempt,
    stored.token_hash,
  );
  const active = await assertActiveRelease(
    env.DB,
    env.ENVIRONMENT,
    parameters.expectedReleaseId,
    parameters.expectedManifestSha256,
  );
  const rejudge = await env.DB.prepare(`SELECT id, rejudge_batch_id, origin_submission_id,
      old_submission_id, old_problem_version_id
      FROM rejudge_jobs
     WHERE new_submission_id=? AND state IN ('dispatched','ready')`)
    .bind(parameters.submissionId).first<{
      readonly id: string;
      readonly rejudge_batch_id: string;
      readonly origin_submission_id: string;
      readonly old_submission_id: string;
      readonly old_problem_version_id: string;
    }>();
  return {
    ...parameters,
    userId: stored.user_id,
    attemptToken,
    sourceId: stored.source_id,
    sourceR2Key: `submission-sources/v2/${stored.source_id}`,
    sourceSha256: stored.content_sha256,
    judgeR2Key: `judge-packages/v2/${stored.execution_semantic_sha256}`,
    executionSemanticSha256: stored.execution_semantic_sha256,
    problemVersionId: stored.problem_version_id,
    expectedContainerIdentitySha256: active.manifest.artifacts.containerImage.identitySha256,
    ...(stored.contest_id ? { contestId: stored.contest_id } : {}),
    ...(rejudge ? {
      rejudge: {
        jobId: rejudge.id,
        batchId: rejudge.rejudge_batch_id,
        originSubmissionId: rejudge.origin_submission_id,
        oldSubmissionId: rejudge.old_submission_id,
        oldProblemVersionId: rejudge.old_problem_version_id,
      },
    } : {}),
  };
}
