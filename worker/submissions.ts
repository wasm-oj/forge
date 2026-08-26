import { parseOfficialSubmissionRequest, type SubmissionVerdict } from "../src/online-judge/contracts";
import { parseStoredProblemTitle } from "../src/online-judge/stored-problem-title";
import { authenticatedSession, requireBrowserMutationSession, requireBrowserOrBearerMutationSession, requireSession } from "./auth";
import { sha256Hex } from "./crypto";
import type { AuthenticatedSession, WasmOjWorkerEnv } from "./env";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { requireOfficialSubmissionRiskTurnstile, requireStagingFormalAccess } from "./formal-access";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { prepareSubmissionEventInsert, replaySubmissionEvents } from "./submission-events";
import { MAX_QUEUED_SUBMISSIONS, MAX_QUEUED_SUBMISSIONS_PER_USER, submissionCapacitySnapshot } from "./submission-capacity";
import { deriveSubmissionAttemptToken } from "./submission-workflow-identity";
import { dispatchSubmissionJobs } from "./dispatcher";

const SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const SOURCE_TOMBSTONE = new TextEncoder().encode('{"schema":"wasm-oj-platform/erased-submission-source/v1"}\n');

interface ActiveProblemRevisionRow {
  readonly problem_id: string;
  readonly commit_sha: string;
  readonly problem_slug: string;
  readonly practice_enabled: number;
  readonly judge_digest: string;
  readonly allowed_profiles_json: string;
}

interface SubmissionRow {
  readonly id: string;
  readonly user_id: string;
  readonly problem_id: string;
  readonly catalog_commit: string;
  readonly judge_digest: string;
  readonly contest_id: string | null;
  readonly source_id: string;
  readonly source_state: string;
  readonly language: string;
  readonly target: string;
  readonly optimization: string;
  readonly entry_path: string;
  readonly state: string;
  readonly verdict: SubmissionVerdict | null;
  readonly visibility: string;
  readonly score: number | null;
  readonly fully_passed_cases: number | null;
  readonly deterministic_cost: number | null;
  readonly peak_memory_bytes: number | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

interface SubmissionProductRow extends SubmissionRow {
  readonly problem_slug: string;
  readonly title_json: string;
  readonly contest_record_id: string | null;
  readonly contest_title: string | null;
  readonly stale: number;
  readonly judged_commit: string;
  readonly active_commit: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const SUBMISSION_PRODUCT_SELECT_SQL = `SELECT
    origin.id,
    origin.user_id,
    origin.problem_id,
    COALESCE(result.catalog_commit, origin.catalog_commit) AS catalog_commit,
    COALESCE(result.judge_digest, origin.judge_digest) AS judge_digest,
    origin.contest_id,
    origin.source_id,
    sources.state AS source_state,
    origin.language,
    origin.target,
    origin.optimization,
    origin.entry_path,
    CASE WHEN result.id IS NULL THEN origin.state ELSE result.state END AS state,
    CASE WHEN result.id IS NULL THEN origin.verdict ELSE result.verdict END AS verdict,
    origin.visibility,
    CASE WHEN result.id IS NULL THEN origin.score ELSE result.score END AS score,
    CASE WHEN result.id IS NULL THEN origin.fully_passed_cases ELSE result.fully_passed_cases END AS fully_passed_cases,
    CASE WHEN result.id IS NULL THEN origin.deterministic_cost ELSE result.deterministic_cost END AS deterministic_cost,
    CASE WHEN result.id IS NULL THEN origin.peak_memory_bytes ELSE result.peak_memory_bytes END AS peak_memory_bytes,
    origin.created_at,
    CASE WHEN result.id IS NULL THEN origin.updated_at ELSE result.updated_at END AS updated_at,
    CASE WHEN result.id IS NULL THEN origin.completed_at ELSE result.completed_at END AS completed_at,
    problems.slug AS problem_slug,
    versions.title_json,
    contests.id AS contest_record_id,
    contest_revisions.title AS contest_title,
    COALESCE(effective.stale, 0) AS stale,
    COALESCE(effective.judged_commit, origin.catalog_commit) AS judged_commit,
    catalogs.active_commit_sha AS active_commit
  FROM submissions AS origin
  JOIN submission_sources AS sources ON sources.id=origin.source_id
  LEFT JOIN effective_submission_results AS effective
    ON effective.origin_submission_id=origin.id
  LEFT JOIN submissions AS result
    ON result.id=effective.effective_submission_id
  JOIN problem_series AS problems ON problems.id=origin.problem_id
  JOIN catalogs ON catalogs.id=problems.catalog_id
  JOIN problem_revisions AS versions
    ON versions.problem_id=origin.problem_id
   AND versions.commit_sha=COALESCE(result.catalog_commit, origin.catalog_commit)
  LEFT JOIN contest_series AS contests ON contests.id=origin.contest_id
  LEFT JOIN contest_revisions ON contest_revisions.contest_id=contests.id
    AND contest_revisions.commit_sha=catalogs.active_commit_sha`;

export interface SubmissionListQuery {
  readonly limit: number;
  readonly cursor: { readonly before: string; readonly beforeId: string } | null;
}

export function parseSubmissionListQuery(url: URL): SubmissionListQuery {
  const rawLimit = url.searchParams.get("limit") ?? "50";
  if (!/^[1-9][0-9]*$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) > 100) {
    throw new ApiError(400, "submission-limit-invalid", "Submission limit must be an integer from 1 to 100.");
  }
  const before = url.searchParams.get("before");
  const beforeId = url.searchParams.get("beforeId");
  if ((before === null) !== (beforeId === null)) {
    throw new ApiError(400, "submission-cursor-invalid", "Submission cursor requires both before and beforeId.");
  }
  if (before === null || beforeId === null) return { limit: Number(rawLimit), cursor: null };
  const beforeTimestamp = Date.parse(before);
  if (!Number.isFinite(beforeTimestamp) || new Date(beforeTimestamp).toISOString() !== before || !UUID_PATTERN.test(beforeId)) {
    throw new ApiError(400, "submission-cursor-invalid", "Submission cursor is invalid.");
  }
  return { limit: Number(rawLimit), cursor: { before, beforeId } };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]));
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(canonicalValue(value))}\n`);
}

function digestBytes(digest: string): Uint8Array {
  return Uint8Array.from(digest.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export function submissionSourceKey(sourceId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sourceId)) {
    throw new TypeError("Submission source ID is invalid.");
  }
  return `submission-sources/v2/${sourceId}`;
}

async function putSourceConditional(
  env: WasmOjWorkerEnv,
  sourceId: string,
  bytes: Uint8Array,
  digest: string,
): Promise<void> {
  if (bytes.byteLength < 1 || bytes.byteLength > SOURCE_MAX_BYTES) throw new Error("Submission source exceeds its object limit.");
  const key = submissionSourceKey(sourceId);
  const created = await env.JUDGE_BUCKET.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
    customMetadata: { kind: "submission-source", sourceId, sha256: digest },
    sha256: digestBytes(digest),
  });
  if (created) return;
  const existing = await env.JUDGE_BUCKET.head(key);
  if (
    !existing
    || existing.size !== bytes.byteLength
    || existing.customMetadata?.kind !== "submission-source"
    || existing.customMetadata.sourceId !== sourceId
    || existing.customMetadata.sha256 !== digest
  ) throw new ApiError(409, "source-object-conflict", "Submission source identity is already tombstoned or bound to different bytes.");
}

export async function tombstoneSubmissionSource(env: WasmOjWorkerEnv, sourceId: string): Promise<void> {
  const key = submissionSourceKey(sourceId);
  const digest = await sha256Hex(SOURCE_TOMBSTONE);
  await env.JUDGE_BUCKET.put(key, SOURCE_TOMBSTONE, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { kind: "erased", sourceId, sha256: digest },
    sha256: digestBytes(digest),
  });
  const head = await env.JUDGE_BUCKET.head(key);
  if (
    !head
    || head.size !== SOURCE_TOMBSTONE.byteLength
    || head.customMetadata?.kind !== "erased"
    || head.customMetadata.sourceId !== sourceId
    || head.customMetadata.sha256 !== digest
  ) throw new Error("Submission source tombstone did not cross the R2 persistence barrier.");
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE submission_sources
      SET state='erased', owner_user_id=NULL, content_sha256=NULL, bytes=NULL, erased_at=?,
          erasure_next_attempt_at=NULL, erasure_last_error=NULL
    WHERE id=? AND state='erasing'`)
    .bind(now, sourceId).run();
}

