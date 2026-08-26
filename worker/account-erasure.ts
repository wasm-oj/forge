import { requireBrowserMutationSession } from "./auth";
import { hmacSha256Hex, sha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";
import { deleteGithubInstallationClaimsForUser } from "./github-installation-claims";
import { githubAppJwt } from "./github";
import { cookieHeader, jsonResponse } from "./http";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { tombstoneSubmissionSource } from "./submissions";
import { workflowInstanceNotFound, workflowStatusOrUnknown } from "./workflow-instance-status";

interface ErasureJobRow {
  readonly id: string;
  readonly user_id: string;
  readonly anonymous_user_id: string;
  readonly status: "queued" | "revoking" | "deleting-sources" | "anonymizing" | "completed" | "failed";
  readonly requested_at: string;
  readonly receipt_sha256: string | null;
}

interface SourceRow {
  readonly id: string;
  readonly state: "reserved" | "ready" | "erasing" | "erased";
}

const TERMINAL_WORKFLOW_STATES = new Set(["complete", "errored", "terminated", "unknown"]);
const encoder = new TextEncoder();

export const CANCEL_ERASURE_SUBMISSIONS_SQL = `UPDATE submissions
   SET state='cancelled', verdict='cancelled', score=COALESCE(score, 0),
       fully_passed_cases=COALESCE(fully_passed_cases, 0), updated_at=?,
       completed_at=COALESCE(completed_at, ?), visibility='private'
 WHERE user_id IN (?, ?)
   AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')`;

export const CANCEL_ERASURE_ATTEMPTS_SQL = `UPDATE submission_attempts
   SET state='cancelled', finished_at=COALESCE(finished_at, ?), failure_code='account-erasure'
 WHERE submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?))
   AND state IN ('created','running')`;

export const RECORD_ERASURE_CANCELLATION_EVENTS_SQL = `INSERT INTO submission_events
  (submission_id, event_key, payload_json, created_at)
SELECT id, 'account-erasure-cancelled', '{"kind":"state","state":"cancelled"}', ?
  FROM submissions
 WHERE user_id IN (?, ?) AND state='cancelled'
ON CONFLICT(submission_id, event_key) DO NOTHING`;

export const CANCEL_ERASURE_REJUDGE_WORK_SQL = `UPDATE rejudge_jobs
   SET state='cancelled', result_state='cancelled', updated_at=?
 WHERE user_id IN (?, ?) AND state IN ('pending','dispatched')`;

export const CANCEL_ERASURE_OUTBOX_SQL = `UPDATE workflow_outbox
   SET state='cancelled', settled_at=?, last_error='account-erasure', updated_at=?
 WHERE state='pending'
   AND submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?))`;

export const ACCOUNT_ERASURE_WORKFLOW_SUBMISSION_IDS_SQL = `SELECT DISTINCT submissions.id
  FROM submissions
  JOIN submission_attempts ON submission_attempts.submission_id=submissions.id
 WHERE submissions.user_id IN (?, ?)
   AND submission_attempts.state='cancelled'
   AND submission_attempts.failure_code='account-erasure'
 ORDER BY submissions.id`;

export const BEGIN_SOURCE_ERASURE_SQL = `UPDATE submission_sources
   SET state='erasing', content_sha256=NULL, bytes=NULL,
       erasure_requested_at=COALESCE(erasure_requested_at, ?),
       erasure_next_attempt_at=COALESCE(erasure_next_attempt_at, ?),
       erasure_last_error=NULL
 WHERE owner_user_id=? AND state IN ('reserved','ready','erasing')`;

function cancellationStatements(
  env: WasmOjWorkerEnv,
  userId: string,
  anonymousUserId: string,
  now: string,
): D1PreparedStatement[] {
  return [
    env.DB.prepare(CANCEL_ERASURE_SUBMISSIONS_SQL).bind(now, now, userId, anonymousUserId),
    env.DB.prepare(CANCEL_ERASURE_ATTEMPTS_SQL).bind(now, userId, anonymousUserId),
    env.DB.prepare(RECORD_ERASURE_CANCELLATION_EVENTS_SQL).bind(now, userId, anonymousUserId),
    env.DB.prepare(CANCEL_ERASURE_REJUDGE_WORK_SQL).bind(now, userId, anonymousUserId),
    env.DB.prepare(CANCEL_ERASURE_OUTBOX_SQL).bind(now, now, userId, anonymousUserId),
    env.DB.prepare(`UPDATE catalog_sync_jobs
        SET state='running', started_at=?, updated_at=?
      WHERE requested_by IN (?, ?) AND state='queued'`)
      .bind(now, now, userId, anonymousUserId),
    env.DB.prepare(`UPDATE catalog_sync_jobs
        SET state='failed', error_code='account-erasure',
            finished_at=?, updated_at=?
      WHERE requested_by IN (?, ?) AND state='running'`)
      .bind(now, now, userId, anonymousUserId),
    env.DB.prepare(`UPDATE rejudge_batches
        SET state='cancelled', cancel_requested_at=?, failure_code='account-erasure', updated_at=?
      WHERE requested_by IN (?, ?) AND state IN ('queued','running','ready')`)
      .bind(now, now, userId, anonymousUserId),
    env.DB.prepare(`UPDATE workflow_outbox
      SET state='cancelled', settled_at=?, last_error='account-erasure', updated_at=?
      WHERE state='pending' AND (
        catalog_sync_job_id IN (
          SELECT id FROM catalog_sync_jobs WHERE requested_by IN (?, ?)
        )
      )`).bind(now, now, userId, anonymousUserId),
    env.DB.prepare("DELETE FROM formal_risk_allowances WHERE user_id IN (?, ?)")
      .bind(userId, anonymousUserId),
  ];
}

async function cancelOwnerWork(env: WasmOjWorkerEnv, job: ErasureJobRow, now: string): Promise<void> {
  const results = await env.DB.batch(cancellationStatements(env, job.user_id, job.anonymous_user_id, now));
  if (results.some((result) => !result.success)) throw new Error("Account erasure cancellation transaction failed.");
}

async function revokeGithubInstallations(env: WasmOjWorkerEnv, userId: string): Promise<void> {
  const installations = await env.DB.prepare(
    "SELECT installation_id FROM github_installations WHERE installed_by_user_id=? ORDER BY installation_id",
  ).bind(userId).all<{ readonly installation_id: number }>();
  for (const row of installations.results) {
    if (!Number.isSafeInteger(row.installation_id) || row.installation_id < 1) {
      throw new Error("GitHub installation identity is invalid.");
    }
    const response = await fetch(`https://api.github.com/app/installations/${row.installation_id}`, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${await githubAppJwt(env)}`,
        "user-agent": "wasm-oj",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "manual",
    });
    if (response.status !== 204 && response.status !== 404) {
      throw new Error(`GitHub installation revocation failed with HTTP ${response.status}.`);
    }
  }
}

async function ownedSubmissionIds(env: WasmOjWorkerEnv, job: ErasureJobRow): Promise<readonly string[]> {
  const rows = await env.DB.prepare(ACCOUNT_ERASURE_WORKFLOW_SUBMISSION_IDS_SQL)
    .bind(job.user_id, job.anonymous_user_id).all<{ readonly id: string }>();
  return rows.results.map((row) => row.id);
}

async function stopSubmissionWorkflows(env: WasmOjWorkerEnv, submissionIds: readonly string[]): Promise<void> {
  for (const submissionId of submissionIds) {
    let status = await workflowStatusOrUnknown(env.SUBMISSION_WORKFLOW, submissionId);
    if (TERMINAL_WORKFLOW_STATES.has(status.status)) continue;
    try {
      await (await env.SUBMISSION_WORKFLOW.get(submissionId)).terminate();
    } catch (error) {
      if (workflowInstanceNotFound(error)) continue;
      throw error;
    }
    status = await workflowStatusOrUnknown(env.SUBMISSION_WORKFLOW, submissionId);
    if (!TERMINAL_WORKFLOW_STATES.has(status.status)) {
      throw new Error("Submission Workflow did not terminate before account erasure.");
    }
  }
}

async function ownedSources(env: WasmOjWorkerEnv, job: ErasureJobRow): Promise<readonly SourceRow[]> {
  const rows = await env.DB.prepare(`SELECT DISTINCT sources.id, sources.state
      FROM submissions
      JOIN submission_sources AS sources ON sources.id=submissions.source_id
     WHERE submissions.user_id IN (?, ?)
     ORDER BY sources.id`)
    .bind(job.user_id, job.anonymous_user_id).all<SourceRow>();
  return rows.results;
}

async function prepareSourcesForErasure(env: WasmOjWorkerEnv, job: ErasureJobRow, now: string): Promise<void> {
  const result = await env.DB.prepare(BEGIN_SOURCE_ERASURE_SQL)
    .bind(now, now, job.user_id).run();
  if (!result.success) throw new Error("Submission source erasure transaction failed.");
}

async function tombstoneOwnedSources(env: WasmOjWorkerEnv, job: ErasureJobRow): Promise<readonly SourceRow[]> {
  const sources = await ownedSources(env, job);
  for (const source of sources) {
    if (source.state !== "erased") await tombstoneSubmissionSource(env, source.id);
  }
  if (sources.length > 0) {
    const incomplete = await env.DB.prepare(`SELECT COUNT(*) AS count
        FROM submission_sources
       WHERE id IN (
         SELECT DISTINCT source_id FROM submissions WHERE user_id IN (?, ?)
      ) AND state<>'erased'`)
      .bind(job.user_id, job.anonymous_user_id).first<{ readonly count: number }>();
    if ((incomplete?.count ?? 0) !== 0) throw new Error("Submission source erasure did not reach its D1 fence.");
  }
  return sources;
}

function receiptJson(job: ErasureJobRow, sourceCount: number): string {
  return `${JSON.stringify({
    anonymousUserId: job.anonymous_user_id,
    erasedAt: job.requested_at,
    jobId: job.id,
    schema: "wasm-oj-platform/account-erasure-receipt/v2",
    submissionSourcesTombstoned: sourceCount,
  })}\n`;
}

async function finalizeAccountErasure(
  env: WasmOjWorkerEnv,
  job: ErasureJobRow,
  sourceCount: number,
): Promise<string> {
  const receipt = receiptJson(job, sourceCount);
  const receiptSha256 = await sha256Hex(encoder.encode(receipt));
  const originalHash = await hmacSha256Hex(env.ACCOUNT_ERASURE_HMAC_SECRET, encoder.encode(job.user_id));
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO users (id, created_at, updated_at, status, erasure_epoch) VALUES (?, ?, ?, 'suspended', 0)")
      .bind(job.anonymous_user_id, job.requested_at, now),
    env.DB.prepare(`UPDATE submissions
        SET user_id=?, entry_path=NULL, visibility='private'
      WHERE user_id=?`).bind(job.anonymous_user_id, job.user_id),
    env.DB.prepare("UPDATE submission_attempts SET token_hash='erased' WHERE submission_id IN (SELECT id FROM submissions WHERE user_id=?)")
      .bind(job.anonymous_user_id),
    env.DB.prepare("DELETE FROM submission_idempotency WHERE user_id IN (?, ?)")
      .bind(job.user_id, job.anonymous_user_id),
    env.DB.prepare("DELETE FROM contest_participants WHERE user_id=?").bind(job.user_id),
    env.DB.prepare("UPDATE catalogs SET organizer_user_id=? WHERE organizer_user_id=?")
      .bind(job.anonymous_user_id, job.user_id),
    env.DB.prepare("UPDATE catalog_sync_jobs SET requested_by=? WHERE requested_by=?")
      .bind(job.anonymous_user_id, job.user_id),
    env.DB.prepare("UPDATE catalog_deployments SET synced_by=? WHERE synced_by=?")
      .bind(job.anonymous_user_id, job.user_id),
    env.DB.prepare("UPDATE rejudge_batches SET requested_by=? WHERE requested_by=?")
      .bind(job.anonymous_user_id, job.user_id),
    env.DB.prepare("DELETE FROM organizer_applications WHERE user_id=?").bind(job.user_id),
    env.DB.prepare("UPDATE organizer_applications SET reviewed_by=NULL WHERE reviewed_by=?").bind(job.user_id),
    env.DB.prepare("UPDATE user_roles SET granted_by=NULL WHERE granted_by=?").bind(job.user_id),
    env.DB.prepare("DELETE FROM profiles WHERE user_id=?").bind(job.user_id),
    env.DB.prepare("DELETE FROM github_identities WHERE user_id=?").bind(job.user_id),
    env.DB.prepare(`UPDATE github_repositories
        SET owner_login='erased-owner-' || github_repository_id,
            name='erased-repository-' || github_repository_id,
            authorization_status='removed', updated_at=?
      WHERE installation_id IN (
        SELECT installation_id FROM github_installations WHERE installed_by_user_id=?
      )`).bind(now, job.user_id),
    env.DB.prepare(`UPDATE github_installations
        SET account_github_id=-installation_id,
            account_login='erased-installation-' || installation_id,
            installed_by_user_id=NULL, status='removed', updated_at=?
      WHERE installed_by_user_id=?`).bind(now, job.user_id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(job.user_id),
    env.DB.prepare("DELETE FROM cli_login_flows WHERE approved_user_id=?").bind(job.user_id),
    env.DB.prepare("DELETE FROM github_installation_states WHERE user_id=?").bind(job.user_id),
    env.DB.prepare("DELETE FROM user_roles WHERE user_id=?").bind(job.user_id),
    env.DB.prepare("DELETE FROM users WHERE id=?").bind(job.user_id),
    env.DB.prepare(`INSERT INTO erased_user_tombstones
        (anonymous_user_id, original_user_sha256, erased_at, receipt_json, receipt_sha256)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(job.anonymous_user_id, originalHash, job.requested_at, receipt, receiptSha256),
    env.DB.prepare(`UPDATE account_erasure_jobs
        SET status='completed', receipt_json=?, receipt_sha256=?, completed_at=?,
            updated_at=?, last_error=NULL
      WHERE id=? AND status='anonymizing'`)
      .bind(receipt, receiptSha256, now, now, job.id),
  ]);
  if (results.some((result) => !result.success)) throw new Error("Account anonymization transaction failed.");

  const postcondition = await env.DB.prepare(`SELECT
      EXISTS(SELECT 1 FROM users WHERE id=?)
      + EXISTS(SELECT 1 FROM submissions WHERE user_id=?)
      + EXISTS(SELECT 1 FROM submission_sources WHERE owner_user_id=?)
      + NOT EXISTS(SELECT 1 FROM account_erasure_jobs WHERE id=? AND status='completed' AND receipt_sha256=?)
      + NOT EXISTS(SELECT 1 FROM erased_user_tombstones WHERE anonymous_user_id=? AND receipt_sha256=?)
      AS violations`)
    .bind(
      job.user_id, job.user_id, job.user_id, job.id, receiptSha256,
      job.anonymous_user_id, receiptSha256,
    ).first<{ readonly violations: number }>();
  if ((postcondition?.violations ?? 1) !== 0) throw new Error("Account erasure postcondition failed.");
  return receiptSha256;
}

export async function resumeAccountErasure(
  env: WasmOjWorkerEnv,
  jobId: string,
): Promise<{ readonly completed: boolean; readonly anonymousUserId: string; readonly receiptSha256?: string }> {
  const job = await env.DB.prepare(`SELECT id, user_id, anonymous_user_id, status, requested_at, receipt_sha256
      FROM account_erasure_jobs WHERE id=?`)
    .bind(jobId).first<ErasureJobRow>();
  if (!job) throw new Error("Account erasure job does not exist.");
  if (job.status === "completed") {
    if (!job.receipt_sha256) throw new Error("Completed account erasure is missing its D1 receipt.");
    return { completed: true, anonymousUserId: job.anonymous_user_id, receiptSha256: job.receipt_sha256 };
  }

  try {
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE account_erasure_jobs SET status='deleting-sources', last_error=NULL, updated_at=? WHERE id=? AND status<>'completed'")
      .bind(now, job.id).run();
    await cancelOwnerWork(env, job, now);
    const submissions = await ownedSubmissionIds(env, job);
    await stopSubmissionWorkflows(env, submissions);
    await cancelOwnerWork(env, job, new Date().toISOString());
    const deletingAt = new Date().toISOString();
    await prepareSourcesForErasure(env, job, deletingAt);
    const sources = await tombstoneOwnedSources(env, job);

    const revokingAt = new Date().toISOString();
    await env.DB.prepare("UPDATE account_erasure_jobs SET status='revoking', updated_at=? WHERE id=?")
      .bind(revokingAt, job.id).run();
    await revokeGithubInstallations(env, job.user_id);
    await deleteGithubInstallationClaimsForUser(env.DB, job.user_id);

    const anonymizingAt = new Date().toISOString();
    await env.DB.prepare("UPDATE account_erasure_jobs SET status='anonymizing', updated_at=? WHERE id=?")
      .bind(anonymizingAt, job.id).run();
    const receiptSha256 = await finalizeAccountErasure(env, job, sources.length);
    return { completed: true, anonymousUserId: job.anonymous_user_id, receiptSha256 };
  } catch (error) {
    await env.DB.prepare("UPDATE account_erasure_jobs SET last_error='erasure-retry-required', updated_at=? WHERE id=? AND status<>'completed'")
      .bind(new Date().toISOString(), job.id).run();
    throw error;
  }
}

function clearSessionHeaders(): Headers {
  const headers = new Headers();
  headers.append("set-cookie", cookieHeader("wasm_oj_session", "", { httpOnly: true, maxAge: 0, sameSite: "Lax" }));
  headers.append("set-cookie", cookieHeader("wasm_oj_csrf", "", { maxAge: 0, sameSite: "Strict" }));
  return headers;
}

export async function eraseAccount(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireBrowserMutationSession(request, env);
  await requireFormalMutationsEnabled(env, request);
  if (env.ACCOUNT_ERASURE_HMAC_SECRET.length < 32) throw new Error("Account erasure secret is not configured.");
  const originalHash = await hmacSha256Hex(env.ACCOUNT_ERASURE_HMAC_SECRET, encoder.encode(session.userId));
  const anonymousUserId = `erased-${originalHash.slice(0, 32)}`;
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO account_erasure_jobs
        (id, user_id, anonymous_user_id, status, requested_at, updated_at)
      SELECT ?, id, ?, 'revoking', ?, ? FROM users
       WHERE id=? AND status='active'`)
      .bind(jobId, anonymousUserId, now, now, session.userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(session.userId),
    env.DB.prepare("DELETE FROM cli_login_flows WHERE approved_user_id=?").bind(session.userId),
    env.DB.prepare("DELETE FROM user_roles WHERE user_id=?").bind(session.userId),
    env.DB.prepare("UPDATE github_installations SET status='removed', updated_at=? WHERE installed_by_user_id=?")
      .bind(now, session.userId),
    env.DB.prepare("UPDATE users SET status='suspended', erasure_epoch=erasure_epoch+1, updated_at=? WHERE id=? AND status='active'")
      .bind(now, session.userId),
    ...cancellationStatements(env, session.userId, anonymousUserId, now),
    env.DB.prepare(BEGIN_SOURCE_ERASURE_SQL).bind(now, now, session.userId),
  ]);
  if (results.some((result) => !result.success)) throw new Error("Account erasure transaction failed.");
  const job = await env.DB.prepare("SELECT id FROM account_erasure_jobs WHERE id=? AND user_id=?")
    .bind(jobId, session.userId).first<{ readonly id: string }>();
  if (!job) throw new Error("Account erasure lost its admission fence.");

  const result = await resumeAccountErasure(env, jobId);
  return jsonResponse(
    { erased: true, anonymousUserId, receiptSha256: result.receiptSha256 },
    200,
    clearSessionHeaders(),
  );
}
