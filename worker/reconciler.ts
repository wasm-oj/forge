import type { ForgeWorkerEnv } from "./env";
import { resumeAccountErasure } from "./account-erasure";
import { deliverRejudgeResults, dispatchRejudgeJobs, materializeRejudgeBatch, refreshRejudgeBatches } from "./rejudge";
import { assertActiveRelease } from "./release";
import { releaseImportObjectClaims } from "./canonical-object-claims";
import { operationalLog } from "./structured-log";
import { cleanupExpiredGithubInstallationClaims } from "./github-installation-claims";
import { formalSubmissionWorkflowFence, reconcileFormalSubmissionAdmissions } from "./formal-admissions";
import { deleteMirroredAttemptAudit } from "./submission-audits";
import {
  parseSubmissionWorkflowParameters,
  type SubmissionWorkflowParameters,
} from "./submission-workflow-identity";
import { formalMutationStatus } from "./formal-mutations";
import { cleanupExpiredFormalRiskAllowances } from "./formal-access";
import type { ValidationWorkflowParameters } from "./validation-contract";
import {
  archiveCleanupOutboxJson,
  deliverValidationWorkflowOutbox,
  parseArchiveCleanupOutboxJson,
  validationWorkflowOutboxJson,
} from "./validation-workflow-outbox";
import { prepareSubmissionEventInsert } from "./submission-events";

interface OutboxRow {
  readonly id: string;
  readonly submission_id: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly attempts: number;
}

interface CoreOutboxRow {
  readonly id: string;
  readonly kind: string;
  readonly aggregate_id: string;
  readonly payload_json: string;
  readonly attempts: number;
}

export const START_WORKFLOW_ELIGIBILITY_SQL = `SELECT submissions.user_id, submission_attempts.token_hash
  FROM submissions
  JOIN submission_attempts ON submission_attempts.submission_id=submissions.id AND submission_attempts.attempt=?
  WHERE submissions.id=?
    AND submissions.state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')
    AND submissions.source_erased_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM submission_owner_erasure_fences
      WHERE submission_owner_erasure_fences.owner_user_id=submissions.user_id
    )`;