async function beginSourceErasure(env: WasmOjWorkerEnv, sourceId: string, now = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  await env.DB.prepare(`UPDATE submission_sources
      SET state='erasing', content_sha256=NULL, bytes=NULL,
          erasure_requested_at=COALESCE(erasure_requested_at, ?),
          erasure_next_attempt_at=COALESCE(erasure_next_attempt_at, ?),
          erasure_last_error=NULL
    WHERE id=? AND state IN ('reserved','ready','erasing')`)
    .bind(timestamp, timestamp, sourceId).run();
}

async function activeProblemRevision(env: WasmOjWorkerEnv, id: string): Promise<ActiveProblemRevisionRow> {
  const row = await env.DB.prepare(`SELECT revisions.problem_id, revisions.commit_sha,
      problems.slug AS problem_slug, revisions.practice_enabled,
      revisions.judge_digest, revisions.allowed_profiles_json
    FROM problem_series AS problems
    JOIN catalogs ON catalogs.id=problems.catalog_id
    JOIN problem_revisions AS revisions
      ON revisions.problem_id=problems.id AND revisions.commit_sha=catalogs.active_commit_sha
    WHERE problems.id=?`)
    .bind(id).first<ActiveProblemRevisionRow>();
  if (!row) throw new ApiError(404, "problem-not-found", "Problem is not active.");
  return row;
}

