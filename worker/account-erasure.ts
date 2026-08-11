import { requireMutationSession } from "./auth";
import { hmacSha256Hex, sha256Hex } from "./crypto";
import type { ForgeWorkerEnv } from "./env";
import { githubAppJwt } from "./github";
import { cookieHeader, jsonResponse } from "./http";
import { putImmutableMirroredObject } from "./immutable-r2";
import { deleteGithubInstallationClaimsForUser } from "./github-installation-claims";
import { cleanupFormalSubmissionAdmissionsForUser } from "./formal-admissions";
import { deleteMirroredAttemptAudit } from "./submission-audits";

interface ErasureJobRow {
  readonly id: string;
  readonly user_id: string;
  readonly anonymous_user_id: string;
  readonly status: string;
  readonly requested_at: string;
}

interface SourceRow {
  readonly id: string;
  readonly user_id: string;
  readonly source_r2_key: string;
  readonly managed_problem_version_id: string;
  readonly contest_id: string | null;
  readonly visibility: string;
  readonly source_erased_at: string | null;
}

interface ErasureFenceRow {
  readonly owner_user_id: string;
  readonly erasure_job_id: string;
  readonly anonymous_user_id: string;
}

const TERMINAL_WORKFLOW_STATES = new Set(["complete", "errored", "terminated", "unknown"]);
const ERASED_SOURCE_KEY_PREFIX = "erased-source-tombstones/v1/";
const MAX_ERASURE_DRAIN_PASSES = 8;
const encoder = new TextEncoder();

export const UPSERT_SUBMISSION_OWNER_ERASURE_FENCE_SQL = "INSERT INTO submission_owner_erasure_fences (owner_user_id, erasure_job_id, anonymous_user_id, fenced_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_user_id) DO UPDATE SET anonymous_user_id=excluded.anonymous_user_id, fenced_at=MIN(submission_owner_erasure_fences.fenced_at, excluded.fenced_at) WHERE submission_owner_erasure_fences.erasure_job_id=excluded.erasure_job_id AND submission_owner_erasure_fences.anonymous_user_id=excluded.anonymous_user_id";

export const CANCEL_ERASURE_SUBMISSIONS_SQL = "UPDATE submissions SET state='cancelled', updated_at=?, completed_at=COALESCE(completed_at, ?) WHERE user_id IN (?, ?) AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')";

export const CANCEL_ERASURE_ATTEMPTS_SQL = "UPDATE submission_attempts SET state='cancelled', finished_at=COALESCE(finished_at, ?) WHERE submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?)) AND state IN ('created','running')";

export const RECORD_ERASURE_CANCELLATION_EVENTS_SQL = "INSERT INTO submission_events (submission_id, event_key, payload_json, created_at) SELECT id, 'account-erasure-cancelled', '{\"kind\":\"state\",\"state\":\"cancelled\"}', ? FROM submissions WHERE user_id IN (?, ?) AND state='cancelled' ON CONFLICT(submission_id, event_key) DO NOTHING";

export const CANCEL_ERASURE_REJUDGE_WORK_SQL = "UPDATE rejudge_jobs SET state=CASE WHEN state IN ('pending','dispatched') THEN 'cancelled' ELSE state END, result_state=CASE WHEN state IN ('pending','dispatched') THEN 'cancelled' ELSE result_state END, erasure_excluded_at=CASE WHEN state IN ('pending','dispatched') THEN COALESCE(erasure_excluded_at, ?) ELSE erasure_excluded_at END, workflow_payload_json='{}', updated_at=? WHERE old_submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?)) OR new_submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?))";

export const SCRUB_ERASURE_SUBMISSION_OUTBOX_SQL = "UPDATE submission_outbox SET delivered_at=COALESCE(delivered_at, ?), payload_json='{}', last_error=CASE WHEN delivered_at IS NULL THEN 'account-erasure' ELSE last_error END WHERE submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?))";