interface CompletedSubmission {
  readonly id: string;
  readonly user_id: string;
  readonly managed_problem_version_id: string;
  readonly contest_id: string | null;
  readonly state: string;
  readonly score: number | null;
  readonly fully_passed_cases: number | null;
  readonly deterministic_cost: number | null;
  readonly peak_memory_bytes: number | null;
  readonly effective_attempt: number | null;
  readonly completed_at: string | null;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function submissionWorkflowPayload(value: unknown): SubmissionWorkflowParameters {
  return parseSubmissionWorkflowParameters(value);
}

async function cleanupImportArchive(env: ForgeWorkerEnv, importId: string): Promise<void> {
  const row = await env.CORE_DB.prepare("SELECT archive_r2_key FROM collection_imports WHERE id=? AND archive_r2_key IS NOT NULL AND archive_disposition='pending'")
    .bind(importId).first<{ readonly archive_r2_key: string }>();
  if (!row) {
    const alreadyDeleted = await env.CORE_DB.prepare("SELECT 1 AS valid FROM collection_imports WHERE id=? AND archive_r2_key IS NULL AND archive_disposition='deleted'")
      .bind(importId).first<{ valid: number }>();
    if (alreadyDeleted) return;
    throw new Error("Archive cleanup lost its import fence.");
  }
  if (!new RegExp(`^imports/${importId}/[0-9a-f]{40}\\.tar\\.gz$`).test(row.archive_r2_key)) {
    throw new Error("Archive cleanup database key is not bound to its import.");
  }
  await Promise.all([env.JUDGE_BUCKET.delete(row.archive_r2_key), env.JUDGE_MIRROR_BUCKET.delete(row.archive_r2_key)]);
  const [primary, mirror] = await Promise.all([env.JUDGE_BUCKET.head(row.archive_r2_key), env.JUDGE_MIRROR_BUCKET.head(row.archive_r2_key)]);
  if (primary || mirror) throw new Error("Archive cleanup read-back still found an object.");
  const updated = await env.CORE_DB.prepare("UPDATE collection_imports SET archive_r2_key=NULL, archive_disposition='deleted', archive_delete_after=NULL, updated_at=? WHERE id=? AND archive_r2_key=? AND archive_disposition='pending'")
    .bind(new Date().toISOString(), importId, row.archive_r2_key).run();
  if (updated.meta.changes !== 1) throw new Error("Archive cleanup lost its final database fence.");
}

async function markSubmissionOutbox(env: ForgeWorkerEnv, row: OutboxRow, error?: unknown): Promise<void> {
  if (!error) {
    await env.SUBMISSIONS_DB.prepare("UPDATE submission_outbox SET delivered_at=?, attempts=attempts+1, last_error=NULL, payload_json='{}' WHERE id=?")
      .bind(new Date().toISOString(), row.id).run();
    return;
  }
  await env.SUBMISSIONS_DB.prepare("UPDATE submission_outbox SET attempts=attempts+1, last_error=? WHERE id=?")
    .bind(row.kind === "start-workflow" ? "workflow-delivery-failed" : "profile-delivery-failed", row.id).run();
}

async function startSubmissionWorkflow(env: ForgeWorkerEnv, row: OutboxRow, payload: SubmissionWorkflowParameters): Promise<void> {
  if (payload.submissionId !== row.submission_id) throw new Error("Submission Workflow outbox identity is invalid.");
  const durable = await env.SUBMISSIONS_DB.prepare(START_WORKFLOW_ELIGIBILITY_SQL)
    .bind(payload.attempt, payload.submissionId).first<{ readonly user_id: string; readonly token_hash: string }>();
  if (!durable) {
    const workflow = await env.SUBMISSION_WORKFLOW.get(row.submission_id);
    const status = await workflow.status();
    if (["complete", "errored", "terminated"].includes(status.status)) return;
    if (status.status !== "unknown") await workflow.terminate();
    throw new Error("Submission Workflow initialization fence is closed.");
  }
  const beforeCreate = await env.SUBMISSIONS_DB.prepare(START_WORKFLOW_ELIGIBILITY_SQL)
    .bind(payload.attempt, payload.submissionId).first<{ readonly user_id: string; readonly token_hash: string }>();
  if (!beforeCreate || beforeCreate.user_id !== durable.user_id || beforeCreate.token_hash !== durable.token_hash) {
    throw new Error("Submission Workflow initialization fence closed before create.");
  }
  try {
    await env.SUBMISSION_WORKFLOW.create({ id: row.submission_id, params: payload });
  } catch (error) {
    const status = await (await env.SUBMISSION_WORKFLOW.get(row.submission_id)).status();
    if (status.status === "unknown") throw error;
  }
  const afterCreate = await env.SUBMISSIONS_DB.prepare(START_WORKFLOW_ELIGIBILITY_SQL)
    .bind(payload.attempt, payload.submissionId).first<{ readonly user_id: string; readonly token_hash: string }>();
  if (!afterCreate || afterCreate.user_id !== durable.user_id || afterCreate.token_hash !== durable.token_hash) {
    const workflow = await env.SUBMISSION_WORKFLOW.get(row.submission_id);
    await workflow.terminate();
    throw new Error("Submission Workflow initialization fence closed during create.");
  }
}

async function exhaustSubmissionWorkflowStart(
  env: ForgeWorkerEnv,
  row: OutboxRow,
): Promise<void> {
  const now = new Date().toISOString();
  await env.SUBMISSIONS_DB.batch([
    env.SUBMISSIONS_DB.prepare("UPDATE submissions SET state='infrastructure-error', score=0, fully_passed_cases=0, updated_at=?, completed_at=? WHERE id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')")
      .bind(now, now, row.submission_id),
    env.SUBMISSIONS_DB.prepare("UPDATE submission_attempts SET state='failed', finished_at=?, failure_code='workflow-delivery-exhausted' WHERE submission_id=? AND state IN ('created','running') AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='infrastructure-error')")
      .bind(now, row.submission_id, row.submission_id),
    prepareSubmissionEventInsert(env.SUBMISSIONS_DB, {
      submissionId: row.submission_id,
      eventKey: "workflow-delivery-exhausted",
      event: { kind: "state", state: "infrastructure-error" },
      timestamp: now,
      requiredState: "infrastructure-error",
    }),
  ]);
  const submission = await env.SUBMISSIONS_DB.prepare("SELECT state FROM submissions WHERE id=?")
    .bind(row.submission_id).first<{ readonly state: string }>();
  if (!submission || !["infrastructure-error", "cancelled", "completed", "compile-error", "judge-error"].includes(submission.state)) {
    throw new Error("Exhausted Workflow delivery lost its terminal-state fence.");
  }
  await env.SUBMISSIONS_DB.prepare("UPDATE submission_outbox SET delivered_at=?, attempts=attempts+1, last_error='workflow-delivery-exhausted', payload_json='{}' WHERE id=? AND delivered_at IS NULL")
    .bind(now, row.id).run();
}

async function workflowStartFence(
  env: ForgeWorkerEnv,
  row: OutboxRow,
): Promise<"start" | "wait" | "reject"> {
  const submission = await env.SUBMISSIONS_DB.prepare("SELECT rejudge_batch_id FROM submissions WHERE id=?")
    .bind(row.submission_id).first<{ readonly rejudge_batch_id: string | null }>();
  if (!submission) return "reject";
  if (submission.rejudge_batch_id) return "start";
  return formalSubmissionWorkflowFence(env, row.submission_id);
}

async function rejectUncommittedWorkflowStart(env: ForgeWorkerEnv, row: OutboxRow): Promise<void> {
  const submission = await env.SUBMISSIONS_DB.prepare("SELECT user_id, source_r2_key FROM submissions WHERE id=? AND rejudge_batch_id IS NULL")
    .bind(row.submission_id).first<{ user_id: string; source_r2_key: string }>();
  if (!submission) throw new Error("Rejected workflow source is missing.");
  const now = new Date().toISOString();
  await env.SUBMISSIONS_DB.batch([
    env.SUBMISSIONS_DB.prepare("UPDATE submissions SET state='cancelled', updated_at=?, completed_at=COALESCE(completed_at, ?) WHERE id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')")
      .bind(now, now, row.submission_id),
    env.SUBMISSIONS_DB.prepare("UPDATE submission_attempts SET state='cancelled', finished_at=COALESCE(finished_at, ?) WHERE submission_id=? AND state IN ('created','running')")
      .bind(now, row.submission_id),
    prepareSubmissionEventInsert(env.SUBMISSIONS_DB, {
      submissionId: row.submission_id,
      eventKey: "workflow-start-fence-cancelled",
      event: { kind: "state", state: "cancelled" },
      timestamp: now,
      requiredState: "cancelled",
    }),
  ]);
  await Promise.all([
    env.JUDGE_BUCKET.delete(submission.source_r2_key),
    env.JUDGE_MIRROR_BUCKET.delete(submission.source_r2_key),
  ]);
  const [primary, mirror] = await Promise.all([
    env.JUDGE_BUCKET.head(submission.source_r2_key),
    env.JUDGE_MIRROR_BUCKET.head(submission.source_r2_key),
  ]);
  if (primary || mirror) throw new Error("Rejected workflow source deletion postcondition failed.");
  await env.SUBMISSIONS_DB.prepare("UPDATE submission_outbox SET delivered_at=?, attempts=attempts+1, last_error='source-set-fence-lost', payload_json='{}' WHERE id=? AND delivered_at IS NULL")
    .bind(now, row.id).run();
}

async function completedSubmission(env: ForgeWorkerEnv, submissionId: string): Promise<CompletedSubmission> {
  const row = await env.SUBMISSIONS_DB.prepare("SELECT id, user_id, managed_problem_version_id, contest_id, state, score, fully_passed_cases, deterministic_cost, peak_memory_bytes, effective_attempt, completed_at FROM submissions WHERE id=?")
    .bind(submissionId).first<CompletedSubmission>();
  if (!row) throw new Error("Submission result does not exist.");
  if (row.state !== "completed") return row;
  if (!row.completed_at || row.effective_attempt === null || row.score === null || row.fully_passed_cases === null || row.deterministic_cost === null || row.peak_memory_bytes === null) {
    throw new Error("Submission result is not ready for projection.");
  }
  const attempt = await env.SUBMISSIONS_DB.prepare("SELECT 1 AS valid FROM submission_attempts WHERE submission_id=? AND attempt=? AND state='succeeded'")
    .bind(submissionId, row.effective_attempt).first<{ valid: number }>();
  if (!attempt) throw new Error("Submission effective attempt is not finalized.");
  return row;
}

async function projectSubmission(env: ForgeWorkerEnv, row: OutboxRow): Promise<void> {
  const submission = await completedSubmission(env, row.submission_id);
  if (submission.state !== "completed") return;
  if (row.kind === "update-profile") {
    if (submission.state === "completed" && submission.score === 100) {
      await env.CORE_DB.prepare(
        "INSERT INTO verified_solves (user_id, managed_problem_version_id, effective_submission_id, score, solved_at) SELECT ?, ?, ?, 100, ? WHERE EXISTS (SELECT 1 FROM users WHERE id=? AND status='active') AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=?) ON CONFLICT(user_id, managed_problem_version_id) DO UPDATE SET effective_submission_id=CASE WHEN excluded.solved_at < solved_at THEN excluded.effective_submission_id ELSE effective_submission_id END, solved_at=MIN(solved_at, excluded.solved_at), score=100",
      ).bind(submission.user_id, submission.managed_problem_version_id, submission.id, submission.completed_at, submission.user_id, submission.user_id).run();
    }
    return;
  }
  throw new Error(`Unknown submission outbox kind '${row.kind}'.`);
}

async function processSubmissionOutboxRow(env: ForgeWorkerEnv, row: OutboxRow): Promise<void> {
  try {
    if (row.kind === "start-workflow") {
      if (row.attempts >= 20) {
        await exhaustSubmissionWorkflowStart(env, row);
        return;
      }
      const payload = submissionWorkflowPayload(JSON.parse(row.payload_json) as unknown);
      const fence = await workflowStartFence(env, row);
      if (fence === "wait") return;
      if (fence === "reject") {
        await rejectUncommittedWorkflowStart(env, row);
        return;
      }
      await startSubmissionWorkflow(env, row, payload);
    } else await projectSubmission(env, row);
    await markSubmissionOutbox(env, row);
  } catch (error) {
    await markSubmissionOutbox(env, row, error);
  }
}

async function reconcileSubmissionOutbox(env: ForgeWorkerEnv): Promise<number> {
  const pending = await env.SUBMISSIONS_DB.prepare("SELECT id, submission_id, kind, payload_json, attempts FROM submission_outbox WHERE delivered_at IS NULL ORDER BY CASE WHEN attempts < 20 THEN 0 ELSE 1 END, attempts, created_at LIMIT 25")
    .all<OutboxRow>();
  for (const row of pending.results) await processSubmissionOutboxRow(env, row);
  return pending.results.length;
}

export async function reconcileUncommittedAttemptAudits(env: ForgeWorkerEnv): Promise<number> {
  const rows = await env.SUBMISSIONS_DB.prepare(
    "SELECT submission_id, attempt, audit_r2_key FROM submission_attempts WHERE audit_r2_key IS NOT NULL AND state IN ('failed','superseded','cancelled') ORDER BY finished_at, submission_id, attempt LIMIT 25",
  ).all<{ readonly submission_id: string; readonly attempt: number; readonly audit_r2_key: string }>();
  let cleaned = 0;
  for (const row of rows.results) {
    try {
      await deleteMirroredAttemptAudit(env, {
        submissionId: row.submission_id,
        attempt: row.attempt,
        auditR2Key: row.audit_r2_key,
      });
      const cleared = await env.SUBMISSIONS_DB.prepare(
        "UPDATE submission_attempts SET audit_r2_key=NULL WHERE submission_id=? AND attempt=? AND audit_r2_key=? AND state IN ('failed','superseded','cancelled')",
      ).bind(row.submission_id, row.attempt, row.audit_r2_key).run();
      if (cleared.meta.changes !== 1) {
        const current = await env.SUBMISSIONS_DB.prepare("SELECT state, audit_r2_key FROM submission_attempts WHERE submission_id=? AND attempt=?")
          .bind(row.submission_id, row.attempt).first<{ readonly state: string; readonly audit_r2_key: string | null }>();
        if (!current || current.audit_r2_key !== null) throw new Error("Submission audit cleanup lost its durable attempt fence.");
      }
      cleaned += 1;
    } catch {
      operationalLog("warn", {
        event: "reconciler.delivery-failed",
        outcome: "deferred",
        code: "submission-audit-cleanup",
        aggregateType: "submission",
        aggregateId: row.submission_id,
      });
    }
  }
  return cleaned;
}

async function reconcileTerminalWorkflowFailures(env: ForgeWorkerEnv): Promise<number> {
  const rows = await env.SUBMISSIONS_DB.prepare(
    `SELECT submissions.id, submissions.updated_at
       FROM submissions
       JOIN submission_outbox ON submission_outbox.submission_id=submissions.id
        AND submission_outbox.kind='start-workflow'
        AND submission_outbox.delivered_at IS NOT NULL
      WHERE submissions.rejudge_batch_id IS NULL
        AND submissions.state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')
      ORDER BY submissions.updated_at, submissions.id
      LIMIT 25`,
  ).all<{ readonly id: string; readonly updated_at: string }>();
  let repaired = 0;
  const unknownCutoff = Date.now() - 10 * 60 * 1_000;
  for (const row of rows.results) {
    try {
      const workflow = await env.SUBMISSION_WORKFLOW.get(row.id);
      const status = await workflow.status();
      if (!["complete", "errored", "terminated", "unknown"].includes(status.status)) continue;
      if (status.status === "unknown" && Date.parse(row.updated_at) > unknownCutoff) continue;
      const now = new Date().toISOString();
      const [submission] = await env.SUBMISSIONS_DB.batch([
        env.SUBMISSIONS_DB.prepare("UPDATE submissions SET state='infrastructure-error', score=0, fully_passed_cases=0, updated_at=?, completed_at=? WHERE id=? AND rejudge_batch_id IS NULL AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')")
          .bind(now, now, row.id),
        env.SUBMISSIONS_DB.prepare("UPDATE submission_attempts SET state='failed', finished_at=COALESCE(finished_at, ?), failure_code=COALESCE(failure_code, 'workflow-terminal-without-result') WHERE submission_id=? AND state IN ('created','running') AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='infrastructure-error')")
          .bind(now, row.id, row.id),
        prepareSubmissionEventInsert(env.SUBMISSIONS_DB, {
          submissionId: row.id,
          eventKey: "workflow-terminal-without-result",
          event: { kind: "state", state: "infrastructure-error" },
          timestamp: now,
          requiredState: "infrastructure-error",
        }),
      ]);
      if (submission.meta.changes !== 1) continue;
      repaired += 1;
    } catch {
      operationalLog("warn", {
        event: "reconciler.delivery-failed",
        outcome: "deferred",
        code: "submission-workflow-terminal-repair",
        aggregateType: "submission",
        aggregateId: row.id,
      });
    }
  }
  return repaired;
}

/**
 * Reconcile exactly one durable production outbox row. The staging acceptance
 * control uses this narrow entry point to prove lost-ack recovery without
 * sweeping or fabricating a second outbox implementation.
 */
export async function reconcileSubmissionOutboxById(env: ForgeWorkerEnv, outboxId: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(outboxId)) throw new TypeError("Submission outbox ID is invalid.");
  const row = await env.SUBMISSIONS_DB.prepare("SELECT id, submission_id, kind, payload_json, attempts FROM submission_outbox WHERE id=? AND delivered_at IS NULL")
    .bind(outboxId).first<OutboxRow>();
  if (!row) return false;
  await processSubmissionOutboxRow(env, row);
  return true;
}

