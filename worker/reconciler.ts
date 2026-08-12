import type { CatalogWorkflowParameters } from "./catalog-workflow-identity";
import { redeliverClaimedCatalogJob, dispatchCatalogJobs } from "./catalog-dispatcher";
import { dispatchSubmissionJobs, redeliverClaimedSubmission } from "./dispatcher";
import type { WasmOjWorkerEnv } from "./env";
import { resumeAccountErasure } from "./account-erasure";
import {
  materializePendingRejudgeBatches,
  repairDispatchedRejudgeJobs,
  refreshRejudgeBatches,
  settleTerminalRejudgeJobs,
} from "./rejudge";
import { operationalLog } from "./structured-log";
import { prepareSubmissionEventInsert } from "./submission-events";
import { reconcileAdmittingSubmission, tombstoneSubmissionSource } from "./submissions";
import { workflowInstanceNotFound } from "./workflow-instance-status";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const RETENTION_RUN_INTERVAL_MS = HOUR_MS;
const SQL_RETENTION_QUOTA = 50;
const TOMBSTONE_QUOTA = 25;
const STAGING_PACKAGE_QUOTA = 25;
const R2_RETENTION_QUOTA = 100;
const TERMINAL_SUBMISSION_STATES = [
  "completed",
  "compile-error",
  "judge-error",
  "infrastructure-error",
  "cancelled",
] as const;
const TERMINAL_WORKFLOW_STATES = new Set(["complete", "errored", "terminated"]);
const JUDGE_PACKAGE_KEY = /^judge-packages\/v2\/([0-9a-f]{64})$/;
const JUDGE_PACKAGE_MAX_BYTES = 32 * 1024 * 1024;

type RetentionKind =
  | "submission-events"
  | "terminal-catalog-jobs"
  | "github-webhook-deliveries"
  | "settled-outbox"
  | "expired-auth"
  | "orphan-judge-packages";

interface CursorRow {
  readonly cursor: string | null;
  readonly last_completed_at: string | null;
}

interface PendingOutboxRow {
  readonly id: string;
  readonly catalog_validation_job_id: string | null;
  readonly catalog_publish_job_id: string | null;
  readonly submission_id: string | null;
  readonly attempts: number;
}

type PendingOutboxKind = "validation" | "publish" | "submission";

function pendingOutboxKind(row: PendingOutboxRow): PendingOutboxKind {
  if (row.catalog_validation_job_id) return "validation";
  if (row.catalog_publish_job_id) return "publish";
  if (row.submission_id) return "submission";
  throw new Error("Workflow outbox target is missing.");
}

export interface RetentionCounts {
  readonly submissionEvents: number;
  readonly catalogJobs: number;
  readonly webhooks: number;
  readonly outbox: number;
  readonly auth: number;
  readonly orphanJudgePackages: number;
}

export function retentionIsDue(
  lastCompletedAt: string | null,
  cursor: string | null,
  now = new Date(),
): boolean {
  if (cursor !== null || lastCompletedAt === null) return true;
  const completed = Date.parse(lastCompletedAt);
  if (!Number.isFinite(completed)) throw new TypeError("Maintenance completion timestamp is invalid.");
  return now.getTime() - completed >= RETENTION_RUN_INTERVAL_MS;
}

