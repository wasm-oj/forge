import { requireMutationSession } from "./auth";
import { hmacSha256Hex, sha256Hex } from "./crypto";
import type { ForgeWorkerEnv } from "./env";
import { deleteGithubInstallationClaimsForUser } from "./github-installation-claims";
import { githubAppJwt } from "./github";
import { cookieHeader, jsonResponse } from "./http";
import { putImmutableObject } from "./immutable-r2";
import { deleteAttemptAudit } from "./submission-audits";

interface ErasureJobRow {
  readonly id: string;
  readonly user_id: string;
  readonly anonymous_user_id: string;
  readonly requested_at: string;
}

interface SourceRow {
  readonly id: string;
  readonly source_r2_key: string | null;
  readonly managed_problem_version_id: string;
  readonly contest_id: string | null;
}

const TERMINAL_WORKFLOW_STATES = new Set(["complete", "errored", "terminated", "unknown"]);
const ERASED_SOURCE_KEY_PREFIX = "erased-source-tombstones/v1/";
const encoder = new TextEncoder();

export const CANCEL_ERASURE_SUBMISSIONS_SQL = "UPDATE submissions SET state='cancelled', updated_at=?, completed_at=COALESCE(completed_at, ?) WHERE user_id IN (?, ?) AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')";

export const CANCEL_ERASURE_ATTEMPTS_SQL = "UPDATE submission_attempts SET state='cancelled', finished_at=COALESCE(finished_at, ?) WHERE submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?)) AND state IN ('created','running')";

export const RECORD_ERASURE_CANCELLATION_EVENTS_SQL = "INSERT INTO submission_events (submission_id, event_key, payload_json, created_at) SELECT id, 'account-erasure-cancelled', '{\"kind\":\"state\",\"state\":\"cancelled\"}', ? FROM submissions WHERE user_id IN (?, ?) AND state='cancelled' ON CONFLICT(submission_id, event_key) DO NOTHING";

export const CANCEL_ERASURE_REJUDGE_WORK_SQL = "UPDATE rejudge_jobs SET state=CASE WHEN state IN ('pending','dispatched') THEN 'cancelled' ELSE state END, result_state=CASE WHEN state IN ('pending','dispatched') THEN 'cancelled' ELSE result_state END, erasure_excluded_at=CASE WHEN state IN ('pending','dispatched') THEN COALESCE(erasure_excluded_at, ?) ELSE erasure_excluded_at END, workflow_payload_json='{}', updated_at=? WHERE old_submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?)) OR new_submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?))";

export const SCRUB_ERASURE_OUTBOX_SQL = "UPDATE outbox SET delivered_at=COALESCE(delivered_at, ?), payload_json='{}', last_error=CASE WHEN delivered_at IS NULL THEN 'account-erasure' ELSE last_error END WHERE kind='start-submission-workflow' AND aggregate_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?))";

export async function erasedSourceTombstoneKey(secret: string, identity: string): Promise<string> {
  if (secret.length < 32) throw new Error("Account erasure secret is not configured.");
  if (!identity || identity.length > 128) throw new TypeError("Erased source identity is invalid.");
  const digest = await hmacSha256Hex(secret, encoder.encode(`forge-erased-submission-source-v1\0${identity}`));
  return `${ERASED_SOURCE_KEY_PREFIX}${digest}`;
}

function cancellationStatements(
  env: ForgeWorkerEnv,
  userId: string,
  anonymousUserId: string,
  now: string,
): D1PreparedStatement[] {
  return [
    env.DB.prepare(CANCEL_ERASURE_SUBMISSIONS_SQL).bind(now, now, userId, anonymousUserId),
    env.DB.prepare(CANCEL_ERASURE_ATTEMPTS_SQL).bind(now, userId, anonymousUserId),
    env.DB.prepare(RECORD_ERASURE_CANCELLATION_EVENTS_SQL).bind(now, userId, anonymousUserId),
    env.DB.prepare(CANCEL_ERASURE_REJUDGE_WORK_SQL)
      .bind(now, now, userId, anonymousUserId, userId, anonymousUserId),
    env.DB.prepare(SCRUB_ERASURE_OUTBOX_SQL).bind(now, userId, anonymousUserId),
    env.DB.prepare("DELETE FROM formal_risk_allowances WHERE user_id IN (?, ?)")
      .bind(userId, anonymousUserId),
  ];
}

