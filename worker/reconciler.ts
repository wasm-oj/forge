import type { ForgeWorkerEnv } from "./env";
import { resumeAccountErasure } from "./account-erasure";
import { dispatchRejudgeJobs, materializeRejudgeBatch, refreshRejudgeBatches, settleTerminalRejudgeJobs } from "./rejudge";
import { releaseImportObjectClaims } from "./canonical-object-claims";
import { operationalLog } from "./structured-log";
import { cleanupExpiredGithubInstallationClaims } from "./github-installation-claims";
import { deleteAttemptAudit } from "./submission-audits";
import {
  parseSubmissionWorkflowParameters,
  type SubmissionWorkflowParameters,
} from "./submission-workflow-identity";
import { cleanupExpiredFormalRiskAllowances } from "./formal-access";
import {
  archiveCleanupOutboxJson,
  deliverValidationWorkflowOutbox,
  parseArchiveCleanupOutboxJson,
} from "./validation-workflow-outbox";
import { prepareSubmissionEventInsert } from "./submission-events";
import { reconcileAdmittingSubmission } from "./submissions";

interface OutboxRow {
  readonly id: string;
  readonly aggregate_id: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly attempts: number;
}

export const START_WORKFLOW_ELIGIBILITY_SQL = `SELECT submissions.user_id, submission_attempts.token_hash
  FROM submissions
  JOIN submission_attempts ON submission_attempts.submission_id=submissions.id AND submission_attempts.attempt=?
  WHERE submissions.id=?
    AND submissions.state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')
    AND submissions.source_erased_at IS NULL
    AND EXISTS (SELECT 1 FROM users WHERE users.id=submissions.user_id AND users.status='active')
    AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=submissions.user_id)`;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function submissionWorkflowPayload(value: unknown): SubmissionWorkflowParameters {
  return parseSubmissionWorkflowParameters(value);
}

async function cleanupImportArchive(env: ForgeWorkerEnv, importId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT archive_r2_key FROM collection_imports WHERE id=? AND archive_r2_key IS NOT NULL AND archive_disposition='pending'")
    .bind(importId).first<{ readonly archive_r2_key: string }>();
  if (!row) {
    const alreadyDeleted = await env.DB.prepare("SELECT 1 AS valid FROM collection_imports WHERE id=? AND archive_r2_key IS NULL AND archive_disposition='deleted'")
      .bind(importId).first<{ valid: number }>();
    if (alreadyDeleted) return;
    throw new Error("Archive cleanup lost its import fence.");
  }
  if (!new RegExp(`^imports/${importId}/[0-9a-f]{40}\\.tar\\.gz$`).test(row.archive_r2_key)) {
    throw new Error("Archive cleanup database key is not bound to its import.");
  }
  await env.JUDGE_BUCKET.delete(row.archive_r2_key);
  if (await env.JUDGE_BUCKET.head(row.archive_r2_key)) throw new Error("Archive cleanup read-back still found an object.");
  const updated = await env.DB.prepare("UPDATE collection_imports SET archive_r2_key=NULL, archive_disposition='deleted', archive_delete_after=NULL, updated_at=? WHERE id=? AND archive_r2_key=? AND archive_disposition='pending'")
    .bind(new Date().toISOString(), importId, row.archive_r2_key).run();
  if (updated.meta.changes !== 1) throw new Error("Archive cleanup lost its final database fence.");
}

async function markSubmissionOutbox(env: ForgeWorkerEnv, row: OutboxRow, error?: unknown): Promise<void> {
  if (!error) {
    await env.DB.prepare("UPDATE outbox SET delivered_at=?, attempts=attempts+1, last_error=NULL, payload_json='{}' WHERE id=?")
      .bind(new Date().toISOString(), row.id).run();
    return;
  }
  await env.DB.prepare("UPDATE outbox SET attempts=attempts+1, last_error=? WHERE id=?")
    .bind("workflow-delivery-failed", row.id).run();
}