async function verifyContestAdmission(
  env: WasmOjWorkerEnv,
  session: AuthenticatedSession,
  contestId: string | undefined,
  problemId: string,
  catalogCommit: string,
): Promise<void> {
  if (!contestId) return;
  const contest = await env.DB.prepare(`SELECT revisions.starts_at, revisions.ends_at, revisions.status,
      revisions.access_mode, participants.user_id AS participant_user_id
    FROM contest_series AS contests
    JOIN catalogs ON catalogs.id=contests.catalog_id AND catalogs.active_commit_sha=?
    JOIN contest_revisions AS revisions
      ON revisions.contest_id=contests.id AND revisions.commit_sha=catalogs.active_commit_sha
    JOIN contest_revision_problems AS contest_problems
      ON contest_problems.contest_id=contests.id
     AND contest_problems.commit_sha=revisions.commit_sha
     AND contest_problems.problem_id=?
    LEFT JOIN contest_participants AS participants
      ON participants.contest_id=contests.id AND participants.user_id=?
    WHERE contests.id=?`)
    .bind(catalogCommit, problemId, session.userId, contestId).first<{
      readonly starts_at: string;
      readonly ends_at: string;
      readonly status: string;
      readonly access_mode: string;
      readonly participant_user_id: string | null;
    }>();
  const now = new Date().toISOString();
  if (!contest || contest.status !== "published" || now < contest.starts_at || now >= contest.ends_at) {
    throw new ApiError(409, "contest-not-running", "Contest is not accepting submissions.");
  }
  if (contest.access_mode === "invite" && contest.participant_user_id !== session.userId) {
    throw new ApiError(403, "contest-invite-required", "Join this invite-only contest before submitting.");
  }
}

async function submissionForOwner(env: WasmOjWorkerEnv, submissionId: string, userId: string): Promise<SubmissionRow> {
  const row = await env.DB.prepare(`SELECT submissions.*,
      sources.state AS source_state
    FROM submissions JOIN submission_sources AS sources ON sources.id=submissions.source_id
    WHERE submissions.id=? AND submissions.user_id=?
      AND NOT EXISTS (SELECT 1 FROM rejudge_jobs WHERE new_submission_id=submissions.id)`)
    .bind(submissionId, userId).first<SubmissionRow>();
  if (!row) throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  return row;
}

async function finalizeSourceAdmission(
  env: WasmOjWorkerEnv,
  input: { readonly sourceId: string; readonly submissionId: string; readonly userId: string; readonly erasureEpoch: number },
): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const attemptToken = await deriveSubmissionAttemptToken(env.ACCOUNT_ERASURE_HMAC_SECRET, input.submissionId, 1);
  const [, , , queued] = await env.DB.batch([
    env.DB.prepare(`UPDATE submission_sources
        SET state='ready', ready_at=?
      WHERE id=? AND owner_user_id=? AND state='reserved' AND admission_erasure_epoch=?
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND status='active' AND erasure_epoch=?)
        AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=?)`)
      .bind(timestamp, input.sourceId, input.userId, input.erasureEpoch, input.userId, input.erasureEpoch, input.userId),
    env.DB.prepare(`INSERT INTO submission_attempts
        (submission_id, attempt, token_hash, state)
      SELECT submissions.id, 1, ?, 'created'
        FROM submissions JOIN submission_sources AS sources ON sources.id=submissions.source_id
       WHERE submissions.id=? AND submissions.user_id=? AND submissions.state='admitting'
         AND sources.id=? AND sources.state='ready'
      ON CONFLICT(submission_id, attempt) DO NOTHING`)
      .bind(await sha256Hex(attemptToken), input.submissionId, input.userId, input.sourceId),
    env.DB.prepare(`INSERT INTO workflow_outbox
        (id, state, submission_id, attempts, created_at, updated_at)
      SELECT ?, 'pending', submissions.id, 0, ?, ?
        FROM submissions JOIN submission_sources AS sources ON sources.id=submissions.source_id
       WHERE submissions.id=? AND submissions.user_id=? AND submissions.state='admitting'
         AND sources.id=? AND sources.state='ready'
      ON CONFLICT DO NOTHING`)
      .bind(crypto.randomUUID(), timestamp, timestamp, input.submissionId, input.userId, input.sourceId),
    env.DB.prepare(`UPDATE submissions SET state='queued', updated_at=?
      WHERE id=? AND user_id=? AND source_id=? AND state='admitting'
        AND EXISTS (SELECT 1 FROM submission_sources WHERE id=? AND state='ready')
        AND EXISTS (SELECT 1 FROM submission_attempts WHERE submission_id=? AND attempt=1 AND state='created')
        AND EXISTS (SELECT 1 FROM workflow_outbox WHERE submission_id=? AND state='pending')`)
      .bind(timestamp, input.submissionId, input.userId, input.sourceId, input.sourceId, input.submissionId, input.submissionId),
  ]);
  if (queued?.meta.changes === 1) return true;
  const exact = await env.DB.prepare(`SELECT submissions.state, sources.state AS source_state,
      attempts.state AS attempt_state, outbox.state AS outbox_state
    FROM submissions
    JOIN submission_sources AS sources ON sources.id=submissions.source_id
    LEFT JOIN submission_attempts AS attempts ON attempts.submission_id=submissions.id AND attempts.attempt=1
    LEFT JOIN workflow_outbox AS outbox ON outbox.submission_id=submissions.id
    WHERE submissions.id=? AND submissions.user_id=? AND sources.id=?`)
    .bind(input.submissionId, input.userId, input.sourceId).first<{
      readonly state: string;
      readonly source_state: string;
      readonly attempt_state: string | null;
      readonly outbox_state: string | null;
    }>();
  return Boolean(exact && exact.state !== "admitting" && exact.source_state === "ready" && exact.attempt_state && exact.outbox_state);
}