async function reconcileCoreOutbox(env: ForgeWorkerEnv): Promise<number> {
  const pending = await env.CORE_DB.prepare("SELECT id, kind, aggregate_id, payload_json, attempts FROM core_outbox WHERE delivered_at IS NULL AND kind IN ('start-validation-workflow','materialize-rejudge','cleanup-import-archive') ORDER BY CASE WHEN attempts < 20 THEN 0 ELSE 1 END, attempts, created_at LIMIT 10")
    .all<CoreOutboxRow>();
  for (const row of pending.results) {
    try {
      let delivered = true;
      if (row.kind === "start-validation-workflow") {
        if (row.attempts >= 20) {
          const now = new Date().toISOString();
          const [terminalized, outbox] = await env.CORE_DB.batch([
            env.CORE_DB.prepare("UPDATE collection_imports SET status='infrastructure-error', error_code='validation-workflow-delivery-exhausted', archive_disposition='deleted', archive_delete_after=NULL, updated_at=? WHERE id=? AND status='queued' AND archive_r2_key IS NULL")
              .bind(now, row.aggregate_id),
            env.CORE_DB.prepare("UPDATE core_outbox SET delivered_at=?, attempts=attempts+1, last_error='validation-workflow-delivery-exhausted', payload_json='{}' WHERE id=? AND delivered_at IS NULL AND EXISTS (SELECT 1 FROM collection_imports WHERE id=? AND status IN ('valid','invalid','infrastructure-error'))")
              .bind(now, row.id, row.aggregate_id),
          ]);
          if (outbox?.meta.changes !== 1) throw new Error("Validation Workflow exhaustion lost its terminal import fence.");
          if (terminalized?.meta.changes === 1) await releaseImportObjectClaims(env, row.aggregate_id, new Date(now));
          continue;
        }
        await deliverValidationWorkflowOutbox(env, row.aggregate_id, row.payload_json);
      } else if (row.kind === "materialize-rejudge") {
        const payload = object(JSON.parse(row.payload_json) as unknown, "Rejudge materialization payload");
        if (Object.keys(payload).length !== 1 || payload.batchId !== row.aggregate_id) throw new Error("Rejudge materialization payload is invalid.");
        delivered = await materializeRejudgeBatch(env, row.aggregate_id);
      } else {
        const payload = parseArchiveCleanupOutboxJson(row.payload_json, row.aggregate_id);
        await cleanupImportArchive(env, payload.importId);
      }
      if (delivered) await env.CORE_DB.prepare("UPDATE core_outbox SET delivered_at=?, attempts=attempts+1, last_error=NULL, payload_json='{}' WHERE id=?")
        .bind(new Date().toISOString(), row.id).run();
    } catch {
      const exhausted = row.kind === "materialize-rejudge" && row.attempts + 1 >= 20;
      await env.CORE_DB.batch([
        env.CORE_DB.prepare("UPDATE core_outbox SET attempts=attempts+1, last_error=?, delivered_at=CASE WHEN ?=1 THEN ? ELSE delivered_at END, payload_json=CASE WHEN ?=1 THEN '{}' ELSE payload_json END WHERE id=?")
          .bind(row.kind === "materialize-rejudge" ? "rejudge-materialization-failed" : row.kind === "cleanup-import-archive" ? "archive-cleanup-failed" : "validation-workflow-delivery-failed", exhausted ? 1 : 0, new Date().toISOString(), exhausted ? 1 : 0, row.id),
        env.CORE_DB.prepare("UPDATE rejudge_batches SET cancel_requested_at=COALESCE(cancel_requested_at, ?), failure_code='rejudge-materialization-failed', updated_at=? WHERE id=? AND ?=1 AND status IN ('queued','running','ready')")
          .bind(new Date().toISOString(), new Date().toISOString(), row.aggregate_id, exhausted && row.kind === "materialize-rejudge" ? 1 : 0),
      ]);
    }
  }
  return pending.results.length;
}