async function startSubmissionWorkflow(env: ForgeWorkerEnv, row: OutboxRow, payload: SubmissionWorkflowParameters): Promise<void> {
  if (payload.submissionId !== row.aggregate_id) throw new Error("Submission Workflow outbox identity is invalid.");
  const durable = await env.DB.prepare(START_WORKFLOW_ELIGIBILITY_SQL)
    .bind(payload.attempt, payload.submissionId).first<{ readonly user_id: string; readonly token_hash: string }>();
  if (!durable) {
    const workflow = await env.SUBMISSION_WORKFLOW.get(row.aggregate_id);
    const status = await workflow.status();
    if (["complete", "errored", "terminated"].includes(status.status)) return;
    if (status.status !== "unknown") await workflow.terminate();
    throw new Error("Submission Workflow initialization fence is closed.");
  }
  const beforeCreate = await env.DB.prepare(START_WORKFLOW_ELIGIBILITY_SQL)
    .bind(payload.attempt, payload.submissionId).first<{ readonly user_id: string; readonly token_hash: string }>();
  if (!beforeCreate || beforeCreate.user_id !== durable.user_id || beforeCreate.token_hash !== durable.token_hash) {
    throw new Error("Submission Workflow initialization fence closed before create.");
  }
  try {
    await env.SUBMISSION_WORKFLOW.create({ id: row.aggregate_id, params: payload });
  } catch (error) {
    const status = await (await env.SUBMISSION_WORKFLOW.get(row.aggregate_id)).status();
    if (status.status === "unknown") throw error;
  }
  const afterCreate = await env.DB.prepare(START_WORKFLOW_ELIGIBILITY_SQL)
    .bind(payload.attempt, payload.submissionId).first<{ readonly user_id: string; readonly token_hash: string }>();
  if (!afterCreate || afterCreate.user_id !== durable.user_id || afterCreate.token_hash !== durable.token_hash) {
    const workflow = await env.SUBMISSION_WORKFLOW.get(row.aggregate_id);
    await workflow.terminate();
    throw new Error("Submission Workflow initialization fence closed during create.");
  }
}

async function exhaustSubmissionWorkflowStart(
  env: ForgeWorkerEnv,
  row: OutboxRow,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE submissions SET state='infrastructure-error', score=0, fully_passed_cases=0, updated_at=?, completed_at=? WHERE id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')")
      .bind(now, now, row.aggregate_id),
    env.DB.prepare("UPDATE submission_attempts SET state='failed', finished_at=?, failure_code='workflow-delivery-exhausted' WHERE submission_id=? AND state IN ('created','running') AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='infrastructure-error')")
      .bind(now, row.aggregate_id, row.aggregate_id),
    prepareSubmissionEventInsert(env.DB, {
      submissionId: row.aggregate_id,
      eventKey: "workflow-delivery-exhausted",
      event: { kind: "state", state: "infrastructure-error" },
      timestamp: now,
      requiredState: "infrastructure-error",
    }),
  ]);
  const submission = await env.DB.prepare("SELECT state FROM submissions WHERE id=?")
    .bind(row.aggregate_id).first<{ readonly state: string }>();
  if (!submission || !["infrastructure-error", "cancelled", "completed", "compile-error", "judge-error"].includes(submission.state)) {
    throw new Error("Exhausted Workflow delivery lost its terminal-state fence.");
  }
  await env.DB.prepare("UPDATE outbox SET delivered_at=?, attempts=attempts+1, last_error='workflow-delivery-exhausted', payload_json='{}' WHERE id=? AND delivered_at IS NULL")
    .bind(now, row.id).run();
}

async function processSubmissionOutboxRow(env: ForgeWorkerEnv, row: OutboxRow): Promise<void> {
  try {
    if (row.kind !== "start-submission-workflow") throw new Error(`Unknown submission outbox kind '${row.kind}'.`);
    if (row.attempts >= 20) {
      await exhaustSubmissionWorkflowStart(env, row);
      return;
    }
    const payload = submissionWorkflowPayload(JSON.parse(row.payload_json) as unknown);
    await startSubmissionWorkflow(env, row, payload);
    await markSubmissionOutbox(env, row);
  } catch (error) {
    await markSubmissionOutbox(env, row, error);
  }
}