export async function reconcileAdmittingSubmission(env: WasmOjWorkerEnv, submissionId: string, now = new Date()): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT submissions.id, submissions.user_id, submissions.source_id,
      submissions.state, submissions.updated_at, sources.content_sha256, sources.bytes,
      sources.state AS source_state, sources.admission_erasure_epoch
    FROM submissions JOIN submission_sources AS sources ON sources.id=submissions.source_id
    WHERE submissions.id=?`)
    .bind(submissionId).first<{
      readonly id: string;
      readonly user_id: string;
      readonly source_id: string;
      readonly state: string;
      readonly updated_at: string;
      readonly content_sha256: string | null;
      readonly bytes: number | null;
      readonly source_state: string;
      readonly admission_erasure_epoch: number;
    }>();
  if (!row || row.state !== "admitting") return true;
  if (Date.parse(row.updated_at) > now.getTime() - 2 * 60 * 1_000) return false;
  const head = await env.JUDGE_BUCKET.head(submissionSourceKey(row.source_id));
  if (
    row.source_state === "reserved"
    && row.content_sha256
    && row.bytes
    && head?.size === row.bytes
    && head.customMetadata?.kind === "submission-source"
    && head.customMetadata.sha256 === row.content_sha256
  ) {
    if (await finalizeSourceAdmission(env, {
      sourceId: row.source_id,
      submissionId: row.id,
      userId: row.user_id,
      erasureEpoch: row.admission_erasure_epoch,
    })) {
      await dispatchSubmissionJobs(env);
      return true;
    }
  }
  await beginSourceErasure(env, row.source_id, now);
  await tombstoneSubmissionSource(env, row.source_id);
  const timestamp = now.toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE submissions
        SET state='infrastructure-error', verdict='judge-error', score=0, fully_passed_cases=0,
            updated_at=?, completed_at=?
      WHERE id=? AND state='admitting'`).bind(timestamp, timestamp, row.id),
    prepareSubmissionEventInsert(env.DB, {
      submissionId: row.id,
      eventKey: "admission-source-unavailable",
      event: { kind: "state", state: "infrastructure-error" },
      timestamp,
      requiredState: "infrastructure-error",
    }),
  ]);
  return true;
}