async function synchronizeContestFreeze(env: ForgeWorkerEnv): Promise<void> {
  const now = new Date().toISOString();
  let formalAdmissionOpen = false;
  try { formalAdmissionOpen = (await formalMutationStatus(env)).enabled; } catch { /* Starting a contest fails closed. */ }
  await env.CORE_DB.prepare("UPDATE contests SET status=CASE WHEN ends_at <= ? THEN 'ended' WHEN starts_at <= ? AND ?=1 THEN 'running' ELSE status END, updated_at=? WHERE status IN ('published', 'running')")
    .bind(now, now, formalAdmissionOpen ? 1 : 0, now).run();
}

async function reconcileAccountErasures(env: ForgeWorkerEnv): Promise<number> {
  const pending = await env.CORE_DB.prepare("SELECT id FROM account_erasure_jobs WHERE status NOT IN ('completed','failed') ORDER BY requested_at LIMIT 5")
    .all<{ id: string }>();
  for (const job of pending.results) {
    try { await resumeAccountErasure(env, job.id); } catch { /* Stable retry state is persisted by the erasure worker. */ }
  }
  return pending.results.length;
}

interface CanonicalSuccessorCandidate {
  readonly predecessor_import_id: string;
  readonly organizer_user_id: string;
  readonly github_repository_id: number;
  readonly requested_ref: string;
  readonly commit_sha: string;
  readonly index_path: string;
  readonly canonical_source_r2_key: string;
  readonly canonical_source_mirror_r2_key: string;
  readonly canonical_source_sha256: string;
}