async function cancelOwnerWork(env: ForgeWorkerEnv, job: ErasureJobRow, now: string): Promise<void> {
  const results = await env.DB.batch(cancellationStatements(env, job.user_id, job.anonymous_user_id, now));
  if (results.some((result) => !result.success)) throw new Error("Account erasure cancellation transaction failed.");
}

async function revokeGithubInstallations(env: ForgeWorkerEnv, userId: string): Promise<void> {
  const installations = await env.DB.prepare(
    "SELECT installation_id FROM github_installations WHERE installed_by_user_id=? ORDER BY installation_id",
  ).bind(userId).all<{ installation_id: number }>();
  for (const row of installations.results) {
    if (!Number.isSafeInteger(row.installation_id) || row.installation_id < 1) {
      throw new Error("GitHub installation identity is invalid.");
    }
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
    if (response.status !== 204 && response.status !== 404) {
      throw new Error(`GitHub installation revocation failed with HTTP ${response.status}.`);
    }
  }
}

async function submissionRows(env: ForgeWorkerEnv, userId: string, anonymousUserId: string): Promise<SourceRow[]> {
  const sources: SourceRow[] = [];
  let cursor = "";
  for (;;) {
    const page = await env.DB.prepare(
      "SELECT id, source_r2_key, managed_problem_version_id, contest_id FROM submissions WHERE user_id IN (?, ?) AND id>? ORDER BY id LIMIT 100",
    ).bind(userId, anonymousUserId, cursor).all<SourceRow>();
    if (page.results.length === 0) break;
    sources.push(...page.results);
    cursor = page.results.at(-1)?.id ?? cursor;
  }
  return sources;
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

async function stopAndDrainOwnerWork(env: ForgeWorkerEnv, job: ErasureJobRow): Promise<SourceRow[]> {
  const sources = await submissionRows(env, job.user_id, job.anonymous_user_id);
  for (const source of sources) await stopSubmission(env, source);

  // D1 serializes admission, rejudge materialization, and erasure writes. Once
  // the user is suspended, no new owned work can commit. This second pass only
  // settles callbacks that were already in flight when their workflow stopped.
  await cancelOwnerWork(env, job, new Date().toISOString());
  const pending = await env.DB.prepare(`SELECT
    EXISTS(SELECT 1 FROM submissions WHERE user_id IN (?, ?) AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled'))
    + EXISTS(SELECT 1 FROM submission_attempts WHERE submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?)) AND state IN ('created','running'))
    + EXISTS(SELECT 1 FROM outbox WHERE kind='start-submission-workflow' AND aggregate_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?)) AND (delivered_at IS NULL OR payload_json<>'{}'))
    + EXISTS(SELECT 1 FROM rejudge_jobs WHERE (old_submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?)) OR new_submission_id IN (SELECT id FROM submissions WHERE user_id IN (?, ?))) AND (state IN ('pending','dispatched') OR workflow_payload_json<>'{}'))
    AS pending`)
    .bind(
      job.user_id, job.anonymous_user_id,
      job.user_id, job.anonymous_user_id,
      job.user_id, job.anonymous_user_id,
      job.user_id, job.anonymous_user_id, job.user_id, job.anonymous_user_id,
    ).first<{ pending: number }>();
  if (pending?.pending !== 0) throw new Error("Account work did not stop before source deletion.");

  const stable = await submissionRows(env, job.user_id, job.anonymous_user_id);
  if (stable.length !== sources.length || stable.some((source, index) => source.id !== sources[index]?.id)) {
    throw new Error("Account submission set changed after suspension.");
  }
  return stable;
}

async function deleteSubmissionAuditsForOwner(
  env: ForgeWorkerEnv,
  userId: string,
  anonymousUserId: string,
): Promise<void> {
  for (;;) {
    const rows = await env.DB.prepare(
      "SELECT submission_attempts.submission_id, submission_attempts.attempt, submission_attempts.audit_r2_key FROM submission_attempts JOIN submissions ON submissions.id=submission_attempts.submission_id WHERE submissions.user_id IN (?, ?) AND submission_attempts.audit_r2_key IS NOT NULL ORDER BY submission_attempts.submission_id, submission_attempts.attempt LIMIT 25",
    ).bind(userId, anonymousUserId).all<{
      readonly submission_id: string;
      readonly attempt: number;
      readonly audit_r2_key: string;
    }>();
    if (rows.results.length === 0) return;
    for (const row of rows.results) {
      await deleteAttemptAudit(env, {
        submissionId: row.submission_id,
        attempt: row.attempt,
        auditR2Key: row.audit_r2_key,
      });
      const cleared = await env.DB.prepare(
        "UPDATE submission_attempts SET audit_r2_key=NULL WHERE submission_id=? AND attempt=? AND audit_r2_key=? AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND user_id IN (?, ?))",
      ).bind(row.submission_id, row.attempt, row.audit_r2_key, row.submission_id, userId, anonymousUserId).run();
      if (cleared.meta.changes !== 1) {
        const current = await env.DB.prepare(
          "SELECT audit_r2_key FROM submission_attempts WHERE submission_id=? AND attempt=?",
        ).bind(row.submission_id, row.attempt).first<{ readonly audit_r2_key: string | null }>();
        if (!current || current.audit_r2_key !== null) {
          throw new Error("Account erasure lost its submission audit row.");
        }
      }
    }
  }
}

async function deleteSourceObject(env: ForgeWorkerEnv, source: SourceRow): Promise<boolean> {
  if (source.source_r2_key === null) return false;
  await env.JUDGE_BUCKET.delete(source.source_r2_key);
  if (await env.JUDGE_BUCKET.head(source.source_r2_key)) {
    throw new Error("Contestant source deletion postcondition failed.");
  }
  return true;
}

async function finalizeAccountErasure(
  env: ForgeWorkerEnv,
  job: ErasureJobRow,
  sources: readonly SourceRow[],
  receiptKey: string,
  receiptSha256: string,
): Promise<void> {
  const now = new Date().toISOString();
  const sourceTombstone = await erasedSourceTombstoneKey(
    env.ACCOUNT_ERASURE_HMAC_SECRET,
    job.anonymous_user_id,
  );
  const tombstoneDigest = sourceTombstone.slice(-64);
  const originalHash = await hmacSha256Hex(env.ACCOUNT_ERASURE_HMAC_SECRET, encoder.encode(job.user_id));
  const results = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'suspended')")
      .bind(job.anonymous_user_id, now, now),
    env.DB.prepare("UPDATE submissions SET user_id=?, entry_path='erased', source_r2_key=?, source_digest=?, source_erased_at=COALESCE(source_erased_at, ?), visibility='private' WHERE user_id IN (?, ?)")
      .bind(job.anonymous_user_id, sourceTombstone, tombstoneDigest, job.requested_at, job.user_id, job.anonymous_user_id),
    env.DB.prepare("UPDATE submission_attempts SET token_hash='erased', container_key='erased', audit_r2_key=NULL WHERE submission_id IN (SELECT id FROM submissions WHERE user_id=?)")
      .bind(job.anonymous_user_id),
    env.DB.prepare("DELETE FROM submission_idempotency WHERE user_id IN (?, ?)")
      .bind(job.user_id, job.anonymous_user_id),
    env.DB.prepare("DELETE FROM contest_participants WHERE user_id=?").bind(job.user_id),
    env.DB.prepare("DELETE FROM organizer_applications WHERE user_id=?").bind(job.user_id),
    env.DB.prepare("DELETE FROM profiles WHERE user_id=?").bind(job.user_id),
    env.DB.prepare("DELETE FROM github_identities WHERE user_id=?").bind(job.user_id),
    env.DB.prepare("UPDATE collection_imports SET organizer_user_id=? WHERE organizer_user_id=?")
      .bind(job.anonymous_user_id, job.user_id),
    env.DB.prepare("UPDATE managed_snapshots SET published_by=? WHERE published_by=?")
      .bind(job.anonymous_user_id, job.user_id),
    env.DB.prepare("UPDATE contests SET organizer_user_id=?, updated_at=? WHERE organizer_user_id=?")
      .bind(job.anonymous_user_id, now, job.user_id),
    env.DB.prepare("UPDATE rejudge_batches SET requested_by=? WHERE requested_by=?")
      .bind(job.anonymous_user_id, job.user_id),
    env.DB.prepare("DELETE FROM repository_push_notices WHERE github_repository_id IN (SELECT github_repositories.github_repository_id FROM github_repositories JOIN github_installations ON github_installations.installation_id=github_repositories.installation_id WHERE github_installations.installed_by_user_id=?)")
      .bind(job.user_id),
    env.DB.prepare("UPDATE github_repositories SET owner_login='erased-owner-' || github_repository_id, name='erased-repository-' || github_repository_id, authorization_status='removed', updated_at=? WHERE installation_id IN (SELECT installation_id FROM github_installations WHERE installed_by_user_id=?)")
      .bind(now, job.user_id),
    env.DB.prepare("UPDATE github_installations SET account_github_id=-installation_id, account_login='erased-installation-' || installation_id, installed_by_user_id=NULL, status='removed', updated_at=? WHERE installed_by_user_id=?")
      .bind(now, job.user_id),
    env.DB.prepare("UPDATE organizer_applications SET reviewed_by=NULL WHERE reviewed_by=?").bind(job.user_id),
    env.DB.prepare("UPDATE user_roles SET granted_by=NULL WHERE granted_by=?").bind(job.user_id),
    env.DB.prepare("DELETE FROM users WHERE id=?").bind(job.user_id),
    env.DB.prepare("INSERT INTO erased_user_tombstones (anonymous_user_id, original_user_sha256, erased_at, deletion_receipt_r2_key, deletion_receipt_sha256) VALUES (?, ?, ?, ?, ?)")
      .bind(job.anonymous_user_id, originalHash, job.requested_at, receiptKey, receiptSha256),
    env.DB.prepare("DELETE FROM account_erasure_jobs WHERE id=?").bind(job.id),
  ]);
  if (results.some((result) => !result.success)) throw new Error("Account anonymization transaction failed.");

  const retained = await env.DB.prepare(`SELECT
    EXISTS(SELECT 1 FROM users WHERE id=?)
    + EXISTS(SELECT 1 FROM submissions WHERE user_id=?)
    + EXISTS(SELECT 1 FROM submission_idempotency WHERE user_id=?)
    + EXISTS(SELECT 1 FROM account_erasure_jobs WHERE id=?)
    AS retained`)
    .bind(job.user_id, job.user_id, job.user_id, job.id).first<{ retained: number }>();
  if (retained?.retained !== 0) throw new Error("Original account identity survived anonymization.");
  const anonymized = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM submissions WHERE user_id=? AND source_r2_key=? AND source_digest=? AND source_erased_at IS NOT NULL AND visibility='private'",
  ).bind(job.anonymous_user_id, sourceTombstone, tombstoneDigest).first<{ count: number }>();
  if (anonymized?.count !== sources.length) throw new Error("Submission history anonymization postcondition failed.");
}