export async function createSubmission(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireBrowserOrBearerMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  const input = parseOfficialSubmissionRequest(await readJsonBody(request, SOURCE_MAX_BYTES));
  const problem = await activeProblemRevision(env, input.problemId);
  if (problem.commit_sha !== input.catalogCommit) {
    throw new ApiError(409, "problem-revision-stale", "The requested problem revision is no longer active.");
  }
  const allowedProfiles = JSON.parse(problem.allowed_profiles_json) as unknown;
  const selectedProfile = allowedProfiles && typeof allowedProfiles === "object" && !Array.isArray(allowedProfiles)
    ? (allowedProfiles as Record<string, { target?: unknown; optimization?: unknown }>)[input.language]
    : undefined;
  if (selectedProfile?.target !== input.target || selectedProfile.optimization !== input.optimization) {
    throw new ApiError(409, "compile-profile-not-allowed", "Language, target, or optimization is not allowed by this problem.");
  }
  if (!input.contestId && problem.practice_enabled !== 1) {
    throw new ApiError(409, "practice-disabled", "This problem is not enabled for practice submissions.");
  }
  await verifyContestAdmission(env, session, input.contestId, input.problemId, input.catalogCommit);
  const requestDigest = await sha256Hex(canonicalBytes(input));
  const existing = await env.DB.prepare("SELECT submission_id, request_digest FROM submission_idempotency WHERE user_id=? AND idempotency_key=?")
    .bind(session.userId, input.idempotencyKey).first<{ readonly submission_id: string; readonly request_digest: string }>();
  if (existing) {
    if (existing.request_digest !== requestDigest) throw new ApiError(409, "idempotency-conflict", "Idempotency key was already used for different source.");
    return submissionCreatedResponse(request, env, existing.submission_id, true);
  }
  await requireFormalMutationsEnabled(env, request);
  const formalRiskRequestKey = await sha256Hex(canonicalBytes({ idempotencyKey: input.idempotencyKey, requestDigest }));
  await requireOfficialSubmissionRiskTurnstile(request, env, session.userId, formalRiskRequestKey);
  const capacity = await submissionCapacitySnapshot(env, session.userId);
  if (capacity.userQueued >= MAX_QUEUED_SUBMISSIONS_PER_USER) throw new ApiError(429, "submission-queue-full", "This account already has three queued submissions.");
  if (capacity.globalQueued >= MAX_QUEUED_SUBMISSIONS) throw new ApiError(429, "submission-capacity", "The submission queue is temporarily full.");
  const user = await env.DB.prepare("SELECT erasure_epoch FROM users WHERE id=? AND status='active'")
    .bind(session.userId).first<{ readonly erasure_epoch: number }>();
  if (!user) throw new ApiError(409, "account-unavailable", "Account is not available for submission.");
  const compileRequest = {
    language: input.language,
    target: input.target,
    optimization: input.optimization,
    entry: input.entry,
    sourceFiles: input.sourceFiles,
  };
  const sourceBytes = canonicalBytes({
    schema: "wasm-oj-platform/official-source/v1",
    sourceDigest: await sha256Hex(canonicalBytes(compileRequest)),
    request: compileRequest,
  });
  const sourceDigest = await sha256Hex(sourceBytes);
  const sourceId = crypto.randomUUID();
  const submissionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO submission_sources
          (id, owner_user_id, content_sha256, bytes, state, admission_erasure_epoch, created_at)
        SELECT ?, id, ?, ?, 'reserved', erasure_epoch, ? FROM users
         WHERE id=? AND status='active' AND erasure_epoch=?
           AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=users.id)`)
        .bind(sourceId, sourceDigest, sourceBytes.byteLength, timestamp, session.userId, user.erasure_epoch),
      env.DB.prepare(`INSERT INTO submissions
          (id, origin_submission_id, origin_submitted_at, user_id, problem_id,
           catalog_commit, judge_digest, contest_id,
           source_id, language, target, optimization, entry_path,
           state, visibility, admitted_at, created_at, updated_at)
        SELECT ?, ?, ?, ?, revisions.problem_id,
               revisions.commit_sha, revisions.judge_digest, ?, ?, ?, ?, ?, ?,
               'admitting', 'private', ?, ?, ?
          FROM problem_revisions AS revisions
          JOIN problem_series AS problems ON problems.id=revisions.problem_id
          JOIN catalogs ON catalogs.id=problems.catalog_id
          JOIN submission_sources AS sources ON sources.id=? AND sources.owner_user_id=? AND sources.state='reserved'
         WHERE revisions.problem_id=? AND revisions.commit_sha=?
           AND catalogs.active_commit_sha=revisions.commit_sha
           AND ((? IS NULL AND revisions.practice_enabled=1)
             OR (? IS NOT NULL AND EXISTS (
               SELECT 1 FROM contest_revision_problems
                WHERE contest_id=? AND commit_sha=revisions.commit_sha
                  AND problem_id=revisions.problem_id
             )))
           AND (SELECT COUNT(*) FROM submissions WHERE state IN ('admitting','queued')) < ?
           AND (SELECT COUNT(*) FROM submissions WHERE user_id=? AND state IN ('admitting','queued')) < ?`)
        .bind(
          submissionId, submissionId, timestamp, session.userId, input.contestId ?? null, sourceId,
          input.language, input.target, input.optimization, input.entry,
          timestamp, timestamp, timestamp,
          sourceId, session.userId, input.problemId, input.catalogCommit,
          input.contestId ?? null, input.contestId ?? null, input.contestId ?? null,
          MAX_QUEUED_SUBMISSIONS, session.userId, MAX_QUEUED_SUBMISSIONS_PER_USER,
        ),
      env.DB.prepare(`INSERT INTO submission_idempotency
          (user_id, idempotency_key, request_digest, submission_id, created_at)
        VALUES (?, ?, ?, ?, ?)`)
        .bind(session.userId, input.idempotencyKey, requestDigest, submissionId, timestamp),
    ]);
  } catch (error) {
    const winner = await env.DB.prepare("SELECT submission_id, request_digest FROM submission_idempotency WHERE user_id=? AND idempotency_key=?")
      .bind(session.userId, input.idempotencyKey).first<{ readonly submission_id: string; readonly request_digest: string }>();
    if (winner?.request_digest === requestDigest) return submissionCreatedResponse(request, env, winner.submission_id, true);
    const currentCapacity = await submissionCapacitySnapshot(env, session.userId);
    if (currentCapacity.userQueued >= MAX_QUEUED_SUBMISSIONS_PER_USER) {
      throw new ApiError(429, "submission-queue-full", "This account already has three queued submissions.");
    }
    if (currentCapacity.globalQueued >= MAX_QUEUED_SUBMISSIONS) {
      throw new ApiError(429, "submission-capacity", "The submission queue is temporarily full.");
    }
    throw error;
  }
  await putSourceConditional(env, sourceId, sourceBytes, sourceDigest);
  const finalized = await finalizeSourceAdmission(env, {
    sourceId,
    submissionId,
    userId: session.userId,
    erasureEpoch: user.erasure_epoch,
  });
  if (!finalized) {
    await beginSourceErasure(env, sourceId);
    await tombstoneSubmissionSource(env, sourceId);
    throw new ApiError(409, "submission-admission-erased", "Account erasure or authorization changed during source admission.");
  }
  await dispatchSubmissionJobs(env);
  return submissionCreatedResponse(request, env, submissionId, false);
}

async function submissionCreatedResponse(request: Request, env: WasmOjWorkerEnv, submissionId: string, replayed: boolean): Promise<Response> {
  const snapshot = await env.DB.prepare("SELECT state FROM submissions WHERE id=?")
    .bind(submissionId).first<{ readonly state: string }>();
  if (!snapshot) throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  const base = new URL(request.url);
  base.pathname = `/api/submissions/${submissionId}/events`;
  base.search = "";
  return jsonResponse({ submissionId, state: snapshot.state, eventCursor: 0, eventsUrl: base.toString(), replayed }, replayed ? 200 : 202);
}

export function submissionDetailReadable(row: Pick<SubmissionRow, "user_id" | "state" | "visibility">, viewerUserId?: string): boolean {
  return row.user_id === viewerUserId || (row.state === "completed" && row.visibility === "public");
}

export function submissionMayBecomePublic(row: Pick<SubmissionRow, "state">): boolean {
  return row.state === "completed";
}

export function publicSubmissionProjection(row: SubmissionRow): Record<string, unknown> {
  return {
    id: row.id,
    problemId: row.problem_id,
    catalogCommit: row.catalog_commit,
    judgeDigest: row.judge_digest,
    contestId: row.contest_id,
    language: row.language,
    target: row.target,
    optimization: row.optimization,
    entry: row.entry_path,
    state: row.state,
    verdict: row.verdict,
    visibility: row.visibility,
    score: row.score,
    fullyPassedCases: row.fully_passed_cases,
    deterministicCost: row.deterministic_cost,
    peakMemoryBytes: row.peak_memory_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function submissionProductProjection(row: SubmissionProductRow, viewerUserId?: string): Record<string, unknown> {
  return {
    ...publicSubmissionProjection(row),
    owner: row.user_id === viewerUserId,
    sourceAvailable: row.source_state === "ready",
    stale: row.stale === 1,
    judgedCommit: row.judged_commit,
    activeCommit: row.active_commit,
    problem: {
      slug: row.problem_slug,
      title: parseStoredProblemTitle(row.title_json),
    },
    contest: row.contest_record_id && row.contest_title !== null
      ? { id: row.contest_record_id, title: row.contest_title }
      : null,
  };
}

async function submissionProductRow(
  env: WasmOjWorkerEnv,
  submissionId: string,
): Promise<SubmissionProductRow | null> {
  return env.DB.prepare(`${SUBMISSION_PRODUCT_SELECT_SQL}
    WHERE origin.id=? AND origin.origin_submission_id=origin.id`)
    .bind(submissionId).first<SubmissionProductRow>();
}

export async function getSubmission(request: Request, env: WasmOjWorkerEnv, submissionId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const row = await submissionProductRow(env, submissionId);
  if (!row || !submissionDetailReadable(row, session?.userId)) throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  return jsonResponse({ submission: submissionProductProjection(row, session?.userId) });
}

export async function listOwnSubmissions(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  const query = parseSubmissionListQuery(new URL(request.url));
  const statement = env.DB.prepare(`${SUBMISSION_PRODUCT_SELECT_SQL}
    WHERE origin.user_id=? AND origin.origin_submission_id=origin.id
      ${query.cursor ? "AND (origin.created_at<? OR (origin.created_at=? AND origin.id<?))" : ""}
    ORDER BY origin.created_at DESC, origin.id DESC LIMIT ?`);
  const rows = query.cursor
    ? await statement.bind(
      session.userId,
      query.cursor.before,
      query.cursor.before,
      query.cursor.beforeId,
      query.limit + 1,
    ).all<SubmissionProductRow>()
    : await statement.bind(session.userId, query.limit + 1).all<SubmissionProductRow>();
  const hasMore = rows.results.length > query.limit;
  const page = rows.results.slice(0, query.limit);
  const tail = hasMore ? page.at(-1) : undefined;
  return jsonResponse({
    submissions: page.map((row) => submissionProductProjection(row, session.userId)),
    nextCursor: tail ? { before: tail.created_at, beforeId: tail.id } : null,
  });
}

export async function getSubmissionEvents(request: Request, env: WasmOjWorkerEnv, submissionId: string): Promise<Response> {
  const session = await requireSession(request, env);
  await submissionForOwner(env, submissionId, session.userId);
  const rawAfter = new URL(request.url).searchParams.get("after") ?? "0";
  if (!/^(?:0|[1-9][0-9]*)$/.test(rawAfter) || !Number.isSafeInteger(Number(rawAfter))) {
    throw new ApiError(400, "cursor-invalid", "Event cursor must be a non-negative safe integer.");
  }
  const after = Number(rawAfter);
  const events = await replaySubmissionEvents(env, submissionId, after, 100);
  const submission = await submissionProductRow(env, submissionId);
  if (!submission || submission.user_id !== session.userId) throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  return jsonResponse({
    events,
    nextCursor: events.at(-1)?.sequence ?? after,
    summary: {
      state: submission.state,
      verdict: submission.verdict,
      score: submission.score,
      fullyPassedCases: submission.fully_passed_cases,
      deterministicCost: submission.deterministic_cost,
      peakMemoryBytes: submission.peak_memory_bytes,
      updatedAt: submission.updated_at,
      completedAt: submission.completed_at,
    },
  });
}

export async function cancelSubmission(request: Request, env: WasmOjWorkerEnv, submissionId: string): Promise<Response> {
  // Cancellation remains available while formal admissions are paused so a
  // maintenance drain can converge without accepting any new durable work.
  const session = await requireBrowserOrBearerMutationSession(request, env);
  const row = await submissionForOwner(env, submissionId, session.userId);
  if (["completed", "compile-error", "judge-error", "infrastructure-error", "cancelled"].includes(row.state)) {
    return jsonResponse({ submissionId, state: row.state, changed: false });
  }
  const now = new Date().toISOString();
  const [claim] = await env.DB.batch([
    env.DB.prepare(`UPDATE submissions SET state='cancelled', verdict='cancelled', updated_at=?, completed_at=COALESCE(completed_at, ?)
      WHERE id=? AND user_id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')`)
      .bind(now, now, submissionId, session.userId),
    env.DB.prepare("UPDATE submission_attempts SET state='cancelled', finished_at=COALESCE(finished_at, ?) WHERE submission_id=? AND state IN ('created','running')")
      .bind(now, submissionId),
    env.DB.prepare(`UPDATE workflow_outbox SET state='cancelled', settled_at=?, updated_at=?, last_error='cancelled-before-delivery'
      WHERE submission_id=? AND state='pending'`)
      .bind(now, now, submissionId),
    prepareSubmissionEventInsert(env.DB, {
      submissionId,
      eventKey: "api:cancelled",
      event: { kind: "state", state: "cancelled" },
      timestamp: now,
      requiredState: "cancelled",
    }),
  ]);
  try { await env.SUBMISSION_WORKFLOW.get(submissionId).then((instance) => instance.terminate()); } catch { /* D1 cancellation is authoritative. */ }
  await dispatchSubmissionJobs(env);
  return jsonResponse({ submissionId, state: "cancelled", changed: claim?.meta.changes === 1 });
}