async function queueCanonicalSuccessors(env: ForgeWorkerEnv): Promise<number> {
  try {
    if (!(await formalMutationStatus(env)).enabled) return 0;
  } catch { return 0; }
  let active: Awaited<ReturnType<typeof assertActiveRelease>>;
  try {
    active = await assertActiveRelease(env.CORE_DB, env.JUDGE_BUCKET, env.ENVIRONMENT, env.FORGE_RELEASE_ID, env.FORGE_RELEASE_MANIFEST_SHA256);
  } catch {
    // Successor admission fails closed, but release drift must not prevent
    // unrelated durable outbox and retention reconciliation in this tick.
    return 0;
  }
  const candidates = await env.CORE_DB.prepare(
    "SELECT collection_imports.id AS predecessor_import_id, collection_imports.organizer_user_id, collection_imports.github_repository_id, collection_imports.requested_ref, collection_imports.commit_sha, collection_imports.index_path, collection_imports.canonical_source_r2_key, collection_imports.canonical_source_mirror_r2_key, collection_imports.canonical_source_sha256 FROM collection_imports JOIN managed_snapshots ON managed_snapshots.import_id=collection_imports.id AND managed_snapshots.mode='official-practice' AND managed_snapshots.status='published' WHERE collection_imports.status='valid' AND collection_imports.forge_release_id<>? AND collection_imports.canonical_source_r2_key IS NOT NULL AND collection_imports.canonical_source_mirror_r2_key=collection_imports.canonical_source_r2_key AND collection_imports.canonical_source_sha256 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM collection_imports successor WHERE successor.predecessor_import_id=collection_imports.id AND successor.forge_release_id=?) ORDER BY managed_snapshots.published_at, collection_imports.id LIMIT 5",
  ).bind(env.FORGE_RELEASE_ID, env.FORGE_RELEASE_ID).all<CanonicalSuccessorCandidate>();
  let queued = 0;
  for (const candidate of candidates.results) {
    const importId = crypto.randomUUID();
    const now = new Date().toISOString();
    const parameters: ValidationWorkflowParameters = {
      importId,
      expectedReleaseId: env.FORGE_RELEASE_ID,
      expectedManifestSha256: env.FORGE_RELEASE_MANIFEST_SHA256,
      expectedContainerIdentitySha256: active.manifest.artifacts.containerImage.identitySha256,
    };
    const workflowPayloadJson = validationWorkflowOutboxJson(parameters);
    const [inserted] = await env.CORE_DB.batch([
      env.CORE_DB.prepare("INSERT INTO collection_imports (id, organizer_user_id, github_repository_id, requested_ref, commit_sha, index_path, forge_release_id, canonical_source_r2_key, canonical_source_mirror_r2_key, canonical_source_sha256, archive_disposition, source_kind, predecessor_import_id, status, created_at, updated_at) SELECT ?, organizer_user_id, github_repository_id, requested_ref, commit_sha, index_path, ?, canonical_source_r2_key, canonical_source_mirror_r2_key, canonical_source_sha256, 'deleted', 'canonical-successor', id, 'queued', ?, ? FROM collection_imports WHERE id=? AND status='valid' AND forge_release_id<>? AND canonical_source_r2_key=? AND canonical_source_mirror_r2_key=? AND canonical_source_sha256=? AND EXISTS (SELECT 1 FROM managed_snapshots WHERE import_id=collection_imports.id AND mode='official-practice' AND status='published') AND NOT EXISTS (SELECT 1 FROM collection_imports existing WHERE existing.predecessor_import_id=collection_imports.id AND existing.forge_release_id=?)")
        .bind(importId, env.FORGE_RELEASE_ID, now, now, candidate.predecessor_import_id, env.FORGE_RELEASE_ID, candidate.canonical_source_r2_key, candidate.canonical_source_mirror_r2_key, candidate.canonical_source_sha256, env.FORGE_RELEASE_ID),
      env.CORE_DB.prepare("INSERT INTO core_outbox (id, kind, aggregate_id, payload_json, created_at) SELECT ?, 'start-validation-workflow', ?, ?, ? WHERE EXISTS (SELECT 1 FROM collection_imports WHERE id=? AND source_kind='canonical-successor' AND status='queued')")
        .bind(crypto.randomUUID(), importId, workflowPayloadJson, now, importId),
    ]);
    if (inserted?.meta.changes === 1) queued += 1;
  }
  return queued;
}

