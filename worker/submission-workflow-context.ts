import type { ForgeWorkerEnv } from "./env";
import { assertActiveRelease } from "./release";
import {
  assertSubmissionAttemptTokenHash,
  parseSubmissionWorkflowParameters,
} from "./submission-workflow-identity";

export interface HydratedSubmissionWorkflow {
  readonly submissionId: string;
  readonly userId: string;
  readonly attempt: number;
  readonly attemptToken: string;
  readonly sourceOwnerId: string;
  readonly sourceR2Key: string;
  readonly sourceSha256: string;
  readonly judgeR2Key: string;
  readonly judgeSha256: string;
  readonly managedProblemVersionId: string;
  readonly expectedReleaseId: string;
  readonly expectedManifestSha256: string;
  readonly expectedContainerIdentitySha256: string;
  readonly expectedProblemBundleDigest: string;
  readonly contestId?: string;
  readonly rejudge?: {
    readonly batchId: string;
    readonly oldSubmissionId: string;
    readonly oldProblemVersionId: string;
  };
}

interface StoredSubmissionWorkflowRow {
  readonly user_id: string;
  readonly managed_problem_version_id: string;
  readonly contest_id: string | null;
  readonly source_r2_key: string;
  readonly source_digest: string;
  readonly forge_release_id: string;
  readonly forge_manifest_sha256: string;
  readonly rejudge_batch_id: string | null;
  readonly rejudge_of_submission_id: string | null;
  readonly token_hash: string;
}

interface StoredManagedProblemRow {
  readonly judge_projection_r2_key: string;
  readonly bundle_digest: string;
  readonly snapshot_status: string;
}

export const HYDRATE_SUBMISSION_WORKFLOW_SQL = `SELECT
    submissions.user_id, submissions.managed_problem_version_id, submissions.contest_id,
    submissions.source_r2_key, submissions.source_digest, submissions.forge_release_id,
    submissions.forge_manifest_sha256, submissions.rejudge_batch_id,
    submissions.rejudge_of_submission_id, submission_attempts.token_hash
  FROM submissions
  JOIN submission_attempts ON submission_attempts.submission_id=submissions.id AND submission_attempts.attempt=?
  WHERE submissions.id=?
    AND submissions.state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')
    AND submissions.source_erased_at IS NULL
    AND EXISTS (SELECT 1 FROM users WHERE users.id=submissions.user_id AND users.status='active')
    AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=submissions.user_id)`;

function digestAddressedKey(key: string, label: string): string {
  const digest = /(?:^|\/)([0-9a-f]{64})$/.exec(key)?.[1];
  if (!digest) throw new Error(`${label} is not content addressed.`);
  return digest;
}

function sourceOwnerFromKey(key: string, digest: string): string {
  const match = /^sources\/([^/]{1,128})\/[0-9a-f-]{36}\.([0-9a-f]{64})\.json$/.exec(key);
  if (!match?.[1] || match[2] !== digest) throw new Error("Submission source key is not bound to its durable digest.");
  return match[1];
}

/**
 * Resolve all sensitive judge inputs from authoritative storage. This query is
 * intentionally outside a Workflow step: step return values are durable
 * Workflow state, and must never persist source locations, owner identity, or
 * an attempt capability in the Workflow service.
 */
export async function hydrateSubmissionWorkflow(
  env: ForgeWorkerEnv,
  opaque: unknown,
): Promise<HydratedSubmissionWorkflow> {
  const parameters = parseSubmissionWorkflowParameters(opaque);
  const stored = await env.DB.prepare(HYDRATE_SUBMISSION_WORKFLOW_SQL)
    .bind(parameters.attempt, parameters.submissionId).first<StoredSubmissionWorkflowRow>();
  if (
    !stored
    || stored.forge_release_id !== parameters.expectedReleaseId
    || stored.forge_manifest_sha256 !== parameters.expectedManifestSha256
  ) throw new Error("Submission Workflow reference does not match its immutable submission row.");
  const attemptToken = await assertSubmissionAttemptTokenHash(
    env.ACCOUNT_ERASURE_HMAC_SECRET,
    parameters.submissionId,
    parameters.attempt,
    stored.token_hash,
  );
  const active = await assertActiveRelease(
    env.DB,
    env.JUDGE_BUCKET,
    env.ENVIRONMENT,
    parameters.expectedReleaseId,
    parameters.expectedManifestSha256,
  );
  const problem = await env.DB.prepare(`SELECT
      managed_problem_versions.judge_projection_r2_key,
      managed_problem_versions.bundle_digest,
      managed_snapshots.status AS snapshot_status
    FROM managed_problem_versions
    JOIN managed_snapshots ON managed_snapshots.id=managed_problem_versions.snapshot_id
    WHERE managed_problem_versions.id=?`)
    .bind(stored.managed_problem_version_id).first<StoredManagedProblemRow>();
  if (!problem || !["published", "superseded"].includes(problem.snapshot_status)) {
    throw new Error("Submission Workflow managed problem is not an immutable published problem.");
  }

  let rejudge: HydratedSubmissionWorkflow["rejudge"];
  if (stored.rejudge_batch_id !== null || stored.rejudge_of_submission_id !== null) {
    if (!stored.rejudge_batch_id || !stored.rejudge_of_submission_id) throw new Error("Rejudge submission identity is incomplete.");
    const job = await env.DB.prepare(
      "SELECT old_problem_version_id, state FROM rejudge_jobs WHERE rejudge_batch_id=? AND old_submission_id=? AND new_submission_id=?",
    ).bind(stored.rejudge_batch_id, stored.rejudge_of_submission_id, parameters.submissionId).first<{
      readonly old_problem_version_id: string;
      readonly state: string;
    }>();
    if (!job || !["dispatched", "ready"].includes(job.state)) throw new Error("Rejudge Workflow has no dispatched durable job.");
    rejudge = {
      batchId: stored.rejudge_batch_id,
      oldSubmissionId: stored.rejudge_of_submission_id,
      oldProblemVersionId: job.old_problem_version_id,
    };
  }

  return {
    ...parameters,
    userId: stored.user_id,
    attemptToken,
    sourceOwnerId: sourceOwnerFromKey(stored.source_r2_key, stored.source_digest),
    sourceR2Key: stored.source_r2_key,
    sourceSha256: stored.source_digest,
    judgeR2Key: problem.judge_projection_r2_key,
    judgeSha256: digestAddressedKey(problem.judge_projection_r2_key, "Judge projection"),
    managedProblemVersionId: stored.managed_problem_version_id,
    expectedContainerIdentitySha256: active.manifest.artifacts.containerImage.identitySha256,
    expectedProblemBundleDigest: problem.bundle_digest,
    ...(stored.contest_id ? { contestId: stored.contest_id } : {}),
    ...(rejudge ? { rejudge } : {}),
  };
}