export const SCRUB_ERASURE_REJUDGE_RESULT_OUTBOX_SQL = "UPDATE rejudge_result_outbox SET delivered_at=COALESCE(delivered_at, ?), last_error=CASE WHEN delivered_at IS NULL THEN 'account-erasure' ELSE last_error END WHERE old_submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?)) OR new_submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?))";

export async function erasedSourceTombstoneKey(secret: string, submissionId: string): Promise<string> {
  if (secret.length < 32) throw new Error("Account erasure secret is not configured.");
  if (!submissionId || submissionId.length > 128) throw new TypeError("Submission identity is invalid.");
  const digest = await hmacSha256Hex(secret, encoder.encode(`forge-erased-submission-source-v1\0${submissionId}`));
  return `${ERASED_SOURCE_KEY_PREFIX}${digest}`;
}

async function revokeGithubInstallations(env: ForgeWorkerEnv, userId: string): Promise<void> {
  const installations = await env.CORE_DB.prepare(
    "SELECT installation_id FROM github_installations WHERE installed_by_user_id=? ORDER BY installation_id",
  ).bind(userId).all<{ installation_id: number }>();
  for (const row of installations.results) {
    if (!Number.isSafeInteger(row.installation_id) || row.installation_id < 1) throw new Error("GitHub installation identity is invalid.");
    const response = await fetch(`https://api.github.com/app/installations/${row.installation_id}`, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${await githubAppJwt(env)}`,
        "user-agent": "wasm-oj-forge",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "manual",
    });
    // GitHub returns 404 when the installation was already removed by its
    // owner. Both outcomes prove that no installation token can be minted.
    if (response.status !== 204 && response.status !== 404) {
      throw new Error(`GitHub installation revocation failed with HTTP ${response.status}.`);
    }
  }
}

async function submissionRows(env: ForgeWorkerEnv, userId: string, anonymousUserId: string): Promise<SourceRow[]> {
  const sources: SourceRow[] = [];
  let cursor = "";
  for (;;) {
    const page = await env.SUBMISSIONS_DB.prepare("SELECT id, user_id, source_r2_key, managed_problem_version_id, contest_id, visibility, source_erased_at FROM submissions WHERE user_id IN (?, ?) AND id>? ORDER BY id LIMIT 100")
      .bind(userId, anonymousUserId, cursor).all<SourceRow>();
    if (page.results.length === 0) break;
    sources.push(...page.results);
    cursor = page.results.at(-1)?.id ?? cursor;
  }
  return sources;
}

async function fenceAndCancelSubmissionOwner(env: ForgeWorkerEnv, job: ErasureJobRow, now: string): Promise<void> {
  await env.SUBMISSIONS_DB.batch([
    env.SUBMISSIONS_DB.prepare(UPSERT_SUBMISSION_OWNER_ERASURE_FENCE_SQL)
      .bind(job.user_id, job.id, job.anonymous_user_id, job.requested_at),
    env.SUBMISSIONS_DB.prepare(UPSERT_SUBMISSION_OWNER_ERASURE_FENCE_SQL)
      .bind(job.anonymous_user_id, job.id, job.anonymous_user_id, job.requested_at),
    env.SUBMISSIONS_DB.prepare(CANCEL_ERASURE_SUBMISSIONS_SQL)
      .bind(now, now, job.user_id, job.anonymous_user_id),
    env.SUBMISSIONS_DB.prepare(CANCEL_ERASURE_ATTEMPTS_SQL)
      .bind(now, job.user_id, job.anonymous_user_id),
    env.SUBMISSIONS_DB.prepare(RECORD_ERASURE_CANCELLATION_EVENTS_SQL)
      .bind(now, job.user_id, job.anonymous_user_id),
    env.SUBMISSIONS_DB.prepare(CANCEL_ERASURE_REJUDGE_WORK_SQL)
      .bind(now, now, job.user_id, job.anonymous_user_id, job.user_id, job.anonymous_user_id),
    env.SUBMISSIONS_DB.prepare(SCRUB_ERASURE_SUBMISSION_OUTBOX_SQL)
      .bind(now, job.user_id, job.anonymous_user_id),
    env.SUBMISSIONS_DB.prepare(SCRUB_ERASURE_REJUDGE_RESULT_OUTBOX_SQL)
      .bind(now, job.user_id, job.anonymous_user_id, job.user_id, job.anonymous_user_id),
    env.SUBMISSIONS_DB.prepare("DELETE FROM formal_risk_allowances WHERE user_id IN (?, ?)")
      .bind(job.user_id, job.anonymous_user_id),
  ]);
  const fences = await env.SUBMISSIONS_DB.prepare("SELECT owner_user_id, erasure_job_id, anonymous_user_id FROM submission_owner_erasure_fences WHERE owner_user_id IN (?, ?) ORDER BY owner_user_id")
    .bind(job.user_id, job.anonymous_user_id).all<ErasureFenceRow>();
  if (
    fences.results.length !== 2
    || fences.results.some((row) => row.erasure_job_id !== job.id || row.anonymous_user_id !== job.anonymous_user_id)
  ) throw new Error("Submission owner erasure fence conflicts with another erasure job.");
}

function sameSourceSet(left: readonly SourceRow[], right: readonly SourceRow[]): boolean {
  return left.length === right.length && left.every((source, index) => {
    const other = right[index];
    return other !== undefined
      && source.id === other.id
      && source.user_id === other.user_id
      && source.source_r2_key === other.source_r2_key
      && source.source_erased_at === other.source_erased_at;
  });
}

async function ownerWorkIsDrained(env: ForgeWorkerEnv, userId: string, anonymousUserId: string): Promise<boolean> {
  const row = await env.SUBMISSIONS_DB.prepare(`SELECT
    EXISTS(SELECT 1 FROM submissions WHERE user_id IN (?, ?) AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled'))
    + EXISTS(SELECT 1 FROM submission_attempts WHERE submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?)) AND state IN ('created','running'))
    + EXISTS(SELECT 1 FROM submission_outbox WHERE submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?)) AND (delivered_at IS NULL OR payload_json<>'{}'))
    + EXISTS(SELECT 1 FROM rejudge_jobs WHERE (old_submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?)) OR new_submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?))) AND (state IN ('pending','dispatched') OR workflow_payload_json<>'{}'))
    + EXISTS(SELECT 1 FROM rejudge_result_outbox WHERE (old_submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?)) OR new_submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?))) AND delivered_at IS NULL)
    AS pending`)
    .bind(
      userId, anonymousUserId,
      userId, anonymousUserId,
      userId, anonymousUserId,
      userId, anonymousUserId, userId, anonymousUserId,
      userId, anonymousUserId, userId, anonymousUserId,
    ).first<{ pending: number }>();
  return row?.pending === 0;
}

async function drainSubmissionOwner(env: ForgeWorkerEnv, job: ErasureJobRow): Promise<SourceRow[]> {
  let sources = await submissionRows(env, job.user_id, job.anonymous_user_id);
  for (let pass = 0; pass < MAX_ERASURE_DRAIN_PASSES; pass += 1) {
    for (const source of sources) await stopSubmission(env, source);
    const now = new Date().toISOString();
    // A terminated workflow can have committed its final outbox immediately
    // before termination completed. Re-apply the fence and cancellation after
    // every stop pass, then require a stable identity/source-pointer set and no
    // active child/outbox state before deleting any source object.
    await fenceAndCancelSubmissionOwner(env, job, now);
    const reread = await submissionRows(env, job.user_id, job.anonymous_user_id);
    if (sameSourceSet(sources, reread) && await ownerWorkIsDrained(env, job.user_id, job.anonymous_user_id)) return reread;
    sources = reread;
  }
  throw new Error("Formal account state did not reach a stable erasure fence.");
}

async function deleteSubmissionAuditsForOwner(env: ForgeWorkerEnv, userId: string, anonymousUserId: string): Promise<void> {
  for (;;) {
    const rows = await env.SUBMISSIONS_DB.prepare(
      "SELECT submission_attempts.submission_id, submission_attempts.attempt, submission_attempts.audit_r2_key FROM submission_attempts JOIN submissions ON submissions.id=submission_attempts.submission_id WHERE submissions.user_id IN (?, ?) AND submission_attempts.audit_r2_key IS NOT NULL ORDER BY submission_attempts.submission_id, submission_attempts.attempt LIMIT 25",
    ).bind(userId, anonymousUserId).all<{ readonly submission_id: string; readonly attempt: number; readonly audit_r2_key: string }>();
    if (rows.results.length === 0) return;
    for (const row of rows.results) {
      await deleteMirroredAttemptAudit(env, {
        submissionId: row.submission_id,
        attempt: row.attempt,
        auditR2Key: row.audit_r2_key,
      });
      const cleared = await env.SUBMISSIONS_DB.prepare(
        "UPDATE submission_attempts SET audit_r2_key=NULL WHERE submission_id=? AND attempt=? AND audit_r2_key=? AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND user_id IN (?, ?))",
      ).bind(row.submission_id, row.attempt, row.audit_r2_key, row.submission_id, userId, anonymousUserId).run();
      if (cleared.meta.changes !== 1) {
        const current = await env.SUBMISSIONS_DB.prepare("SELECT audit_r2_key FROM submission_attempts WHERE submission_id=? AND attempt=?")
          .bind(row.submission_id, row.attempt).first<{ readonly audit_r2_key: string | null }>();
        if (!current || current.audit_r2_key !== null) throw new Error("Account erasure lost its submission audit fence.");
      }
    }
  }
}

async function stopSubmission(env: ForgeWorkerEnv, source: SourceRow): Promise<void> {
  const workflow = await env.SUBMISSION_WORKFLOW.get(source.id);
  let status = await workflow.status();
  if (!TERMINAL_WORKFLOW_STATES.has(status.status)) {
    await workflow.terminate();
    status = await workflow.status();
    if (!TERMINAL_WORKFLOW_STATES.has(status.status)) throw new Error("Submission workflow did not terminate.");
  }
}

async function deleteSourceCopies(env: ForgeWorkerEnv, source: SourceRow): Promise<void> {
  await Promise.all([
    env.JUDGE_BUCKET.delete(source.source_r2_key),
    env.JUDGE_MIRROR_BUCKET.delete(source.source_r2_key),
  ]);
  const [primary, mirror] = await Promise.all([
    env.JUDGE_BUCKET.head(source.source_r2_key),
    env.JUDGE_MIRROR_BUCKET.head(source.source_r2_key),
  ]);
  if (primary || mirror) throw new Error("Contestant source deletion postcondition failed.");
}

async function anonymizeSubmissionRows(
  env: ForgeWorkerEnv,
  sources: readonly SourceRow[],
  userId: string,
  anonymousUserId: string,
  erasedAt: string,
): Promise<void> {
  const statements = await Promise.all(sources.map(async (source) => env.SUBMISSIONS_DB.prepare(
    "UPDATE submissions SET user_id=?, source_r2_key=?, source_erased_at=COALESCE(source_erased_at, ?), visibility='private' WHERE id=? AND user_id IN (?, ?)",
  ).bind(
    anonymousUserId,
    await erasedSourceTombstoneKey(env.ACCOUNT_ERASURE_HMAC_SECRET, source.id),
    erasedAt,
    source.id,
    userId,
    anonymousUserId,
  )));
  for (let offset = 0; offset < statements.length; offset += 50) {
    const results = await env.SUBMISSIONS_DB.batch(statements.slice(offset, offset + 50));
    if (results.some((result) => !result.success)) throw new Error("Submission history anonymization failed.");
  }
}

async function assertSubmissionRowsAnonymized(
  env: ForgeWorkerEnv,
  sources: readonly SourceRow[],
  userId: string,
  anonymousUserId: string,
): Promise<void> {
  const retained = await submissionRows(env, userId, anonymousUserId);
  if (retained.length !== sources.length) throw new Error("Submission history changed during anonymization.");
  const expectedKeys = new Map(await Promise.all(sources.map(async (source) => [
    source.id,
    await erasedSourceTombstoneKey(env.ACCOUNT_ERASURE_HMAC_SECRET, source.id),
  ] as const)));
  if (retained.some((source) => (
    source.user_id !== anonymousUserId
    || source.visibility !== "private"
    || source.source_erased_at === null
    || source.source_r2_key !== expectedKeys.get(source.id)
  ))) throw new Error("Submission history anonymization postcondition failed.");
}

async function retireOriginalOwnerFence(env: ForgeWorkerEnv, job: ErasureJobRow): Promise<void> {
  const result = await env.SUBMISSIONS_DB.prepare("DELETE FROM submission_owner_erasure_fences WHERE owner_user_id=? AND erasure_job_id=? AND anonymous_user_id=?")
    .bind(job.user_id, job.id, job.anonymous_user_id).run();
  if (result.meta.changes !== 1) throw new Error("Original submission owner erasure fence was not retired exactly once.");
  const retainedOriginal = await env.SUBMISSIONS_DB.prepare(`SELECT
    EXISTS(SELECT 1 FROM submissions WHERE user_id=?)
    + EXISTS(SELECT 1 FROM submission_idempotency WHERE user_id=?)
    + EXISTS(SELECT 1 FROM submission_owner_erasure_fences WHERE owner_user_id=? OR anonymous_user_id=?)
    AS retained`)
    .bind(job.user_id, job.user_id, job.user_id, job.user_id).first<{ retained: number }>();
  const anonymousFence = await env.SUBMISSIONS_DB.prepare("SELECT erasure_job_id FROM submission_owner_erasure_fences WHERE owner_user_id=? AND anonymous_user_id=?")
    .bind(job.anonymous_user_id, job.anonymous_user_id).first<{ erasure_job_id: string }>();
  if (retainedOriginal?.retained !== 0 || anonymousFence?.erasure_job_id !== job.id) {
    throw new Error("Submission erasure fence retirement postcondition failed.");
  }
}

export async function resumeAccountErasure(
  env: ForgeWorkerEnv,
  jobId: string,
): Promise<{ readonly completed: boolean; readonly anonymousUserId: string; readonly receiptSha256?: string }> {
  const job = await env.CORE_DB.prepare("SELECT id, user_id, anonymous_user_id, status, requested_at FROM account_erasure_jobs WHERE id=?")
    .bind(jobId).first<ErasureJobRow>();
  if (!job) throw new Error("Account erasure job does not exist.");
  if (job.status === "completed") {
    const receipt = await env.CORE_DB.prepare("SELECT deletion_receipt_sha256 FROM account_erasure_jobs WHERE id=?")
      .bind(jobId).first<{ deletion_receipt_sha256: string }>();
    return { completed: true, anonymousUserId: job.anonymous_user_id, ...(receipt?.deletion_receipt_sha256 ? { receiptSha256: receipt.deletion_receipt_sha256 } : {}) };
  }
  try {
    // This D1 transaction is the first durable data-plane action. It fences
    // both the live and eventual anonymous owner before cancelling work, so a
    // rejudge request that read a source earlier cannot materialize or dispatch
    // it after the cancellation commits.
    await fenceAndCancelSubmissionOwner(env, job, new Date().toISOString());
    await cleanupFormalSubmissionAdmissionsForUser(env, job.user_id);

    // The initial account mutation has already marked every installation
    // removed locally, blocking new token issuance. Complete the external
    // revocation before any irreversible history anonymization.
    await revokeGithubInstallations(env, job.user_id);
    await deleteGithubInstallationClaimsForUser(env.CORE_DB, job.user_id);

    const now = new Date().toISOString();
    await env.CORE_DB.prepare("UPDATE account_erasure_jobs SET status='deleting-sources', last_error=NULL, updated_at=? WHERE id=?")
      .bind(now, jobId).run();
    await fenceAndCancelSubmissionOwner(env, job, now);
    const stableSources = await drainSubmissionOwner(env, job);
    await deleteSubmissionAuditsForOwner(env, job.user_id, job.anonymous_user_id);
    for (const source of stableSources) await deleteSourceCopies(env, source);
    const problemIds = [...new Set(stableSources.map((source) => source.managed_problem_version_id))];
    const contestIds = [...new Set(stableSources.flatMap((source) => source.contest_id ? [source.contest_id] : []))];
    await anonymizeSubmissionRows(env, stableSources, job.user_id, job.anonymous_user_id, job.requested_at);
    await assertSubmissionRowsAnonymized(env, stableSources, job.user_id, job.anonymous_user_id);
    await env.SUBMISSIONS_DB.prepare("DELETE FROM submission_idempotency WHERE user_id IN (?, ?)")
      .bind(job.user_id, job.anonymous_user_id).run();
    await retireOriginalOwnerFence(env, job);
    await env.CORE_DB.batch([
      env.CORE_DB.prepare("DELETE FROM formal_submission_admissions WHERE user_id=?").bind(job.user_id),
      env.CORE_DB.prepare("DELETE FROM contest_participants WHERE user_id=?").bind(job.user_id),
      env.CORE_DB.prepare("DELETE FROM verified_solves WHERE user_id=?").bind(job.user_id),
      env.CORE_DB.prepare("DELETE FROM organizer_applications WHERE user_id=?").bind(job.user_id),
      env.CORE_DB.prepare("DELETE FROM rejudge_verified_solves WHERE user_id=?").bind(job.user_id),
      env.CORE_DB.prepare("DELETE FROM profiles WHERE user_id=?").bind(job.user_id),
      env.CORE_DB.prepare("DELETE FROM github_identities WHERE user_id=?").bind(job.user_id),
      env.CORE_DB.prepare("UPDATE account_erasure_jobs SET status='anonymizing', updated_at=? WHERE id=?").bind(now, jobId),
    ]);

    const receipt = encoder.encode(`${JSON.stringify({
      schema: "forge-account-erasure-receipt-v1",
      jobId,
      anonymousUserId: job.anonymous_user_id,
      // The requested timestamp is persisted before any destructive work and
      // therefore remains stable across retries. A retry must never create a
      // second content-addressed receipt merely because wall-clock time moved.
      erasedAt: job.requested_at,
      deletedSourceObjects: stableSources.length,
      anonymizedProblemLeaderboards: problemIds.length,
      anonymizedContestLeaderboards: contestIds.length,
    })}\n`);
    const receiptSha256 = await sha256Hex(receipt);
    const receiptKey = `account-erasure/${job.anonymous_user_id}/${receiptSha256}.json`;
    const options = {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { sha256: receiptSha256 },
      sha256: Uint8Array.from(receiptSha256.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16)),
    } satisfies R2PutOptions;
    await putImmutableMirroredObject(env.JUDGE_BUCKET, env.JUDGE_MIRROR_BUCKET, receiptKey, receipt, receiptSha256, options);
    const originalHash = await hmacSha256Hex(env.ACCOUNT_ERASURE_HMAC_SECRET, encoder.encode(job.user_id));
    await env.CORE_DB.batch([
      // Public contest and collection history remains addressable, but every
      // retained FK is atomically re-parented to a non-login anonymous row.
      // No original user UUID survives this transaction.
      env.CORE_DB.prepare("INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'suspended')")
        .bind(job.anonymous_user_id, now, now),
      env.CORE_DB.prepare("UPDATE collection_imports SET organizer_user_id=? WHERE organizer_user_id=?")
        .bind(job.anonymous_user_id, job.user_id),
      env.CORE_DB.prepare("UPDATE managed_snapshots SET published_by=? WHERE published_by=?")
        .bind(job.anonymous_user_id, job.user_id),
      env.CORE_DB.prepare("UPDATE contests SET organizer_user_id=?, updated_at=? WHERE organizer_user_id=?")
        .bind(job.anonymous_user_id, now, job.user_id),
      env.CORE_DB.prepare("UPDATE rejudge_batches SET requested_by=? WHERE requested_by=?")
        .bind(job.anonymous_user_id, job.user_id),
      env.CORE_DB.prepare("DELETE FROM repository_push_notices WHERE github_repository_id IN (SELECT github_repositories.github_repository_id FROM github_repositories JOIN github_installations ON github_installations.installation_id=github_repositories.installation_id WHERE github_installations.installed_by_user_id=?)")
        .bind(job.user_id),
      env.CORE_DB.prepare("UPDATE github_repositories SET owner_login='erased-owner-' || github_repository_id, name='erased-repository-' || github_repository_id, authorization_status='removed', updated_at=? WHERE installation_id IN (SELECT installation_id FROM github_installations WHERE installed_by_user_id=?)")
        .bind(now, job.user_id),
      env.CORE_DB.prepare("UPDATE github_installations SET account_github_id=-installation_id, account_login='erased-installation-' || installation_id, installed_by_user_id=NULL, status='removed', updated_at=? WHERE installed_by_user_id=?")
        .bind(now, job.user_id),
      env.CORE_DB.prepare("UPDATE organizer_applications SET reviewed_by=NULL WHERE reviewed_by=?")
        .bind(job.user_id),
      env.CORE_DB.prepare("UPDATE user_roles SET granted_by=NULL WHERE granted_by=?")
        .bind(job.user_id),
      env.CORE_DB.prepare("DELETE FROM users WHERE id=?")
        .bind(job.user_id),
      env.CORE_DB.prepare("INSERT INTO erased_user_tombstones (anonymous_user_id, original_user_sha256, erased_at, deletion_receipt_r2_key, deletion_receipt_sha256) VALUES (?, ?, ?, ?, ?)")
      .bind(job.anonymous_user_id, originalHash, job.requested_at, receiptKey, receiptSha256),
      // The tombstone is the only durable erasure identity. Keeping the job
      // would retain the original UUID in account_erasure_jobs.user_id.
      env.CORE_DB.prepare("DELETE FROM account_erasure_jobs WHERE id=?").bind(jobId),
    ]);
    return { completed: true, anonymousUserId: job.anonymous_user_id, receiptSha256 };
  } catch (error) {
    await env.CORE_DB.prepare("UPDATE account_erasure_jobs SET last_error='erasure-retry-required', updated_at=? WHERE id=? AND status<>'completed'")
      .bind(new Date().toISOString(), jobId).run();
    throw error;
  }
}

function clearSessionHeaders(): Headers {
  const headers = new Headers();
  headers.append("set-cookie", cookieHeader("forge_session", "", { httpOnly: true, maxAge: 0, sameSite: "Lax" }));
  headers.append("set-cookie", cookieHeader("forge_csrf", "", { maxAge: 0, sameSite: "Strict" }));
  return headers;
}

export async function eraseAccount(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireMutationSession(request, env);
  if (env.ACCOUNT_ERASURE_HMAC_SECRET.length < 32) throw new Error("Account erasure secret is not configured.");
  const originalHash = await hmacSha256Hex(env.ACCOUNT_ERASURE_HMAC_SECRET, encoder.encode(session.userId));
  const anonymousUserId = `erased-${originalHash.slice(0, 32)}`;
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.CORE_DB.batch([
    // Establish the erasure job and revoke every local authority atomically.
    // A crash may leave the durable job for the reconciler, but can never
    // leave that job paired with an active session or an active installation.
    env.CORE_DB.prepare("INSERT INTO account_erasure_jobs (id, user_id, anonymous_user_id, status, requested_at, updated_at) VALUES (?, ?, ?, 'revoking', ?, ?)")
      .bind(jobId, session.userId, anonymousUserId, now, now),
    env.CORE_DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(session.userId),
    env.CORE_DB.prepare("DELETE FROM user_roles WHERE user_id=?").bind(session.userId),
    env.CORE_DB.prepare("UPDATE github_installations SET status='removed', updated_at=? WHERE installed_by_user_id=?").bind(now, session.userId),
    env.CORE_DB.prepare("UPDATE users SET status='suspended', updated_at=? WHERE id=?").bind(now, session.userId),
  ]);
  const result = await resumeAccountErasure(env, jobId);
  return jsonResponse(result.completed
    ? { erased: true, anonymousUserId, receiptSha256: result.receiptSha256 }
    : { erased: false, queued: true, anonymousUserId }, result.completed ? 200 : 202, clearSessionHeaders());
}