async function applyImportRetention(env: ForgeWorkerEnv): Promise<{ readonly archives: number; readonly drafts: number }> {
  const now = new Date().toISOString();
  const quarantined = await env.CORE_DB.prepare("SELECT id, archive_r2_key FROM collection_imports WHERE archive_disposition='quarantined' AND archive_r2_key IS NOT NULL AND archive_delete_after<=? ORDER BY archive_delete_after LIMIT 10")
    .bind(now).all<{ id: string; archive_r2_key: string }>();
  let archives = 0;
  for (const row of quarantined.results) {
    const cleanupPayload = archiveCleanupOutboxJson(row.id);
    const [updated, outbox] = await env.CORE_DB.batch([
      env.CORE_DB.prepare("UPDATE collection_imports SET archive_disposition='pending', archive_delete_after=?, updated_at=? WHERE id=? AND archive_disposition='quarantined' AND archive_r2_key=? AND archive_delete_after<=?")
        .bind(now, now, row.id, row.archive_r2_key, now),
      env.CORE_DB.prepare("INSERT INTO core_outbox (id, kind, aggregate_id, payload_json, created_at) SELECT ?, 'cleanup-import-archive', ?, ?, ? WHERE EXISTS (SELECT 1 FROM collection_imports WHERE id=? AND archive_r2_key=? AND archive_disposition='pending') AND NOT EXISTS (SELECT 1 FROM core_outbox WHERE kind='cleanup-import-archive' AND aggregate_id=? AND delivered_at IS NULL)")
        .bind(crypto.randomUUID(), row.id, cleanupPayload, now, row.id, row.archive_r2_key, row.id),
    ]);
    if (updated?.meta.changes !== 1 || outbox?.meta.changes !== 1) {
      const durable = await env.CORE_DB.prepare("SELECT 1 AS valid FROM collection_imports JOIN core_outbox ON core_outbox.aggregate_id=collection_imports.id AND core_outbox.kind='cleanup-import-archive' AND core_outbox.delivered_at IS NULL WHERE collection_imports.id=? AND collection_imports.archive_r2_key=? AND collection_imports.archive_disposition='pending' AND core_outbox.payload_json=?")
        .bind(row.id, row.archive_r2_key, cleanupPayload).first<{ valid: number }>();
      if (!durable) throw new Error("Quarantined archive cleanup lost its durable outbox fence.");
    }
    archives += updated?.meta.changes ?? 0;
  }

  // Content-addressed source and projection objects may be shared. Expiry first
  // revokes publication eligibility; exact per-import claims are then released
  // into the tokenized, grace-period GC below. Physical deletion never guesses
  // ownership from a root key.
  const expired = await env.CORE_DB.prepare("SELECT id, status, validation_report_r2_key FROM collection_imports WHERE (status='valid' AND canonical_draft_delete_after IS NOT NULL AND canonical_draft_delete_after<=? AND NOT EXISTS (SELECT 1 FROM managed_snapshots WHERE import_id=collection_imports.id)) OR (status='invalid' AND error_code='canonical-draft-expired' AND validation_report_r2_key IS NOT NULL) ORDER BY COALESCE(canonical_draft_delete_after, canonical_expired_at) LIMIT 10")
    .bind(now).all<{ id: string; status: string; validation_report_r2_key: string | null }>();
  let drafts = 0;
  for (const row of expired.results) {
    let claimed = row.status === "invalid";
    if (!claimed) {
      const updated = await env.CORE_DB.prepare("UPDATE collection_imports SET status='invalid', error_code='canonical-draft-expired', canonical_draft_delete_after=NULL, canonical_expired_at=?, updated_at=? WHERE id=? AND status='valid' AND canonical_draft_delete_after<=? AND NOT EXISTS (SELECT 1 FROM managed_snapshots WHERE import_id=collection_imports.id)")
        .bind(now, now, row.id, now).run();
      claimed = updated.meta.changes === 1;
      drafts += updated.meta.changes;
    }
    if (!claimed) continue;
    await releaseImportObjectClaims(env, row.id, new Date(now));
    await env.CORE_DB.prepare("UPDATE collection_imports SET validation_report_r2_key=NULL, canonical_source_r2_key=NULL, canonical_source_mirror_r2_key=NULL, canonical_source_sha256=NULL, updated_at=? WHERE id=? AND status='invalid' AND error_code='canonical-draft-expired'")
      .bind(now, row.id).run();
  }
  return { archives, drafts };
}