export async function updateSubmissionVisibility(request: Request, env: WasmOjWorkerEnv, submissionId: string): Promise<Response> {
  const session = await requireBrowserMutationSession(request, env);
  await requireFormalMutationsEnabled(env, request);
  const row = await submissionProductRow(env, submissionId);
  if (!row || row.user_id !== session.userId) throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  const body = await readJsonBody(request, 8 * 1024);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1) throw new ApiError(400, "visibility-invalid", "Visibility payload is invalid.");
  const visibility = (body as Record<string, unknown>).visibility;
  if (visibility !== "private" && visibility !== "public") throw new ApiError(400, "visibility-invalid", "Visibility must be private or public.");
  if (visibility === "public" && !submissionMayBecomePublic(row)) throw new ApiError(409, "submission-not-complete", "Only completed source can be made public.");
  if (visibility === "public" && row.contest_id) {
    const contest = await env.DB.prepare(`SELECT revisions.ends_at
      FROM contest_series AS contests
      JOIN catalogs ON catalogs.id=contests.catalog_id
      JOIN contest_revisions AS revisions
        ON revisions.contest_id=contests.id AND revisions.commit_sha=catalogs.active_commit_sha
      WHERE contests.id=?`).bind(row.contest_id).first<{ readonly ends_at: string }>();
    if (!contest || contest.ends_at > new Date().toISOString()) throw new ApiError(409, "contest-source-embargo", "Contest source remains private until the contest ends.");
  }
  await env.DB.prepare("UPDATE submissions SET visibility=?, updated_at=? WHERE id=?").bind(visibility, new Date().toISOString(), submissionId).run();
  return jsonResponse({ submissionId, visibility });
}