function cutoff(now: Date, ageMs: number): string {
  return new Date(now.getTime() - ageMs).toISOString();
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "maintenance-operation-failed";
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

async function reconcileAccountErasures(env: WasmOjWorkerEnv): Promise<number> {
  const pending = await env.DB.prepare(
    "SELECT id FROM account_erasure_jobs WHERE status NOT IN ('completed','failed') ORDER BY requested_at, id LIMIT 5",
  ).all<{ readonly id: string }>();
  for (const job of pending.results) {
    try {
      await resumeAccountErasure(env, job.id);
    } catch {
      // The erasure worker persists a retryable phase before every side effect.
    }
  }
  return pending.results.length;
}

async function reconcileStrandedAdmissions(env: WasmOjWorkerEnv, now: Date): Promise<number> {
  const pending = await env.DB.prepare(`SELECT id FROM submissions
    WHERE state='admitting' AND updated_at<=?
    ORDER BY updated_at, id LIMIT 25`)
    .bind(cutoff(now, 2 * 60 * 1_000)).all<{ readonly id: string }>();
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

async function workflowAlreadyExists(
  env: WasmOjWorkerEnv,
  row: PendingOutboxRow,
): Promise<boolean> {
  const kind = pendingOutboxKind(row);
  const workflow = kind === "submission"
    ? await env.SUBMISSION_WORKFLOW.get(row.submission_id!)
    : await env.CATALOG_WORKFLOW.get(
      `catalog-${kind}-${
        row.catalog_validation_job_id ?? row.catalog_publish_job_id
      }`,
    );
  try {
    const status = await workflow.status();
    return status.status !== "unknown";
  } catch (error) {
    if (workflowInstanceNotFound(error)) return false;
    throw error;
  }
}

async function markOutboxDelivered(env: WasmOjWorkerEnv, id: string, now: string): Promise<void> {
  await env.DB.prepare(`UPDATE workflow_outbox
      SET state='delivered', settled_at=?, last_error=NULL, updated_at=?
    WHERE id=? AND state='pending'`)
    .bind(now, now, id).run();
}

async function settleOutboxCancelled(
  env: WasmOjWorkerEnv,
  id: string,
  now: string,
  reason: string,
): Promise<void> {
  await env.DB.prepare(`UPDATE workflow_outbox
      SET state='cancelled', settled_at=?, last_error=?, updated_at=?
    WHERE id=? AND state='pending'`)
    .bind(now, reason, now, id).run();
}

async function failExhaustedOutbox(env: WasmOjWorkerEnv, row: PendingOutboxRow, now: string): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  const kind = pendingOutboxKind(row);
  if (kind === "submission" && row.submission_id) {
    statements.push(
      env.DB.prepare(`UPDATE submissions
          SET state='infrastructure-error', verdict='judge-error', score=0,
              fully_passed_cases=0, updated_at=?, completed_at=?
        WHERE id=? AND state IN ('queued','preparing','compiling','running','finalizing')`)
        .bind(now, now, row.submission_id),
      env.DB.prepare(`UPDATE submission_attempts
          SET state='failed', finished_at=COALESCE(finished_at, ?),
              failure_code='workflow-delivery-exhausted'
        WHERE submission_id=? AND state IN ('created','running')`)
        .bind(now, row.submission_id),
      prepareSubmissionEventInsert(env.DB, {
        submissionId: row.submission_id,
        eventKey: "workflow-delivery-exhausted",
        event: { kind: "state", state: "infrastructure-error" },
        timestamp: now,
        requiredState: "infrastructure-error",
      }),
    );
  } else if (kind === "validation" && row.catalog_validation_job_id) {
    statements.push(env.DB.prepare(`UPDATE catalog_validation_jobs
        SET state='infrastructure-error', error_code='workflow-delivery-exhausted',
            finished_at=?, updated_at=?
      WHERE id=? AND state='running'`)
      .bind(now, now, row.catalog_validation_job_id));
  } else if (kind === "publish" && row.catalog_publish_job_id) {
    statements.push(env.DB.prepare(`UPDATE catalog_publish_jobs
        SET state='failed', error_code='workflow-delivery-exhausted', finished_at=?, updated_at=?
      WHERE id=? AND state='materializing'`)
      .bind(now, now, row.catalog_publish_job_id));
  }
  statements.push(env.DB.prepare(`UPDATE workflow_outbox
      SET state='failed', settled_at=?, last_error='workflow-delivery-exhausted', updated_at=?
    WHERE id=? AND state='pending'`).bind(now, now, row.id));
  await env.DB.batch(statements);
}

export async function reconcilePendingOutbox(env: WasmOjWorkerEnv): Promise<number> {
  const rows = await env.DB.prepare(`SELECT id, catalog_validation_job_id,
      catalog_publish_job_id, submission_id, attempts
    FROM workflow_outbox
    WHERE state='pending'
    ORDER BY created_at, id LIMIT 50`).all<PendingOutboxRow>();
  let handled = 0;
  for (const row of rows.results) {
    const now = new Date().toISOString();
    let kind: PendingOutboxKind;
    try {
      kind = pendingOutboxKind(row);
      if (kind === "submission") {
        if (!row.submission_id) throw new Error("Submission outbox target is missing.");
        const target = await env.DB.prepare(
          "SELECT state FROM submissions WHERE id=?",
        ).bind(row.submission_id).first<{ readonly state: string }>();
        if (!target) {
          await settleOutboxCancelled(env, row.id, now, "workflow-target-missing");
          handled += 1;
          continue;
        }
        if (["admitting", "queued"].includes(target.state)) continue;
        if (TERMINAL_SUBMISSION_STATES.includes(target.state as typeof TERMINAL_SUBMISSION_STATES[number])) {
          await markOutboxDelivered(env, row.id, now);
          handled += 1;
          continue;
        }
        if (await workflowAlreadyExists(env, row)) {
          await markOutboxDelivered(env, row.id, now);
        } else if (row.attempts >= 20) {
          await failExhaustedOutbox(env, row, now);
        } else if (target.state === "preparing") {
          await redeliverClaimedSubmission(env, row.submission_id);
        }
        handled += 1;
        continue;
      }
      {
        const parameters: CatalogWorkflowParameters = kind === "validation"
          ? { kind: "validation", jobId: row.catalog_validation_job_id! }
          : { kind: "publish", jobId: row.catalog_publish_job_id! };
        if (!parameters.jobId) throw new Error("Catalog outbox target is missing.");
        const table = parameters.kind === "validation" ? "catalog_validation_jobs" : "catalog_publish_jobs";
        const state = parameters.kind === "validation" ? "running" : "materializing";
        const target = await env.DB.prepare(`SELECT state FROM ${table} WHERE id=?`)
          .bind(parameters.jobId).first<{ readonly state: string }>();
        if (!target) {
          await settleOutboxCancelled(env, row.id, now, "workflow-target-missing");
          handled += 1;
          continue;
        }
        if (target.state === "queued") continue;
        const terminal = parameters.kind === "validation"
          ? ["valid", "invalid", "infrastructure-error"].includes(target.state)
          : ["published", "failed", "cancelled"].includes(target.state);
        if (terminal || await workflowAlreadyExists(env, row)) {
          await markOutboxDelivered(env, row.id, now);
        } else if (row.attempts >= 20) {
          await failExhaustedOutbox(env, row, now);
        } else if (target.state === state) {
          await redeliverClaimedCatalogJob(env, parameters);
        }
        handled += 1;
      }
    } catch (error) {
      // A status lookup failure is not evidence that a deterministic Workflow
      // is absent. It must never consume the bounded create-attempt budget.
      await env.DB.prepare(`UPDATE workflow_outbox
          SET last_error=?, updated_at=?
        WHERE id=? AND state='pending'`).bind(safeError(error), now, row.id).run();
    }
  }
  return handled;
}

async function reconcileTerminalWorkflowFailures(env: WasmOjWorkerEnv, now: Date): Promise<number> {
  const rows = await env.DB.prepare(`SELECT submissions.id, submissions.updated_at
    FROM submissions
    JOIN workflow_outbox ON workflow_outbox.submission_id=submissions.id
      AND workflow_outbox.state='delivered'
    WHERE submissions.state IN ('preparing','compiling','running','finalizing')
      AND NOT EXISTS (SELECT 1 FROM rejudge_jobs WHERE new_submission_id=submissions.id)
    ORDER BY submissions.updated_at, submissions.id LIMIT 25`)
    .all<{ readonly id: string; readonly updated_at: string }>();
  let repaired = 0;
  for (const row of rows.results) {
    try {
      const status = await (await env.SUBMISSION_WORKFLOW.get(row.id)).status();
      if (!TERMINAL_WORKFLOW_STATES.has(status.status)) {
        if (status.status !== "unknown" || Date.parse(row.updated_at) > now.getTime() - 10 * 60 * 1_000) continue;
      }
      const timestamp = now.toISOString();
      const [submission] = await env.DB.batch([
        env.DB.prepare(`UPDATE submissions
            SET state='infrastructure-error', verdict='judge-error', score=0,
                fully_passed_cases=0, updated_at=?, completed_at=?
          WHERE id=? AND state IN ('preparing','compiling','running','finalizing')`)
          .bind(timestamp, timestamp, row.id),
        env.DB.prepare(`UPDATE submission_attempts
            SET state='failed', finished_at=COALESCE(finished_at, ?),
                failure_code=COALESCE(failure_code, 'workflow-terminal-without-result')
          WHERE submission_id=? AND state IN ('created','running')`)
          .bind(timestamp, row.id),
        prepareSubmissionEventInsert(env.DB, {
          submissionId: row.id,
          eventKey: "workflow-terminal-without-result",
          event: { kind: "state", state: "infrastructure-error" },
          timestamp,
          requiredState: "infrastructure-error",
        }),
      ]);
      repaired += submission?.meta.changes ?? 0;
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

export async function reconcileSourceTombstones(env: WasmOjWorkerEnv, now: Date): Promise<number> {
  let completed = 0;
  for (let iteration = 0; iteration < TOMBSTONE_QUOTA; iteration += 1) {
    const timestamp = now.toISOString();
    const claimUntil = new Date(now.getTime() + 5 * 60 * 1_000).toISOString();
    const source = await env.DB.prepare(`UPDATE submission_sources
        SET erasure_attempts=erasure_attempts+1,
            erasure_next_attempt_at=?, erasure_last_error=NULL
      WHERE id=(
        SELECT id FROM submission_sources
        WHERE state='erasing' AND erasure_next_attempt_at<=?
        ORDER BY erasure_next_attempt_at, erasure_requested_at, id LIMIT 1
      )
      RETURNING id, erasure_attempts`)
      .bind(claimUntil, timestamp)
      .first<{ readonly id: string; readonly erasure_attempts: number }>();
    if (!source) break;
    try {
      await tombstoneSubmissionSource(env, source.id);
      completed += 1;
    } catch (error) {
      const delays = [1, 2, 5, 10, 30] as const;
      const delayMinutes = delays[Math.min(source.erasure_attempts - 1, delays.length - 1)]!;
      const retryAt = new Date(now.getTime() + delayMinutes * 60 * 1_000).toISOString();
      await env.DB.prepare(`UPDATE submission_sources
          SET erasure_next_attempt_at=?, erasure_last_error=?
        WHERE id=? AND state='erasing' AND erasure_attempts=?`)
        .bind(retryAt, safeError(error), source.id, source.erasure_attempts).run();
    }
  }
  return completed;
}

async function retentionCursor(env: WasmOjWorkerEnv, kind: RetentionKind, now: Date): Promise<CursorRow | null> {
  const timestamp = now.toISOString();
  await env.DB.prepare(`INSERT INTO maintenance_cursors (kind, cursor, last_completed_at, updated_at)
    VALUES (?, NULL, NULL, ?) ON CONFLICT(kind) DO NOTHING`).bind(kind, timestamp).run();
  const row = await env.DB.prepare(
    "SELECT cursor, last_completed_at FROM maintenance_cursors WHERE kind=?",
  ).bind(kind).first<CursorRow>();
  if (!row) throw new Error(`Maintenance cursor '${kind}' is unavailable.`);
  return retentionIsDue(row.last_completed_at, row.cursor, now) ? row : null;
}

function cursorUpdate(
  env: WasmOjWorkerEnv,
  kind: RetentionKind,
  nextCursor: string | null,
  complete: boolean,
  now: Date,
): D1PreparedStatement {
  const timestamp = now.toISOString();
  return env.DB.prepare(`UPDATE maintenance_cursors
      SET cursor=?, last_completed_at=CASE WHEN ?=1 THEN ? ELSE last_completed_at END, updated_at=?
    WHERE kind=?`)
    .bind(nextCursor, complete ? 1 : 0, timestamp, timestamp, kind);
}

async function retainSubmissionEvents(env: WasmOjWorkerEnv, now: Date): Promise<number> {
  const state = await retentionCursor(env, "submission-events", now);
  if (!state) return 0;
  const cursor = state.cursor === null ? 0 : Number(state.cursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Submission event retention cursor is invalid.");
  const terminalCutoff = cutoff(now, 7 * DAY_MS);
  const rows = await env.DB.prepare(`SELECT events.id
    FROM submission_events AS events
    JOIN submissions ON submissions.id=events.submission_id
    WHERE events.id>? AND submissions.state IN (${TERMINAL_SUBMISSION_STATES.map(() => "?").join(",")})
      AND submissions.completed_at<=?
    ORDER BY events.id LIMIT ?`)
    .bind(cursor, ...TERMINAL_SUBMISSION_STATES, terminalCutoff, SQL_RETENTION_QUOTA)
    .all<{ readonly id: number }>();
  const complete = rows.results.length < SQL_RETENTION_QUOTA;
  const next = complete ? null : String(rows.results.at(-1)!.id);
  await env.DB.batch([
    ...rows.results.map((row) => env.DB.prepare(`DELETE FROM submission_events
      WHERE id=? AND EXISTS (
        SELECT 1 FROM submissions WHERE id=submission_events.submission_id
          AND state IN (${TERMINAL_SUBMISSION_STATES.map(() => "?").join(",")})
          AND completed_at<=?
      )`).bind(row.id, ...TERMINAL_SUBMISSION_STATES, terminalCutoff)),
    cursorUpdate(env, "submission-events", next, complete, now),
  ]);
  return rows.results.length;
}

interface CatalogRetentionRow {
  readonly sort_key: string;
  readonly kind: "validation" | "publish";
  readonly id: string;
}

async function retainCatalogJobs(env: WasmOjWorkerEnv, now: Date): Promise<number> {
  const state = await retentionCursor(env, "terminal-catalog-jobs", now);
  if (!state) return 0;
  const terminalCutoff = cutoff(now, 30 * DAY_MS);
  const rows = await env.DB.prepare(`SELECT sort_key, kind, id FROM (
      SELECT 'validation:' || id AS sort_key, 'validation' AS kind, id
        FROM catalog_validation_jobs
       WHERE state IN ('valid','invalid','infrastructure-error') AND finished_at<=?
      UNION ALL
      SELECT 'publish:' || id AS sort_key, 'publish' AS kind, id
        FROM catalog_publish_jobs
       WHERE state IN ('published','failed','cancelled') AND finished_at<=?
    ) WHERE sort_key>? ORDER BY sort_key LIMIT ?`)
    .bind(terminalCutoff, terminalCutoff, state.cursor ?? "", SQL_RETENTION_QUOTA)
    .all<CatalogRetentionRow>();
  const complete = rows.results.length < SQL_RETENTION_QUOTA;
  const next = complete ? null : rows.results.at(-1)!.sort_key;
  await env.DB.batch([
    ...rows.results.map((row) => row.kind === "validation"
      ? env.DB.prepare(`DELETE FROM catalog_validation_jobs
          WHERE id=? AND state IN ('valid','invalid','infrastructure-error') AND finished_at<=?`)
        .bind(row.id, terminalCutoff)
      : env.DB.prepare(`DELETE FROM catalog_publish_jobs
          WHERE id=? AND state IN ('published','failed','cancelled') AND finished_at<=?`)
        .bind(row.id, terminalCutoff)),
    cursorUpdate(env, "terminal-catalog-jobs", next, complete, now),
  ]);
  return rows.results.length;
}

async function retainWebhookDeliveries(env: WasmOjWorkerEnv, now: Date): Promise<number> {
  const state = await retentionCursor(env, "github-webhook-deliveries", now);
  if (!state) return 0;
  const terminalCutoff = cutoff(now, 30 * DAY_MS);
  const rows = await env.DB.prepare(`SELECT delivery_id FROM github_webhook_deliveries
    WHERE delivery_id>? AND outcome IN ('accepted','failed') AND updated_at<=?
      AND NOT EXISTS (
        SELECT 1 FROM github_installation_claim_proofs
        WHERE delivery_id=github_webhook_deliveries.delivery_id
      )
    ORDER BY delivery_id LIMIT ?`)
    .bind(state.cursor ?? "", terminalCutoff, SQL_RETENTION_QUOTA)
    .all<{ readonly delivery_id: string }>();
  const complete = rows.results.length < SQL_RETENTION_QUOTA;
  const next = complete ? null : rows.results.at(-1)!.delivery_id;
  await env.DB.batch([
    ...rows.results.map((row) => env.DB.prepare(`DELETE FROM github_webhook_deliveries
      WHERE delivery_id=? AND outcome IN ('accepted','failed') AND updated_at<=?
        AND NOT EXISTS (
          SELECT 1 FROM github_installation_claim_proofs
          WHERE delivery_id=github_webhook_deliveries.delivery_id
        )`)
      .bind(row.delivery_id, terminalCutoff)),
    cursorUpdate(env, "github-webhook-deliveries", next, complete, now),
  ]);
  return rows.results.length;
}

async function retainOutbox(env: WasmOjWorkerEnv, now: Date): Promise<number> {
  const state = await retentionCursor(env, "settled-outbox", now);
  if (!state) return 0;
  const terminalCutoff = cutoff(now, 30 * DAY_MS);
  const rows = await env.DB.prepare(`SELECT id FROM workflow_outbox
    WHERE id>? AND state IN ('delivered','cancelled','failed')
      AND settled_at<=?
    ORDER BY id LIMIT ?`)
    .bind(state.cursor ?? "", terminalCutoff, SQL_RETENTION_QUOTA)
    .all<{ readonly id: string }>();
  const complete = rows.results.length < SQL_RETENTION_QUOTA;
  const next = complete ? null : rows.results.at(-1)!.id;
  await env.DB.batch([
    ...rows.results.map((row) => env.DB.prepare(`DELETE FROM workflow_outbox
      WHERE id=? AND state IN ('delivered','cancelled','failed')
        AND settled_at<=?`).bind(row.id, terminalCutoff)),
    cursorUpdate(env, "settled-outbox", next, complete, now),
  ]);
  return rows.results.length;
}

interface AuthRetentionRow {
  readonly sort_key: string;
  readonly table_kind: "session" | "oauth" | "installation-state" | "claim";
  readonly record_key: string;
}

async function retainExpiredAuth(env: WasmOjWorkerEnv, now: Date): Promise<number> {
  const state = await retentionCursor(env, "expired-auth", now);
  if (!state) return 0;
  const expiryCutoff = cutoff(now, DAY_MS);
  const rows = await env.DB.prepare(`SELECT sort_key, table_kind, record_key FROM (
      SELECT '0:' || token_hash AS sort_key, 'session' AS table_kind, token_hash AS record_key
        FROM sessions WHERE expires_at<=?
      UNION ALL
      SELECT '1:' || state_hash AS sort_key, 'oauth' AS table_kind, state_hash AS record_key
        FROM oauth_states WHERE expires_at<=?
      UNION ALL
      SELECT '2:' || state_hash AS sort_key, 'installation-state' AS table_kind, state_hash AS record_key
        FROM github_installation_states WHERE expires_at<=?
      UNION ALL
      SELECT '3:' || printf('%020d', installation_id) AS sort_key, 'claim' AS table_kind,
             CAST(installation_id AS TEXT) AS record_key
        FROM github_installation_claim_proofs WHERE expires_at<=?
    ) WHERE sort_key>? ORDER BY sort_key LIMIT ?`)
    .bind(expiryCutoff, expiryCutoff, expiryCutoff, expiryCutoff, state.cursor ?? "", SQL_RETENTION_QUOTA)
    .all<AuthRetentionRow>();
  const complete = rows.results.length < SQL_RETENTION_QUOTA;
  const next = complete ? null : rows.results.at(-1)!.sort_key;
  const statements = rows.results.map((row) => {
    if (row.table_kind === "session") {
      return env.DB.prepare("DELETE FROM sessions WHERE token_hash=? AND expires_at<=?")
        .bind(row.record_key, expiryCutoff);
    }
    if (row.table_kind === "oauth") {
      return env.DB.prepare("DELETE FROM oauth_states WHERE state_hash=? AND expires_at<=?")
        .bind(row.record_key, expiryCutoff);
    }
    if (row.table_kind === "installation-state") {
      return env.DB.prepare("DELETE FROM github_installation_states WHERE state_hash=? AND expires_at<=?")
        .bind(row.record_key, expiryCutoff);
    }
    return env.DB.prepare("DELETE FROM github_installation_claim_proofs WHERE installation_id=? AND expires_at<=?")
      .bind(Number(row.record_key), expiryCutoff);
  });
  await env.DB.batch([
    ...statements,
    cursorUpdate(env, "expired-auth", next, complete, now),
  ]);
  return rows.results.length;
}

interface DeletingJudgePackage {
  readonly sha256: string;
  readonly delete_token: string;
}

interface OrphanR2Cursor {
  readonly r2: string | null;
  readonly scanComplete: boolean;
}

function parseOrphanCursor(value: string | null): OrphanR2Cursor {
  if (value === null) return { r2: null, scanComplete: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Orphan judge package cursor is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Orphan judge package cursor is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["r2", "scanComplete"].includes(key))
    || (record.r2 !== null && typeof record.r2 !== "string")
    || typeof record.scanComplete !== "boolean"
  ) throw new Error("Orphan judge package cursor is invalid.");
  return { r2: record.r2 as string | null, scanComplete: record.scanComplete };
}

function activePublishReferenceSql(alias: string): string {
  return `EXISTS (
    SELECT 1 FROM collection_revision_problems AS revision_problems
    JOIN catalog_publish_jobs AS publish_jobs
      ON publish_jobs.collection_revision_id=revision_problems.collection_revision_id
    WHERE revision_problems.judge_package_sha256=${alias}.sha256
      AND publish_jobs.state IN ('queued','materializing')
  )`;
}

async function claimExpiredStagingPackage(
  env: WasmOjWorkerEnv,
  now: Date,
): Promise<DeletingJudgePackage | null> {
  const timestamp = now.toISOString();
  const token = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1_000).toISOString();
  return env.DB.prepare(`UPDATE judge_packages
      SET state='deleting', delete_token=?, lease_expires_at=?, last_error=NULL
    WHERE sha256=(
      SELECT candidate.sha256 FROM judge_packages AS candidate
      WHERE (
          candidate.state='staging' AND candidate.staged_at<=?
          AND NOT ${activePublishReferenceSql("candidate")}
        ) OR (
          candidate.state='deleting' AND candidate.lease_expires_at<=?
        )
      ORDER BY candidate.staged_at, candidate.sha256 LIMIT 1
    )
    RETURNING sha256, delete_token`)
    .bind(token, leaseExpiresAt, cutoff(now, DAY_MS), timestamp)
    .first<DeletingJudgePackage>();
}

async function deleteFencedJudgePackage(
  env: WasmOjWorkerEnv,
  claim: DeletingJudgePackage,
): Promise<boolean> {
  const key = `judge-packages/v2/${claim.sha256}`;
  try {
    await env.JUDGE_BUCKET.delete(key);
    if (await env.JUDGE_BUCKET.head(key)) throw new Error("Judge package GC read-back found a deleted object.");
    const deleted = await env.DB.prepare(`DELETE FROM judge_packages
      WHERE sha256=? AND state='deleting' AND delete_token=?`)
      .bind(claim.sha256, claim.delete_token).run();
    if (deleted.meta.changes !== 1) throw new Error("Judge package GC lost its per-digest deletion fence.");
    return true;
  } catch (error) {
    await env.DB.prepare(`UPDATE judge_packages
        SET last_error=?
      WHERE sha256=? AND state='deleting' AND delete_token=?`)
      .bind(safeError(error), claim.sha256, claim.delete_token).run();
    return false;
  }
}

async function claimR2OnlyJudgePackage(
  env: WasmOjWorkerEnv,
  object: R2Object,
  digest: string,
  now: Date,
): Promise<DeletingJudgePackage | null> {
  if (object.size < 1 || object.size > JUDGE_PACKAGE_MAX_BYTES) return null;
  const token = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1_000).toISOString();
  const inserted = await env.DB.prepare(`INSERT INTO judge_packages
      (sha256, bytes, state, staged_at, delete_token, lease_expires_at, last_error)
    VALUES (?, ?, 'deleting', ?, ?, ?, NULL)
    ON CONFLICT(sha256) DO NOTHING`)
    .bind(digest, object.size, object.uploaded.toISOString(), token, leaseExpiresAt).run();
  return inserted.meta.changes === 1 ? { sha256: digest, delete_token: token } : null;
}

async function hasPendingPackageDeletion(env: WasmOjWorkerEnv, now: Date): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS pending FROM judge_packages AS candidate
    WHERE (
        candidate.state='staging' AND candidate.staged_at<=?
        AND NOT ${activePublishReferenceSql("candidate")}
      ) OR candidate.state='deleting'
    LIMIT 1`).bind(cutoff(now, DAY_MS)).first<{ readonly pending: number }>();
  return row !== null;
}

async function retainOrphanJudgePackages(env: WasmOjWorkerEnv, now: Date): Promise<number> {
  const state = await retentionCursor(env, "orphan-judge-packages", now);
  if (!state) return 0;
  const cursor = parseOrphanCursor(state.cursor);
  let deleted = 0;
  for (let iteration = 0; iteration < STAGING_PACKAGE_QUOTA; iteration += 1) {
    const claim = await claimExpiredStagingPackage(env, now);
    if (!claim) break;
    if (await deleteFencedJudgePackage(env, claim)) deleted += 1;
  }

  let r2Cursor: string | null = cursor.r2;
  let scanComplete = cursor.scanComplete;
  if (!scanComplete) {
    const page = await env.JUDGE_BUCKET.list({
      prefix: "judge-packages/v2/",
      cursor: r2Cursor ?? undefined,
      limit: R2_RETENTION_QUOTA,
    });
    for (const object of page.objects) {
      const match = JUDGE_PACKAGE_KEY.exec(object.key);
      if (!match || object.uploaded.getTime() > now.getTime() - DAY_MS) continue;
      const claim = await claimR2OnlyJudgePackage(env, object, match[1]!, now);
      if (claim && await deleteFencedJudgePackage(env, claim)) deleted += 1;
    }
    r2Cursor = page.truncated ? page.cursor : null;
    scanComplete = !page.truncated;
  }

  const pending = await hasPendingPackageDeletion(env, now);
  const complete = scanComplete && !pending;
  const nextCursor = complete ? null : JSON.stringify({ r2: r2Cursor, scanComplete });
  await env.DB.batch([cursorUpdate(env, "orphan-judge-packages", nextCursor, complete, now)]);
  return deleted;
}

export async function reconcileRetention(env: WasmOjWorkerEnv, now: Date): Promise<RetentionCounts> {
  // Every class owns its cursor and quota. A large event backlog cannot delay
  // authentication or webhook cleanup, and missed cron ticks resume naturally.
  const submissionEvents = await reconcilePhase("submission-event-retention", 0, () => retainSubmissionEvents(env, now));
  const catalogJobs = await reconcilePhase("catalog-job-retention", 0, () => retainCatalogJobs(env, now));
  const auth = await reconcilePhase("auth-retention", 0, () => retainExpiredAuth(env, now));
  const webhooks = await reconcilePhase("webhook-retention", 0, () => retainWebhookDeliveries(env, now));
  const outbox = await reconcilePhase("workflow-outbox-retention", 0, () => retainOutbox(env, now));
  const orphanJudgePackages = await reconcilePhase("orphan-judge-package-retention", 0, () => retainOrphanJudgePackages(env, now));
  return { submissionEvents, catalogJobs, webhooks, outbox, auth, orphanJudgePackages };
}

export async function reconcile(env: WasmOjWorkerEnv, now = new Date()): Promise<{
  readonly dispatched: { readonly submission: number; readonly catalog: number };
  readonly outbox: number;
  readonly workflowFailures: number;
  readonly admissions: number;
  readonly erasures: number;
  readonly tombstones: number;
  readonly rejudge: {
    readonly materialized: number;
    readonly settled: number;
    readonly repaired: number;
    readonly refreshed: number;
  };
  readonly retention: RetentionCounts;
}> {
  const erasures = await reconcilePhase("account-erasure-phase", 0, () => reconcileAccountErasures(env));
  const tombstones = await reconcilePhase("source-tombstone-phase", 0, () => reconcileSourceTombstones(env, now));
  const admissions = await reconcilePhase("submission-admission-phase", 0, () => reconcileStrandedAdmissions(env, now));
  const outbox = await reconcilePhase("workflow-outbox-phase", 0, () => reconcilePendingOutbox(env));
  const workflowFailures = await reconcilePhase(
    "submission-workflow-terminal-phase",
    0,
    () => reconcileTerminalWorkflowFailures(env, now),
  );
  const materialized = await reconcilePhase(
    "rejudge-materialization-phase",
    0,
    () => materializePendingRejudgeBatches(env),
  );
  const settled = await reconcilePhase("rejudge-result-phase", 0, () => settleTerminalRejudgeJobs(env));
  const repaired = await reconcilePhase("rejudge-repair-phase", 0, () => repairDispatchedRejudgeJobs(env));
  const refreshed = await reconcilePhase("rejudge-refresh-phase", 0, () => refreshRejudgeBatches(env));
  const submission = await reconcilePhase("submission-dispatch-phase", 0, () => dispatchSubmissionJobs(env));
  const catalog = await reconcilePhase("catalog-dispatch-phase", 0, () => dispatchCatalogJobs(env));
  const retention = await reconcileRetention(env, now);
  return {
    dispatched: { submission, catalog },
    outbox,
    workflowFailures,
    admissions,
    erasures,
    tombstones,
    rejudge: { materialized, settled, repaired, refreshed },
    retention,
  };
}