async function reconcileCanonicalObjectGc(env: ForgeWorkerEnv): Promise<number> {
  const now = new Date();
  const nowIso = now.toISOString();
  const candidates = await env.CORE_DB.prepare("SELECT object_key, object_sha256, object_bytes FROM canonical_object_gc WHERE not_before<=? AND (state='pending' OR (state='deleting' AND lease_expires_at<=?)) AND NOT EXISTS (SELECT 1 FROM collection_import_objects WHERE object_key=canonical_object_gc.object_key) ORDER BY not_before LIMIT 10")
    .bind(nowIso, nowIso).all<{ object_key: string; object_sha256: string; object_bytes: number }>();
  let deleted = 0;
  for (const candidate of candidates.results) {
    const token = crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1_000).toISOString();
    const claimed = await env.CORE_DB.prepare("UPDATE canonical_object_gc SET state='deleting', delete_token=?, lease_expires_at=?, attempts=attempts+1, last_error=NULL WHERE object_key=? AND object_sha256=? AND object_bytes=? AND not_before<=? AND (state='pending' OR (state='deleting' AND lease_expires_at<=?)) AND NOT EXISTS (SELECT 1 FROM collection_import_objects WHERE object_key=canonical_object_gc.object_key)")
      .bind(token, leaseExpiresAt, candidate.object_key, candidate.object_sha256, candidate.object_bytes, nowIso, nowIso).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      await Promise.all([env.JUDGE_BUCKET.delete(candidate.object_key), env.JUDGE_MIRROR_BUCKET.delete(candidate.object_key)]);
      const [primary, mirror] = await Promise.all([env.JUDGE_BUCKET.head(candidate.object_key), env.JUDGE_MIRROR_BUCKET.head(candidate.object_key)]);
      if (primary || mirror) throw new Error("Canonical object GC read-back still found an object.");
      const finalized = await env.CORE_DB.prepare("DELETE FROM canonical_object_gc WHERE object_key=? AND state='deleting' AND delete_token=? AND NOT EXISTS (SELECT 1 FROM collection_import_objects WHERE object_key=canonical_object_gc.object_key)")
        .bind(candidate.object_key, token).run();
      if (finalized.meta.changes !== 1) throw new Error("Canonical object GC lost its deletion fence.");
      deleted += 1;
    } catch (error) {
      await env.CORE_DB.prepare("UPDATE canonical_object_gc SET state='pending', delete_token=NULL, lease_expires_at=NULL, last_error=? WHERE object_key=? AND state='deleting' AND delete_token=?")
        .bind(error instanceof Error && error.message.includes("read-back") ? "r2-delete-readback-failed" : "r2-delete-failed", candidate.object_key, token).run();
    }
  }
  return deleted;
}