async function reconcileSubmissionOutbox(env: ForgeWorkerEnv): Promise<number> {
  const pending = await env.DB.prepare("SELECT id, aggregate_id, kind, payload_json, attempts FROM outbox WHERE delivered_at IS NULL AND kind='start-submission-workflow' ORDER BY CASE WHEN attempts < 20 THEN 0 ELSE 1 END, attempts, created_at LIMIT 25")
    .all<OutboxRow>();
  for (const row of pending.results) await processSubmissionOutboxRow(env, row);
  return pending.results.length;
}

export async function reconcileUncommittedAttemptAudits(env: ForgeWorkerEnv): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT submission_id, attempt, audit_r2_key FROM submission_attempts WHERE audit_r2_key IS NOT NULL AND state IN ('failed','superseded','cancelled') ORDER BY finished_at, submission_id, attempt LIMIT 25",
  ).all<{ readonly submission_id: string; readonly attempt: number; readonly audit_r2_key: string }>();
  let cleaned = 0;
  for (const row of rows.results) {
    try {
      await deleteAttemptAudit(env, {
        submissionId: row.submission_id,
        attempt: row.attempt,
        auditR2Key: row.audit_r2_key,
      });
      const cleared = await env.DB.prepare(
        "UPDATE submission_attempts SET audit_r2_key=NULL WHERE submission_id=? AND attempt=? AND audit_r2_key=? AND state IN ('failed','superseded','cancelled')",
      ).bind(row.submission_id, row.attempt, row.audit_r2_key).run();
      if (cleared.meta.changes !== 1) {
        const current = await env.DB.prepare("SELECT state, audit_r2_key FROM submission_attempts WHERE submission_id=? AND attempt=?")
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
  const rows = await env.DB.prepare(
    `SELECT submissions.id, submissions.updated_at
       FROM submissions
       JOIN outbox ON outbox.aggregate_id=submissions.id
        AND outbox.kind='start-submission-workflow'
        AND outbox.delivered_at IS NOT NULL
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
      const [submission] = await env.DB.batch([
        env.DB.prepare("UPDATE submissions SET state='infrastructure-error', score=0, fully_passed_cases=0, updated_at=?, completed_at=? WHERE id=? AND rejudge_batch_id IS NULL AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')")
          .bind(now, now, row.id),
        env.DB.prepare("UPDATE submission_attempts SET state='failed', finished_at=COALESCE(finished_at, ?), failure_code=COALESCE(failure_code, 'workflow-terminal-without-result') WHERE submission_id=? AND state IN ('created','running') AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='infrastructure-error')")
          .bind(now, row.id, row.id),
        prepareSubmissionEventInsert(env.DB, {
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
  const row = await env.DB.prepare("SELECT id, aggregate_id, kind, payload_json, attempts FROM outbox WHERE id=? AND kind='start-submission-workflow' AND delivered_at IS NULL")
    .bind(outboxId).first<OutboxRow>();
  if (!row) return false;
  await processSubmissionOutboxRow(env, row);
  return true;
}

async function reconcileExternalOutbox(env: ForgeWorkerEnv): Promise<number> {
  const pending = await env.DB.prepare("SELECT id, kind, aggregate_id, payload_json, attempts FROM outbox WHERE delivered_at IS NULL AND kind IN ('start-validation-workflow','materialize-rejudge','cleanup-import-archive') ORDER BY CASE WHEN attempts < 20 THEN 0 ELSE 1 END, attempts, created_at LIMIT 10")
    .all<OutboxRow>();
  for (const row of pending.results) {
    try {
      let delivered = true;
      if (row.kind === "start-validation-workflow") {
        if (row.attempts >= 20) {
          const now = new Date().toISOString();
          const [terminalized, outbox] = await env.DB.batch([
            env.DB.prepare("UPDATE collection_imports SET status='infrastructure-error', error_code='validation-workflow-delivery-exhausted', archive_disposition='deleted', archive_delete_after=NULL, updated_at=? WHERE id=? AND status='queued' AND archive_r2_key IS NULL")
              .bind(now, row.aggregate_id),
            env.DB.prepare("UPDATE outbox SET delivered_at=?, attempts=attempts+1, last_error='validation-workflow-delivery-exhausted', payload_json='{}' WHERE id=? AND delivered_at IS NULL AND EXISTS (SELECT 1 FROM collection_imports WHERE id=? AND status IN ('valid','invalid','infrastructure-error'))")
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
      if (delivered) await env.DB.prepare("UPDATE outbox SET delivered_at=?, attempts=attempts+1, last_error=NULL, payload_json='{}' WHERE id=?")
        .bind(new Date().toISOString(), row.id).run();
    } catch {
      const exhausted = row.kind === "materialize-rejudge" && row.attempts + 1 >= 20;
      await env.DB.batch([
        env.DB.prepare("UPDATE outbox SET attempts=attempts+1, last_error=?, delivered_at=CASE WHEN ?=1 THEN ? ELSE delivered_at END, payload_json=CASE WHEN ?=1 THEN '{}' ELSE payload_json END WHERE id=?")
          .bind(row.kind === "materialize-rejudge" ? "rejudge-materialization-failed" : row.kind === "cleanup-import-archive" ? "archive-cleanup-failed" : "validation-workflow-delivery-failed", exhausted ? 1 : 0, new Date().toISOString(), exhausted ? 1 : 0, row.id),
        env.DB.prepare("UPDATE rejudge_batches SET cancel_requested_at=COALESCE(cancel_requested_at, ?), failure_code='rejudge-materialization-failed', updated_at=? WHERE id=? AND ?=1 AND status IN ('queued','running','ready')")
          .bind(new Date().toISOString(), new Date().toISOString(), row.aggregate_id, exhausted && row.kind === "materialize-rejudge" ? 1 : 0),
      ]);
    }
  }
  return pending.results.length;
}

async function reconcileAccountErasures(env: ForgeWorkerEnv): Promise<number> {
  const pending = await env.DB.prepare("SELECT id FROM account_erasure_jobs WHERE status NOT IN ('completed','failed') ORDER BY requested_at LIMIT 5")
    .all<{ id: string }>();
  for (const job of pending.results) {
    try { await resumeAccountErasure(env, job.id); } catch { /* Stable retry state is persisted by the erasure worker. */ }
  }
  return pending.results.length;
}

async function reconcileStrandedAdmissions(env: ForgeWorkerEnv, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 2 * 60 * 1_000).toISOString();
  const pending = await env.DB.prepare(`SELECT id FROM submissions
    WHERE state='admitting' AND rejudge_batch_id IS NULL AND updated_at<=?
    ORDER BY updated_at, id LIMIT 25`)
    .bind(cutoff).all<{ readonly id: string }>();
  let settled = 0;
  for (const submission of pending.results) {
    try {
      if (await reconcileAdmittingSubmission(env, submission.id, now)) settled += 1;
    } catch {
      operationalLog("warn", {
        event: "reconciler.delivery-failed",
        outcome: "deferred",
        code: "submission-admission-recovery",
        aggregateType: "submission",
        aggregateId: submission.id,
      });
    }
  }
  return settled;
}

async function applyImportRetention(env: ForgeWorkerEnv): Promise<{ readonly archives: number; readonly drafts: number }> {
  const now = new Date().toISOString();
  const quarantined = await env.DB.prepare("SELECT id, archive_r2_key FROM collection_imports WHERE archive_disposition='quarantined' AND archive_r2_key IS NOT NULL AND archive_delete_after<=? ORDER BY archive_delete_after LIMIT 10")
    .bind(now).all<{ id: string; archive_r2_key: string }>();
  let archives = 0;
  for (const row of quarantined.results) {
    const cleanupPayload = archiveCleanupOutboxJson(row.id);
    const [updated, outbox] = await env.DB.batch([
      env.DB.prepare("UPDATE collection_imports SET archive_disposition='pending', archive_delete_after=?, updated_at=? WHERE id=? AND archive_disposition='quarantined' AND archive_r2_key=? AND archive_delete_after<=?")
        .bind(now, now, row.id, row.archive_r2_key, now),
      env.DB.prepare("INSERT INTO outbox (id, kind, aggregate_id, payload_json, created_at) SELECT ?, 'cleanup-import-archive', ?, ?, ? WHERE EXISTS (SELECT 1 FROM collection_imports WHERE id=? AND archive_r2_key=? AND archive_disposition='pending') AND NOT EXISTS (SELECT 1 FROM outbox WHERE kind='cleanup-import-archive' AND aggregate_id=? AND delivered_at IS NULL)")
        .bind(crypto.randomUUID(), row.id, cleanupPayload, now, row.id, row.archive_r2_key, row.id),
    ]);
    if (updated?.meta.changes !== 1 || outbox?.meta.changes !== 1) {
      const durable = await env.DB.prepare("SELECT 1 AS valid FROM collection_imports JOIN outbox ON outbox.aggregate_id=collection_imports.id AND outbox.kind='cleanup-import-archive' AND outbox.delivered_at IS NULL WHERE collection_imports.id=? AND collection_imports.archive_r2_key=? AND collection_imports.archive_disposition='pending' AND outbox.payload_json=?")
        .bind(row.id, row.archive_r2_key, cleanupPayload).first<{ valid: number }>();
      if (!durable) throw new Error("Quarantined archive cleanup lost its durable outbox fence.");
    }
    archives += updated?.meta.changes ?? 0;
  }

  // Content-addressed source and projection objects may be shared. Expiry first
  // revokes publication eligibility; exact per-import claims are then released
  // into the tokenized, grace-period GC below. Physical deletion never guesses
  // ownership from a root key.
  const expired = await env.DB.prepare("SELECT id, status, validation_report_r2_key FROM collection_imports WHERE (status='valid' AND canonical_draft_delete_after IS NOT NULL AND canonical_draft_delete_after<=? AND NOT EXISTS (SELECT 1 FROM managed_snapshots WHERE import_id=collection_imports.id)) OR (status='invalid' AND error_code='canonical-draft-expired' AND validation_report_r2_key IS NOT NULL) ORDER BY COALESCE(canonical_draft_delete_after, canonical_expired_at) LIMIT 10")
    .bind(now).all<{ id: string; status: string; validation_report_r2_key: string | null }>();
  let drafts = 0;
  for (const row of expired.results) {
    let claimed = row.status === "invalid";
    if (!claimed) {
      const updated = await env.DB.prepare("UPDATE collection_imports SET status='invalid', error_code='canonical-draft-expired', canonical_draft_delete_after=NULL, canonical_expired_at=?, updated_at=? WHERE id=? AND status='valid' AND canonical_draft_delete_after<=? AND NOT EXISTS (SELECT 1 FROM managed_snapshots WHERE import_id=collection_imports.id)")
        .bind(now, now, row.id, now).run();
      claimed = updated.meta.changes === 1;
      drafts += updated.meta.changes;
    }
    if (!claimed) continue;
    await releaseImportObjectClaims(env, row.id, new Date(now));
    await env.DB.prepare("UPDATE collection_imports SET validation_report_r2_key=NULL, canonical_source_r2_key=NULL, canonical_source_sha256=NULL, updated_at=? WHERE id=? AND status='invalid' AND error_code='canonical-draft-expired'")
      .bind(now, row.id).run();
  }
  return { archives, drafts };
}

async function reconcileCanonicalObjectGc(env: ForgeWorkerEnv): Promise<number> {
  const now = new Date();
  const nowIso = now.toISOString();
  const candidates = await env.DB.prepare("SELECT object_key, object_sha256, object_bytes FROM canonical_object_gc WHERE not_before<=? AND (state='pending' OR (state='deleting' AND lease_expires_at<=?)) AND NOT EXISTS (SELECT 1 FROM collection_import_objects WHERE object_key=canonical_object_gc.object_key) ORDER BY not_before LIMIT 10")
    .bind(nowIso, nowIso).all<{ object_key: string; object_sha256: string; object_bytes: number }>();
  let deleted = 0;
  for (const candidate of candidates.results) {
    const token = crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1_000).toISOString();
    const claimed = await env.DB.prepare("UPDATE canonical_object_gc SET state='deleting', delete_token=?, lease_expires_at=?, attempts=attempts+1, last_error=NULL WHERE object_key=? AND object_sha256=? AND object_bytes=? AND not_before<=? AND (state='pending' OR (state='deleting' AND lease_expires_at<=?)) AND NOT EXISTS (SELECT 1 FROM collection_import_objects WHERE object_key=canonical_object_gc.object_key)")
      .bind(token, leaseExpiresAt, candidate.object_key, candidate.object_sha256, candidate.object_bytes, nowIso, nowIso).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      await env.JUDGE_BUCKET.delete(candidate.object_key);
      if (await env.JUDGE_BUCKET.head(candidate.object_key)) throw new Error("Canonical object GC read-back still found an object.");
      const finalized = await env.DB.prepare("DELETE FROM canonical_object_gc WHERE object_key=? AND state='deleting' AND delete_token=? AND NOT EXISTS (SELECT 1 FROM collection_import_objects WHERE object_key=canonical_object_gc.object_key)")
        .bind(candidate.object_key, token).run();
      if (finalized.meta.changes !== 1) throw new Error("Canonical object GC lost its deletion fence.");
      deleted += 1;
    } catch (error) {
      await env.DB.prepare("UPDATE canonical_object_gc SET state='pending', delete_token=NULL, lease_expires_at=NULL, last_error=? WHERE object_key=? AND state='deleting' AND delete_token=?")
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

export interface ReconciliationCadence {
  readonly hourlyCleanup: boolean;
  readonly dailyCleanup: boolean;
}

export function reconciliationCadence(now = new Date()): ReconciliationCadence {
  const hourlyCleanup = now.getUTCMinutes() === 0;
  return {
    hourlyCleanup,
    dailyCleanup: hourlyCleanup && now.getUTCHours() === 0,
  };
}

export async function reconcile(env: ForgeWorkerEnv, now = new Date()): Promise<{ readonly submission: number; readonly workflowFailures: number; readonly auditCleanup: number; readonly admissions: number; readonly core: number; readonly erasure: number; readonly retention: { readonly archives: number; readonly drafts: number }; readonly canonicalGc: number }> {
  // Submission terminalization and cleanup run first and are isolated from
  // organizer/validation/rejudge failures. A persistently broken projection or
  // GitHub integration must never starve the D1 Workflow repair loop for admitted
  // jobs.
  const submission = await reconcilePhase("submission-outbox-phase", 0, () => reconcileSubmissionOutbox(env));
  const workflowFailures = await reconcilePhase("submission-workflow-phase", 0, () => reconcileTerminalWorkflowFailures(env));
  const erasure = await reconcilePhase("account-erasure-phase", 0, () => reconcileAccountErasures(env));
  const admissions = await reconcilePhase("submission-admission-phase", 0, () => reconcileStrandedAdmissions(env, now));
  const core = await reconcilePhase("external-outbox-phase", 0, () => reconcileExternalOutbox(env));
  await reconcilePhase("rejudge-result-phase", 0, () => settleTerminalRejudgeJobs(env));
  await reconcilePhase("rejudge-refresh-phase", 0, () => refreshRejudgeBatches(env));
  await reconcilePhase("rejudge-dispatch-phase", 0, () => dispatchRejudgeJobs(env));

  const cadence = reconciliationCadence(now);
  let auditCleanup = 0;
  if (cadence.hourlyCleanup) {
    auditCleanup = await reconcilePhase("submission-audit-phase", 0, () => reconcileUncommittedAttemptAudits(env));
    await reconcilePhase("github-claim-cleanup-phase", undefined, () => cleanupExpiredGithubInstallationClaims(env.DB, now));
    await reconcilePhase("formal-risk-cleanup-phase", 0, () => cleanupExpiredFormalRiskAllowances(env));
  }

  let retention = { archives: 0, drafts: 0 };
  let canonicalGc = 0;
  if (cadence.dailyCleanup) {
    retention = await reconcilePhase("import-retention-phase", retention, () => applyImportRetention(env));
    canonicalGc = await reconcilePhase("canonical-gc-phase", 0, () => reconcileCanonicalObjectGc(env));
  }
  return { submission, workflowFailures, auditCleanup, admissions, core, erasure, retention, canonicalGc };
}