export async function publicSubmissionSource(request: Request, env: WasmOjWorkerEnv, submissionId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const row = await env.DB.prepare(`SELECT submissions.user_id, submissions.visibility, sources.id AS source_id,
      sources.state AS source_state, sources.content_sha256, sources.bytes
    FROM submissions JOIN submission_sources AS sources ON sources.id=submissions.source_id
    WHERE submissions.id=? AND NOT EXISTS (SELECT 1 FROM rejudge_jobs WHERE new_submission_id=submissions.id)`)
    .bind(submissionId).first<{
      readonly user_id: string;
      readonly visibility: string;
      readonly source_id: string;
      readonly source_state: string;
      readonly content_sha256: string | null;
      readonly bytes: number | null;
    }>();
  if (!row || (row.visibility !== "public" && row.user_id !== session?.userId)) throw new ApiError(404, "source-not-found", "Submission source is private.");
  if (row.source_state !== "ready" || !row.content_sha256 || !row.bytes) throw new ApiError(410, "source-erased", "Submission source was erased.");
  const source = await env.JUDGE_BUCKET.get(submissionSourceKey(row.source_id));
  if (!source || source.size !== row.bytes || source.customMetadata?.kind !== "submission-source" || source.customMetadata.sha256 !== row.content_sha256) {
    throw new ApiError(500, "source-object-integrity", "Submission source is unavailable or inconsistent.");
  }
  const bytes = new Uint8Array(await source.arrayBuffer());
  if (await sha256Hex(bytes) !== row.content_sha256) throw new ApiError(500, "source-object-integrity", "Submission source failed digest verification.");
  return new Response(bytes, { headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "cache-control": "private, no-store" } });
}