export async function resumeAccountErasure(
  env: ForgeWorkerEnv,
  jobId: string,
): Promise<{ readonly completed: boolean; readonly anonymousUserId: string; readonly receiptSha256?: string }> {
  const job = await env.DB.prepare(
    "SELECT id, user_id, anonymous_user_id, requested_at FROM account_erasure_jobs WHERE id=?",
  ).bind(jobId).first<ErasureJobRow>();
  if (!job) throw new Error("Account erasure job does not exist.");

  try {
    await cancelOwnerWork(env, job, new Date().toISOString());
    await revokeGithubInstallations(env, job.user_id);
    await deleteGithubInstallationClaimsForUser(env.DB, job.user_id);

    const now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE account_erasure_jobs SET status='deleting-sources', last_error=NULL, updated_at=? WHERE id=?",
    ).bind(now, job.id).run();
    const stableSources = await stopAndDrainOwnerWork(env, job);
    await deleteSubmissionAuditsForOwner(env, job.user_id, job.anonymous_user_id);
    let deletedSourceObjects = 0;
    for (const source of stableSources) {
      if (await deleteSourceObject(env, source)) deletedSourceObjects += 1;
    }

    const problemIds = new Set(stableSources.map((source) => source.managed_problem_version_id));
    const contestIds = new Set(stableSources.flatMap((source) => source.contest_id ? [source.contest_id] : []));
    const receipt = encoder.encode(`${JSON.stringify({
      schema: "forge-account-erasure-receipt-v1",
      jobId: job.id,
      anonymousUserId: job.anonymous_user_id,
      erasedAt: job.requested_at,
      deletedSourceObjects,
      affectedProblems: problemIds.size,
      affectedContests: contestIds.size,
    })}\n`);
    const receiptSha256 = await sha256Hex(receipt);
    const receiptKey = `account-erasure/${job.anonymous_user_id}/${receiptSha256}.json`;
    const options = {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { sha256: receiptSha256 },
      sha256: Uint8Array.from(receiptSha256.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16)),
    } satisfies R2PutOptions;
    await putImmutableObject(env.JUDGE_BUCKET, receiptKey, receipt, receiptSha256, options);
    await finalizeAccountErasure(env, job, stableSources, receiptKey, receiptSha256);
    return { completed: true, anonymousUserId: job.anonymous_user_id, receiptSha256 };
  } catch (error) {
    await env.DB.prepare(
      "UPDATE account_erasure_jobs SET last_error='erasure-retry-required', updated_at=? WHERE id=?",
    ).bind(new Date().toISOString(), job.id).run();
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
  if (env.ACCOUNT_ERASURE_HMAC_SECRET.length < 32) {
    throw new Error("Account erasure secret is not configured.");
  }
  const originalHash = await hmacSha256Hex(env.ACCOUNT_ERASURE_HMAC_SECRET, encoder.encode(session.userId));
  const anonymousUserId = `erased-${originalHash.slice(0, 32)}`;
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  const results = await env.DB.batch([
    env.DB.prepare("INSERT INTO account_erasure_jobs (id, user_id, anonymous_user_id, status, requested_at, updated_at) VALUES (?, ?, ?, 'revoking', ?, ?)")
      .bind(jobId, session.userId, anonymousUserId, now, now),
    env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(session.userId),
    env.DB.prepare("DELETE FROM user_roles WHERE user_id=?").bind(session.userId),
    env.DB.prepare("UPDATE github_installations SET status='removed', updated_at=? WHERE installed_by_user_id=?")
      .bind(now, session.userId),
    env.DB.prepare("UPDATE users SET status='suspended', updated_at=? WHERE id=?")
      .bind(now, session.userId),
    ...cancellationStatements(env, session.userId, anonymousUserId, now),
  ]);
  if (results.some((result) => !result.success)) throw new Error("Account erasure transaction failed.");

  const result = await resumeAccountErasure(env, jobId);
  return jsonResponse(result.completed
    ? { erased: true, anonymousUserId, receiptSha256: result.receiptSha256 }
    : { erased: false, queued: true, anonymousUserId }, result.completed ? 200 : 202, clearSessionHeaders());
}