export async function reconcilePhase<T>(code: string, fallback: T, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    operationalLog("error", {
      event: "reconciler.delivery-failed",
      outcome: "deferred",
      code,
      aggregateId: "scheduled-reconciler",
    });
    return fallback;
  }
}

export async function reconcile(env: ForgeWorkerEnv): Promise<{ readonly submission: number; readonly workflowFailures: number; readonly auditCleanup: number; readonly admissions: { readonly committed: number; readonly aborted: number; readonly pending: number }; readonly core: number; readonly erasure: number; readonly successors: number; readonly retention: { readonly archives: number; readonly drafts: number }; readonly canonicalGc: number }> {
  // Submission terminalization and cleanup run first and are isolated from
  // organizer/validation/rejudge failures. A persistently broken projection or
  // GitHub integration must never starve the D1 Workflow repair loop for admitted
  // jobs.
  const submission = await reconcilePhase("submission-outbox-phase", 0, () => reconcileSubmissionOutbox(env));
  const workflowFailures = await reconcilePhase("submission-workflow-phase", 0, () => reconcileTerminalWorkflowFailures(env));
  const auditCleanup = await reconcilePhase("submission-audit-phase", 0, () => reconcileUncommittedAttemptAudits(env));

  await reconcilePhase("github-claim-cleanup-phase", undefined, () => cleanupExpiredGithubInstallationClaims(env.CORE_DB));
  await reconcilePhase("formal-risk-cleanup-phase", 0, () => cleanupExpiredFormalRiskAllowances(env));
  const erasure = await reconcilePhase("account-erasure-phase", 0, () => reconcileAccountErasures(env));
  const admissions = await reconcilePhase("formal-admission-phase", { committed: 0, aborted: 0, pending: 0 }, () => reconcileFormalSubmissionAdmissions(env));
  const successors = await reconcilePhase("canonical-successor-phase", 0, () => queueCanonicalSuccessors(env));
  const core = await reconcilePhase("core-outbox-phase", 0, () => reconcileCoreOutbox(env));
  await reconcilePhase("rejudge-result-phase", 0, () => deliverRejudgeResults(env));
  await reconcilePhase("rejudge-refresh-phase", 0, () => refreshRejudgeBatches(env));
  await reconcilePhase("rejudge-dispatch-phase", 0, () => dispatchRejudgeJobs(env));
  await reconcilePhase("contest-freeze-phase", undefined, () => synchronizeContestFreeze(env));
  const retention = await reconcilePhase("import-retention-phase", { archives: 0, drafts: 0 }, () => applyImportRetention(env));
  const canonicalGc = await reconcilePhase("canonical-gc-phase", 0, () => reconcileCanonicalObjectGc(env));
  return { submission, workflowFailures, auditCleanup, admissions, core, erasure, successors, retention, canonicalGc };
}