export interface SubmissionPolicySummary {
  readonly totalCases: number;
  readonly outputAcceptedCases: number;
  readonly policies: readonly [
    SubmissionPolicySummaryLevel,
    SubmissionPolicySummaryLevel,
    SubmissionPolicySummaryLevel,
  ];
}

export interface SubmissionPolicySummaryLevel {
  readonly id: "baseline" | "efficient" | "optimal";
  readonly earnedCases: number;
  readonly costExceededCases: number;
  readonly memoryExceededCases: number;
  readonly logicalTimeExceededCases: number;
}

function exactPolicyRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error(`${label} is invalid.`);
  }
  return record;
}

function policyCount(value: unknown, totalCases: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > totalCases) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number;
}

export function parseSubmissionPolicySummary(stored: string): SubmissionPolicySummary {
  if (stored.length < 1 || new TextEncoder().encode(stored).byteLength > 2 * 1024) {
    throw new Error("Submission policy summary is invalid.");
  }
  const root = exactPolicyRecord(JSON.parse(stored) as unknown, ["totalCases", "outputAcceptedCases", "policies"], "Submission policy summary");
  if (!Number.isSafeInteger(root.totalCases) || (root.totalCases as number) < 1 || (root.totalCases as number) > 10_000) {
    throw new Error("Submission policy total is invalid.");
  }
  const totalCases = root.totalCases as number;
  const outputAcceptedCases = policyCount(root.outputAcceptedCases, totalCases, "Submission output-accepted count");
  if (!Array.isArray(root.policies) || root.policies.length !== 3) throw new Error("Submission policy levels are invalid.");
  const expectedIds = ["baseline", "efficient", "optimal"] as const;
  const policies = root.policies.map((value, index): SubmissionPolicySummaryLevel => {
    const record = exactPolicyRecord(value, [
      "id", "earnedCases", "costExceededCases", "memoryExceededCases", "logicalTimeExceededCases",
    ], "Submission policy level");
    const id = expectedIds[index]!;
    if (record.id !== id) throw new Error("Submission policy order is invalid.");
    const earnedCases = policyCount(record.earnedCases, outputAcceptedCases, "Submission earned count");
    const costExceededCases = policyCount(record.costExceededCases, outputAcceptedCases, "Submission cost-exceeded count");
    const memoryExceededCases = policyCount(record.memoryExceededCases, outputAcceptedCases, "Submission memory-exceeded count");
    const logicalTimeExceededCases = policyCount(record.logicalTimeExceededCases, outputAcceptedCases, "Submission logical-time-exceeded count");
    if ([costExceededCases, memoryExceededCases, logicalTimeExceededCases]
      .some((failureCount) => earnedCases + failureCount > outputAcceptedCases)) {
      throw new Error("Submission policy level contradicts its earned cases.");
    }
    return {
      id,
      earnedCases,
      costExceededCases,
      memoryExceededCases,
      logicalTimeExceededCases,
    };
  }) as unknown as SubmissionPolicySummary["policies"];
  return { totalCases, outputAcceptedCases, policies };
}

export async function getSubmissionPolicySummary(request: Request, env: WasmOjWorkerEnv, submissionId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const row = await env.DB.prepare(`SELECT origin.user_id, origin.visibility, origin.contest_id,
      contest_revisions.ends_at AS contest_ends_at,
      COALESCE(result.state, origin.state) AS state,
      COALESCE(result.policy_summary_json, origin.policy_summary_json) AS policy_summary_json
    FROM submissions AS requested
    JOIN submissions AS origin ON origin.id=requested.origin_submission_id
    LEFT JOIN effective_submission_results AS effective
      ON effective.origin_submission_id=origin.id
    LEFT JOIN submissions AS result ON result.id=effective.effective_submission_id
    LEFT JOIN contest_series AS contests ON contests.id=origin.contest_id
    LEFT JOIN catalogs ON catalogs.id=contests.catalog_id
    LEFT JOIN contest_revisions ON contest_revisions.contest_id=contests.id
      AND contest_revisions.commit_sha=catalogs.active_commit_sha
    WHERE requested.id=?`)
    .bind(submissionId).first<{
      readonly user_id: string;
      readonly visibility: string;
      readonly contest_id: string | null;
      readonly contest_ends_at: string | null;
      readonly state: string;
      readonly policy_summary_json: string | null;
    }>();
  if (!row || !submissionDetailReadable(row, session?.userId)) {
    throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  }
  if (row.user_id !== session?.userId && row.contest_id !== null
    && (row.contest_ends_at === null || row.contest_ends_at > new Date().toISOString())) {
    throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  }
  if (row.state !== "completed" || row.policy_summary_json === null) {
    throw new ApiError(409, "policy-summary-unavailable", "Policy summary is unavailable for this submission.");
  }
  return jsonResponse({ submissionId, policySummary: parseSubmissionPolicySummary(row.policy_summary_json) }, 200, {
    "cache-control": "private, no-store",
    vary: "Cookie",
  });
}
