import { parseOfficialSubmissionRequest, type OfficialSubmissionRequest } from "../src/online-judge/contracts";
import { parseStoredProblemTitle } from "../src/online-judge/stored-problem-title";
import { authenticatedSession, requireMutationSession, requireSession } from "./auth";
import { sha256Hex } from "./crypto";
import type { AuthenticatedSession, ForgeWorkerEnv } from "./env";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { requireOfficialSubmissionRiskTurnstile, requireStagingFormalAccess } from "./formal-access";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { assertActiveRelease, readActiveRelease } from "./release";
import { assertProblemVersionAcceptsSubmission } from "./rejudge";
import { putImmutableMirroredObject } from "./immutable-r2";
import {
  abortFormalSubmissionAdmission,
  commitFormalSubmissionAdmission,
  formalSubmissionAdmissionClaimSha256,
  reconcileConcurrentFormalSubmissionWinner,
} from "./formal-admissions";
import {
  CANCEL_ACTIVE_SUBMISSION_ATTEMPTS_SQL,
  CANCEL_OWNED_NONTERMINAL_SUBMISSION_SQL,
  SETTLE_CANCELLED_SUBMISSION_OUTBOX_SQL,
} from "./submission-lifecycle";
import {
  prepareSubmissionEventInsert,
  replaySubmissionEvents,
} from "./submission-events";
import {
  MAX_NONTERMINAL_SUBMISSIONS,
  MAX_QUEUED_SUBMISSIONS_PER_USER,
  submissionCapacitySnapshot,
} from "./submission-capacity";
import { deriveSubmissionAttemptToken, type SubmissionWorkflowParameters } from "./submission-workflow-identity";
import { operationalLog } from "./structured-log";

interface ManagedProblemRow {
  readonly id: string;
  readonly problem_slug: string;
  readonly snapshot_status: string;
  readonly snapshot_mode: string;
  readonly forge_release_id: string;
  readonly allowed_languages_json: string;
  readonly compile_profiles_json: string;
}

interface SubmissionRow {
  readonly id: string;
  readonly user_id: string;
  readonly managed_problem_version_id: string;
  readonly contest_id: string | null;
  readonly language: string;
  readonly target: string;
  readonly optimization: string;
  readonly entry_path: string;
  readonly source_r2_key: string;
  readonly source_digest: string;
  readonly state: string;
  readonly visibility: string;
  readonly score: number | null;
  readonly fully_passed_cases: number | null;
  readonly deterministic_cost: number | null;
  readonly peak_memory_bytes: number | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

export const INSERT_OFFICIAL_SUBMISSION_SQL = `WITH candidate (
  id, user_id, managed_problem_version_id, contest_id, formal_admitted_at, formal_admission_claim_sha256,
  language, target, optimization, entry_path, source_r2_key, source_digest, forge_release_id,
  forge_manifest_sha256, created_at, updated_at, owner_fence_user_id
) AS (
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
)
INSERT INTO submissions
  (id, user_id, managed_problem_version_id, contest_id, formal_admitted_at, formal_admission_claim_sha256,
   language, target, optimization, entry_path,
   source_r2_key, source_digest, forge_release_id, forge_manifest_sha256, state, visibility, created_at, updated_at)
  SELECT id, user_id, managed_problem_version_id, contest_id, formal_admitted_at, formal_admission_claim_sha256,
         language, target, optimization, entry_path, source_r2_key, source_digest, forge_release_id,
         forge_manifest_sha256, 'admitting', 'private', created_at, updated_at
    FROM candidate
  WHERE NOT EXISTS (
    SELECT 1 FROM submission_owner_erasure_fences WHERE owner_user_id=candidate.owner_fence_user_id
  )
    AND (
      SELECT COUNT(*) FROM submissions
       WHERE state IN ('admitting','queued','waiting-capacity','preparing','compiling','running','finalizing')
    ) < ${MAX_NONTERMINAL_SUBMISSIONS}
    AND (
      SELECT COUNT(*) FROM submissions
       WHERE user_id=candidate.user_id AND state IN ('admitting','queued','waiting-capacity')
    ) < ${MAX_QUEUED_SUBMISSIONS_PER_USER}`;

export const INSERT_OFFICIAL_SUBMISSION_IDEMPOTENCY_SQL = `INSERT INTO submission_idempotency
  (user_id, idempotency_key, request_digest, submission_id, created_at)
  SELECT ?, ?, ?, ?, ?
  WHERE EXISTS (
    SELECT 1 FROM submissions
    WHERE id=? AND user_id=? AND source_r2_key=? AND source_digest=?
      AND formal_admitted_at=? AND formal_admission_claim_sha256=? AND contest_id IS ?
  )`;

export const INSERT_OFFICIAL_SUBMISSION_ATTEMPT_SQL = `INSERT INTO submission_attempts
  (submission_id, attempt, token_hash, container_key, state)
  SELECT ?, 1, ?, ?, 'created'
  WHERE EXISTS (
    SELECT 1 FROM submissions
    WHERE id=? AND user_id=? AND source_r2_key=? AND source_digest=?
      AND formal_admitted_at=? AND formal_admission_claim_sha256=? AND contest_id IS ?
  )`;

export const INSERT_OFFICIAL_SUBMISSION_OUTBOX_SQL = `INSERT INTO submission_outbox
  (id, submission_id, kind, payload_json, created_at)
  SELECT ?, ?, 'start-workflow', ?, ?
  WHERE EXISTS (
    SELECT 1 FROM submissions
    WHERE id=? AND user_id=? AND source_r2_key=? AND source_digest=?
      AND formal_admitted_at=? AND formal_admission_claim_sha256=? AND contest_id IS ?
  )`;

export const INSERT_FORMAL_SUBMISSION_ADMISSION_SQL = `WITH candidate (
  submission_id, managed_problem_version_id, user_id, contest_id, source_r2_key, source_sha256,
  created_at, expires_at, updated_at, admitted_at
) AS (
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
INSERT INTO formal_submission_admissions
  (submission_id, managed_problem_version_id, user_id, contest_id, admitted_at, state,
   source_r2_key, source_sha256, cleanup_state, created_at, expires_at, updated_at)
  SELECT candidate.submission_id, candidate.managed_problem_version_id, candidate.user_id,
         candidate.contest_id, candidate.admitted_at, 'pending', candidate.source_r2_key,
         candidate.source_sha256, 'pending', candidate.created_at, candidate.expires_at, candidate.updated_at
  FROM candidate
  WHERE EXISTS (
    SELECT 1 FROM users WHERE id=candidate.user_id AND status='active'
  )
    AND NOT EXISTS (
      SELECT 1 FROM account_erasure_jobs WHERE user_id=candidate.user_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM rejudge_batches
      WHERE old_problem_version_id=candidate.managed_problem_version_id AND status IN ('queued','running','ready')
    )
    AND NOT EXISTS (
      SELECT 1 FROM effective_problem_versions WHERE original_problem_version_id=candidate.managed_problem_version_id
    )
    AND (
      candidate.contest_id IS NULL
      OR EXISTS (
        SELECT 1
          FROM contests
          JOIN contest_problems ON contest_problems.contest_id=contests.id
         WHERE contests.id=candidate.contest_id
           AND contest_problems.managed_problem_version_id=candidate.managed_problem_version_id
           AND contests.status IN ('published','running')
           AND contests.starts_at<=candidate.admitted_at
           AND contests.ends_at>candidate.admitted_at
           AND (
             contests.access_mode='public'
             OR EXISTS (
               SELECT 1 FROM contest_participants
                WHERE contest_id=contests.id AND user_id=candidate.user_id
             )
           )
      )
    )`;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]));
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(canonicalValue(value))}\n`);
}

function sha256Bytes(digest: string): Uint8Array {
  return Uint8Array.from(digest.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

async function putMirroredSource(
  env: ForgeWorkerEnv,
  key: string,
  bytes: Uint8Array,
  digest: string,
  metadata: Record<string, string>,
): Promise<void> {
  const options = {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { ...metadata, sha256: digest },
    sha256: sha256Bytes(digest),
  } satisfies R2PutOptions;
  await putImmutableMirroredObject(env.JUDGE_BUCKET, env.JUDGE_MIRROR_BUCKET, key, bytes, digest, options);
}

async function managedProblem(env: ForgeWorkerEnv, id: string): Promise<ManagedProblemRow> {
  const row = await env.CORE_DB.prepare(
    "SELECT managed_problem_versions.id, managed_problem_versions.problem_slug, managed_problem_versions.allowed_languages_json, managed_problem_versions.compile_profiles_json, managed_snapshots.status AS snapshot_status, managed_snapshots.mode AS snapshot_mode, collection_imports.forge_release_id FROM managed_problem_versions JOIN managed_snapshots ON managed_snapshots.id = managed_problem_versions.snapshot_id JOIN collection_imports ON collection_imports.id = managed_snapshots.import_id WHERE managed_problem_versions.id = ?",
  ).bind(id).first<ManagedProblemRow>();
  if (!row || row.snapshot_status !== "published") throw new ApiError(404, "managed-problem-not-found", "Managed problem version is not published.");
  return row;
}

async function verifyContestAdmission(
  env: ForgeWorkerEnv,
  session: AuthenticatedSession,
  request: OfficialSubmissionRequest,
): Promise<void> {
  if (!request.contestId) return;
  const contest = await env.CORE_DB.prepare(
    "SELECT contests.starts_at, contests.ends_at, contests.status, contests.access_mode, contest_problems.managed_problem_version_id, contest_participants.user_id AS participant_user_id FROM contests JOIN contest_problems ON contest_problems.contest_id = contests.id LEFT JOIN contest_participants ON contest_participants.contest_id = contests.id AND contest_participants.user_id = ? WHERE contests.id = ? AND contest_problems.managed_problem_version_id = ?",
  ).bind(session.userId, request.contestId, request.managedProblemVersionId).first<{
    starts_at: string; ends_at: string; status: string; access_mode: string; managed_problem_version_id: string; participant_user_id: string | null;
  }>();
  const now = new Date().toISOString();
  if (!contest || !["published", "running"].includes(contest.status) || now < contest.starts_at || now >= contest.ends_at) {
    throw new ApiError(409, "contest-not-running", "Contest is not accepting submissions.");
  }
  if (contest.access_mode === "invite" && contest.participant_user_id !== session.userId) {
    throw new ApiError(403, "contest-invite-required", "Join this invite-only contest before submitting.");
  }
}

async function submissionForOwner(env: ForgeWorkerEnv, submissionId: string, userId: string): Promise<SubmissionRow> {
  const row = await env.SUBMISSIONS_DB.prepare("SELECT * FROM submissions WHERE id = ? AND user_id = ? AND rejudge_batch_id IS NULL")
    .bind(submissionId, userId).first<SubmissionRow>();
  if (!row) throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  return row;
}

export async function createSubmission(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  const input = parseOfficialSubmissionRequest(await readJsonBody(request, 2 * 1024 * 1024));
  const problem = await managedProblem(env, input.managedProblemVersionId);
  const allowedLanguages = JSON.parse(problem.allowed_languages_json) as unknown;
  const compileProfiles = JSON.parse(problem.compile_profiles_json) as unknown;
  const selectedProfile = compileProfiles && typeof compileProfiles === "object" && !Array.isArray(compileProfiles)
    ? (compileProfiles as Record<string, { target?: unknown; optimization?: unknown }>)[input.language]
    : undefined;
  if (!Array.isArray(allowedLanguages) || !allowedLanguages.includes(input.language) || selectedProfile?.target !== input.target || selectedProfile.optimization !== input.optimization) {
    throw new ApiError(409, "compile-profile-not-allowed", "Language, target, or optimization is not allowed by this managed problem version.");
  }
  if (!input.contestId && problem.snapshot_mode !== "official-practice") {
    throw new ApiError(409, "contest-context-required", "Contest problem versions require a contest submission context.");
  }
  await verifyContestAdmission(env, session, input);
  const requestDigest = await sha256Hex(canonicalBytes(input));
  const existing = await env.SUBMISSIONS_DB.prepare("SELECT submission_id, request_digest FROM submission_idempotency WHERE user_id = ? AND idempotency_key = ?")
    .bind(session.userId, input.idempotencyKey).first<{ submission_id: string; request_digest: string }>();
  if (existing) {
    if (existing.request_digest !== requestDigest) throw new ApiError(409, "idempotency-conflict", "Idempotency key was already used for different source.");
    const current = await submissionForOwner(env, existing.submission_id, session.userId);
    try {
      await commitFormalSubmissionAdmission(env, {
        submissionId: current.id,
        managedProblemVersionId: current.managed_problem_version_id,
        userId: current.user_id,
      });
    } catch {
      throw new ApiError(503, "submission-admission-reconciling", "The committed submission is waiting for admission reconciliation.");
    }
    return submissionCreatedResponse(request, env, current.id, true);
  }
  await requireFormalMutationsEnabled(env);
  const formalRiskRequestKey = await sha256Hex(canonicalBytes({ idempotencyKey: input.idempotencyKey, requestDigest }));
  await requireOfficialSubmissionRiskTurnstile(request, env, session.userId, formalRiskRequestKey);
  await assertProblemVersionAcceptsSubmission(env, problem.id);
  const initialCapacity = await submissionCapacitySnapshot(env, session.userId);
  if (initialCapacity.userQueued >= MAX_QUEUED_SUBMISSIONS_PER_USER) {
    throw new ApiError(429, "submission-queue-full", "This account already has three queued submissions.");
  }
  if (initialCapacity.globalNonterminal >= MAX_NONTERMINAL_SUBMISSIONS) {
    throw new ApiError(429, "submission-capacity", "The submission queue is temporarily full.");
  }
  const activeRelease = await assertActiveRelease(env.CORE_DB, env.JUDGE_BUCKET, env.ENVIRONMENT, problem.forge_release_id);
  const submissionId = crypto.randomUUID();
  const attemptToken = await deriveSubmissionAttemptToken(env.ACCOUNT_ERASURE_HMAC_SECRET, submissionId, 1);
  const compileRequest = {
    language: input.language,
    target: input.target,
    optimization: input.optimization,
    entry: input.entry,
    sourceFiles: input.sourceFiles,
  };
  const sourceSnapshot = {
    schema: "forge-official-source-v1",
    sourceDigest: await sha256Hex(canonicalBytes(compileRequest)),
    request: compileRequest,
  };
  const sourceBytes = canonicalBytes(sourceSnapshot);
  const sourceDigest = await sha256Hex(sourceBytes);
  const sourceR2Key = `sources/${session.userId}/${submissionId}.${sourceDigest}.json`;
  const workflowParameters = {
    submissionId,
    attempt: 1,
    expectedReleaseId: activeRelease.releaseId,
    expectedManifestSha256: activeRelease.manifestSha256,
  } satisfies SubmissionWorkflowParameters;
  let databaseCommitted = false;
  await verifyContestAdmission(env, session, input);
  const markerCreatedAt = new Date().toISOString();
  const marker = await env.CORE_DB.prepare(INSERT_FORMAL_SUBMISSION_ADMISSION_SQL)
    .bind(
      submissionId,
      problem.id,
      session.userId,
      input.contestId ?? null,
      sourceR2Key,
      sourceDigest,
      markerCreatedAt,
      new Date(Date.now() + 5 * 60 * 1_000).toISOString(),
      markerCreatedAt,
    ).run();
  if (marker.meta.changes !== 1) {
    const owner = await env.CORE_DB.prepare("SELECT users.status, account_erasure_jobs.id AS erasure_job_id FROM users LEFT JOIN account_erasure_jobs ON account_erasure_jobs.user_id=users.id WHERE users.id=?")
      .bind(session.userId).first<{ readonly status: string; readonly erasure_job_id: string | null }>();
    if (!owner || owner.status !== "active" || owner.erasure_job_id) throw new ApiError(403, "formal-owner-revoked", "This account no longer accepts formal work.");
    if (input.contestId) await verifyContestAdmission(env, session, input);
    throw new ApiError(409, "problem-version-superseded", "This managed problem version no longer accepts formal submissions.");
  }
  operationalLog("info", {
    event: "submission.admission-progress",
    outcome: "success",
    code: "marker-created",
    environment: env.ENVIRONMENT,
  });
  let admissionStage = "marker-created";
  try {
    const markerClaim = await env.CORE_DB.prepare(
      `SELECT contest_id, admitted_at, source_r2_key, source_sha256
         FROM formal_submission_admissions
        WHERE submission_id=? AND managed_problem_version_id=? AND user_id=? AND state='pending'`,
    ).bind(submissionId, problem.id, session.userId).first<{
      readonly contest_id: string | null;
      readonly admitted_at: string;
      readonly source_r2_key: string;
      readonly source_sha256: string;
    }>();
    if (
      !markerClaim
      || markerClaim.contest_id !== (input.contestId ?? null)
      || markerClaim.source_r2_key !== sourceR2Key
      || markerClaim.source_sha256 !== sourceDigest
    ) throw new Error("Formal submission admission claim read-back failed.");
    const admissionClaimSha256 = await formalSubmissionAdmissionClaimSha256({
      submissionId,
      managedProblemVersionId: problem.id,
      userId: session.userId,
      contestId: markerClaim.contest_id,
      admittedAt: markerClaim.admitted_at,
      sourceR2Key,
      sourceSha256: sourceDigest,
    });
    const now = markerClaim.admitted_at;
    await putMirroredSource(env, sourceR2Key, sourceBytes, sourceDigest, { submissionId, userId: session.userId });
    admissionStage = "source-stored";
    operationalLog("info", {
      event: "submission.admission-progress",
      outcome: "success",
      code: admissionStage,
      environment: env.ENVIRONMENT,
    });
    await assertProblemVersionAcceptsSubmission(env, problem.id);
    const outboxId = crypto.randomUUID();
    const [insertedSubmission, insertedIdempotency, insertedAttempt, insertedOutbox] = await env.SUBMISSIONS_DB.batch([
      env.SUBMISSIONS_DB.prepare(INSERT_OFFICIAL_SUBMISSION_SQL)
        .bind(submissionId, session.userId, input.managedProblemVersionId, input.contestId ?? null, markerClaim.admitted_at, admissionClaimSha256, input.language, input.target, input.optimization, input.entry, sourceR2Key, sourceDigest, problem.forge_release_id, activeRelease.manifestSha256, now, now, session.userId),
      env.SUBMISSIONS_DB.prepare(INSERT_OFFICIAL_SUBMISSION_IDEMPOTENCY_SQL)
        .bind(session.userId, input.idempotencyKey, requestDigest, submissionId, now, submissionId, session.userId, sourceR2Key, sourceDigest, markerClaim.admitted_at, admissionClaimSha256, input.contestId ?? null),
      env.SUBMISSIONS_DB.prepare(INSERT_OFFICIAL_SUBMISSION_ATTEMPT_SQL)
        .bind(submissionId, await sha256Hex(attemptToken), `${submissionId}:1`, submissionId, session.userId, sourceR2Key, sourceDigest, markerClaim.admitted_at, admissionClaimSha256, input.contestId ?? null),
      env.SUBMISSIONS_DB.prepare(INSERT_OFFICIAL_SUBMISSION_OUTBOX_SQL)
        .bind(outboxId, submissionId, JSON.stringify(workflowParameters), now, submissionId, session.userId, sourceR2Key, sourceDigest, markerClaim.admitted_at, admissionClaimSha256, input.contestId ?? null),
    ]);
    if ([insertedSubmission, insertedIdempotency, insertedAttempt, insertedOutbox].some((result) => result?.meta.changes !== 1)) {
      const capacity = await submissionCapacitySnapshot(env, session.userId);
      if (capacity.userQueued >= MAX_QUEUED_SUBMISSIONS_PER_USER) {
        throw new ApiError(429, "submission-queue-full", "This account already has three queued submissions.");
      }
      if (capacity.globalNonterminal >= MAX_NONTERMINAL_SUBMISSIONS) {
        throw new ApiError(429, "submission-capacity", "The submission queue is temporarily full.");
      }
      throw new Error("Official submission admission lost its owner-erasure transaction fence.");
    }
    databaseCommitted = true;
    await commitFormalSubmissionAdmission(env, {
      submissionId,
      managedProblemVersionId: input.managedProblemVersionId,
      userId: session.userId,
    });
    await env.SUBMISSION_WORKFLOW.create({
      id: submissionId,
      params: workflowParameters,
    });
    await env.SUBMISSIONS_DB.prepare("UPDATE submission_outbox SET delivered_at = ?, attempts = attempts + 1, payload_json = '{}' WHERE id = ?")
      .bind(new Date().toISOString(), outboxId).run();
    return submissionCreatedResponse(request, env, submissionId, false);
  } catch (error) {
    operationalLog("error", {
      event: "submission.admission-failed",
      outcome: "failure",
      code: admissionStage,
      environment: env.ENVIRONMENT,
    });
    if (!databaseCommitted) {
      const winner = await env.SUBMISSIONS_DB.prepare("SELECT submission_id, request_digest FROM submission_idempotency WHERE user_id = ? AND idempotency_key = ?")
        .bind(session.userId, input.idempotencyKey).first<{ submission_id: string; request_digest: string }>();
      if (winner?.request_digest === requestDigest) {
        const current = await submissionForOwner(env, winner.submission_id, session.userId);
        try {
          await reconcileConcurrentFormalSubmissionWinner(env, {
            winner: {
              submissionId: current.id,
              managedProblemVersionId: current.managed_problem_version_id,
              userId: current.user_id,
            },
            loser: {
              submissionId,
              managedProblemVersionId: problem.id,
              userId: session.userId,
            },
          });
        } catch {
          throw new ApiError(503, "submission-admission-reconciling", "The committed submission is waiting for admission reconciliation.");
        }
        return submissionCreatedResponse(request, env, current.id, true);
      }
      try {
        await abortFormalSubmissionAdmission(env, {
          submissionId,
          managedProblemVersionId: problem.id,
          userId: session.userId,
        });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Submission admission and its deterministic cleanup both failed.");
      }
    }
    throw error;
  }
}

async function submissionCreatedResponse(
  request: Request,
  env: ForgeWorkerEnv,
  submissionId: string,
  replayed: boolean,
): Promise<Response> {
  const snapshot = await env.SUBMISSIONS_DB.prepare(`SELECT state,
      (SELECT COALESCE(MAX(id), 0) FROM submission_events WHERE submission_id=submissions.id) AS event_cursor
    FROM submissions WHERE id=?`)
    .bind(submissionId).first<{ readonly state: string; readonly event_cursor: number }>();
  if (!snapshot) throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  const base = new URL(request.url);
  base.pathname = `/api/submissions/${submissionId}/events`;
  base.search = "";
  return jsonResponse({
    submissionId,
    state: snapshot.state,
    eventCursor: snapshot.event_cursor,
    eventsUrl: base.toString(),
    replayed,
  }, replayed ? 200 : 202);
}

export async function getSubmission(request: Request, env: ForgeWorkerEnv, submissionId: string): Promise<Response> {
  const session = await requireSession(request, env);
  const row = await submissionForOwner(env, submissionId, session.userId);
  const [problem, contest] = await Promise.all([
    env.CORE_DB.prepare("SELECT problem_slug, title_json FROM managed_problem_versions WHERE id=?")
      .bind(row.managed_problem_version_id).first<{ problem_slug: string; title_json: string }>(),
    row.contest_id
      ? env.CORE_DB.prepare("SELECT id, title FROM contests WHERE id=?").bind(row.contest_id).first<{ id: string; title: string }>()
      : Promise.resolve(null),
  ]);
  return jsonResponse({ submission: {
    ...publicSubmissionProjection(row),
    problem: problem ? { slug: problem.problem_slug, title: parseStoredProblemTitle(problem.title_json) } : null,
    contest: contest ? { id: contest.id, title: contest.title } : null,
  } });
}

export async function listOwnSubmissions(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
  const before = url.searchParams.get("before");
  const beforeId = url.searchParams.get("beforeId");
  if ((before === null) !== (beforeId === null)) throw new ApiError(400, "submission-cursor-invalid", "Submission cursor fields must be provided together.");
  if (before !== null && (Number.isNaN(Date.parse(before)) || new Date(before).toISOString() !== before || !beforeId || !/^[0-9a-f-]{36}$/.test(beforeId))) {
    throw new ApiError(400, "submission-cursor-invalid", "Submission cursor is invalid.");
  }
  const rows = await env.SUBMISSIONS_DB.prepare(`SELECT id, user_id, managed_problem_version_id, contest_id, language, target, optimization, entry_path, source_r2_key, source_digest, state, visibility, score, fully_passed_cases, deterministic_cost, peak_memory_bytes, created_at, updated_at, completed_at
    FROM submissions
    WHERE user_id=? AND (? IS NULL OR created_at<? OR (created_at=? AND id<?))
    ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(session.userId, before, before, before, beforeId, limit).all<SubmissionRow>();
  const problemIds = [...new Set(rows.results.map((row) => row.managed_problem_version_id))];
  const contestIds = [...new Set(rows.results.flatMap((row) => row.contest_id ? [row.contest_id] : []))];
  const problems = problemIds.length === 0 ? [] : (await env.CORE_DB.prepare(`SELECT id, problem_slug, title_json FROM managed_problem_versions WHERE id IN (${problemIds.map(() => "?").join(",")})`)
    .bind(...problemIds).all<{ id: string; problem_slug: string; title_json: string }>()).results;
  const contests = contestIds.length === 0 ? [] : (await env.CORE_DB.prepare(`SELECT id, title FROM contests WHERE id IN (${contestIds.map(() => "?").join(",")})`)
    .bind(...contestIds).all<{ id: string; title: string }>()).results;
  const problemById = new Map(problems.map((problem) => [problem.id, problem] as const));
  const contestById = new Map(contests.map((contest) => [contest.id, contest] as const));
  const last = rows.results.at(-1);
  return jsonResponse({
    submissions: rows.results.map((row) => {
      const problem = problemById.get(row.managed_problem_version_id);
      return {
        ...publicSubmissionProjection(row),
        problem: problem ? { slug: problem.problem_slug, title: parseStoredProblemTitle(problem.title_json) } : null,
        contest: row.contest_id ? { id: row.contest_id, title: contestById.get(row.contest_id)?.title ?? "Contest" } : null,
      };
    }),
    nextCursor: rows.results.length === limit && last ? { before: last.created_at, beforeId: last.id } : null,
  });
}

export function publicSubmissionProjection(row: SubmissionRow): Record<string, unknown> {
  return {
    id: row.id,
    managedProblemVersionId: row.managed_problem_version_id,
    contestId: row.contest_id,
    language: row.language,
    target: row.target,
    optimization: row.optimization,
    entry: row.entry_path,
    state: row.state,
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

export async function getSubmissionEvents(request: Request, env: ForgeWorkerEnv, submissionId: string): Promise<Response> {
  const session = await requireSession(request, env);
  const submission = await submissionForOwner(env, submissionId, session.userId);
  const source = new URL(request.url);
  const rawAfter = source.searchParams.get("after") ?? "0";
  if (!/^(?:0|[1-9][0-9]*)$/.test(rawAfter)) {
    throw new ApiError(400, "cursor-invalid", "Event cursor must be a non-negative integer.");
  }
  const after = Number(rawAfter);
  if (!Number.isSafeInteger(after)) throw new ApiError(400, "cursor-invalid", "Event cursor is too large.");
  const events = await replaySubmissionEvents(env, submissionId, after, 100);
  return jsonResponse({
    events,
    nextCursor: events.at(-1)?.sequence ?? after,
    state: submission.state,
  });
}

export async function cancelSubmission(request: Request, env: ForgeWorkerEnv, submissionId: string): Promise<Response> {
  const session = await requireMutationSession(request, env);
  const row = await submissionForOwner(env, submissionId, session.userId);
  if (["completed", "compile-error", "judge-error", "infrastructure-error"].includes(row.state)) {
    return jsonResponse({ submissionId, state: row.state, changed: false });
  }
  const now = new Date().toISOString();
  const [claim] = await env.SUBMISSIONS_DB.batch([
    env.SUBMISSIONS_DB.prepare(CANCEL_OWNED_NONTERMINAL_SUBMISSION_SQL)
      .bind(now, now, submissionId, session.userId),
    env.SUBMISSIONS_DB.prepare(CANCEL_ACTIVE_SUBMISSION_ATTEMPTS_SQL)
      .bind(now, submissionId, submissionId),
    env.SUBMISSIONS_DB.prepare(SETTLE_CANCELLED_SUBMISSION_OUTBOX_SQL)
      .bind(now, "cancelled-before-delivery", submissionId, submissionId),
    prepareSubmissionEventInsert(env.SUBMISSIONS_DB, {
      submissionId,
      eventKey: "api:cancelled",
      event: { kind: "state", state: "cancelled" },
      timestamp: now,
      requiredState: "cancelled",
    }),
  ]);
  const changed = claim?.meta.changes === 1;
  if (!changed) {
    const current = await submissionForOwner(env, submissionId, session.userId);
    if (current.state !== "cancelled") return jsonResponse({ submissionId, state: current.state, changed: false });
  }
  try {
    await env.SUBMISSION_WORKFLOW.get(submissionId).then((instance) => instance.terminate());
  } catch {
    operationalLog("warn", {
      event: "workflow.delivery-deferred",
      outcome: "deferred",
      code: "cancelled-in-d1",
      aggregateType: "submission",
      aggregateId: submissionId,
    });
  }
  return jsonResponse({ submissionId, state: "cancelled", changed });
}

export async function updateSubmissionVisibility(request: Request, env: ForgeWorkerEnv, submissionId: string): Promise<Response> {
  const session = await requireMutationSession(request, env);
  const row = await submissionForOwner(env, submissionId, session.userId);
  const body = await readJsonBody(request, 8 * 1024);
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "visibility") || Object.keys(body).length !== 1) {
    throw new ApiError(400, "visibility-invalid", "Visibility payload is invalid.");
  }
  const visibility = (body as { visibility?: unknown }).visibility;
  if (visibility !== "private" && visibility !== "public") throw new ApiError(400, "visibility-invalid", "Visibility must be private or public.");
  if (visibility === "public" && row.state !== "completed") throw new ApiError(409, "submission-not-complete", "Only completed source can be made public.");
  if (visibility === "public" && row.contest_id) {
    const contest = await env.CORE_DB.prepare("SELECT ends_at FROM contests WHERE id = ?").bind(row.contest_id).first<{ ends_at: string }>();
    if (!contest || contest.ends_at > new Date().toISOString()) throw new ApiError(409, "contest-source-embargo", "Contest source remains private until the contest ends.");
  }
  await env.SUBMISSIONS_DB.prepare("UPDATE submissions SET visibility = ?, updated_at = ? WHERE id = ?")
    .bind(visibility, new Date().toISOString(), submissionId).run();
  return jsonResponse({ submissionId, visibility });
}

export async function publicSubmissionSource(request: Request, env: ForgeWorkerEnv, submissionId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const row = await env.SUBMISSIONS_DB.prepare("SELECT * FROM submissions WHERE id = ? AND rejudge_batch_id IS NULL")
    .bind(submissionId).first<SubmissionRow>();
  if (!row || (row.visibility !== "public" && row.user_id !== session?.userId)) throw new ApiError(404, "source-not-found", "Submission source is private.");
  const [primary, mirror] = await Promise.all([
    env.JUDGE_BUCKET.get(row.source_r2_key),
    env.JUDGE_MIRROR_BUCKET.get(row.source_r2_key),
  ]);
  if (
    !primary || !mirror
    || primary.size < 1 || primary.size > 2 * 1024 * 1024
    || mirror.size !== primary.size
    || primary.customMetadata?.sha256 !== row.source_digest
    || mirror.customMetadata?.sha256 !== row.source_digest
  ) throw new ApiError(500, "source-object-integrity", "Submission source mirror is unavailable or inconsistent.");
  const [primaryBytes, mirrorBytes] = await Promise.all([
    primary.arrayBuffer().then((value) => new Uint8Array(value)),
    mirror.arrayBuffer().then((value) => new Uint8Array(value)),
  ]);
  const [primaryDigest, mirrorDigest] = await Promise.all([sha256Hex(primaryBytes), sha256Hex(mirrorBytes)]);
  if (primaryDigest !== row.source_digest || mirrorDigest !== row.source_digest) {
    throw new ApiError(500, "source-object-integrity", "Submission source mirror failed digest verification.");
  }
  return new Response(primaryBytes, {
    headers: {
      "content-type": "application/json",
      "content-length": String(primaryBytes.byteLength),
      "cache-control": "private, no-store",
    },
  });
}

export async function managedMatch(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const repository = url.searchParams.get("repository");
  const revision = url.searchParams.get("revision");
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !revision || !/^[0-9a-f]{64}$/.test(revision)) {
    throw new ApiError(400, "managed-match-invalid", "repository and collection revision are required.");
  }
  const [owner, name] = repository.split("/");
  const activeRelease = await readActiveRelease(env.CORE_DB, env.JUDGE_BUCKET, env.ENVIRONMENT);
  const result = await env.CORE_DB.prepare(
    "SELECT managed_snapshots.id AS snapshot_id, managed_problem_versions.problem_slug, managed_problem_versions.id AS problem_version_id FROM github_repositories JOIN collection_imports ON collection_imports.github_repository_id = github_repositories.github_repository_id JOIN managed_snapshots ON managed_snapshots.import_id = collection_imports.id JOIN managed_problem_versions ON managed_problem_versions.snapshot_id = managed_snapshots.id WHERE github_repositories.owner_login = ? COLLATE NOCASE AND github_repositories.name = ? COLLATE NOCASE AND github_repositories.is_private = 0 AND managed_snapshots.collection_revision = ? AND managed_snapshots.mode = 'official-practice' AND managed_snapshots.status = 'published' AND collection_imports.forge_release_id = ? AND NOT EXISTS (SELECT 1 FROM effective_problem_versions WHERE original_problem_version_id=managed_problem_versions.id) AND NOT EXISTS (SELECT 1 FROM rejudge_batches WHERE old_problem_version_id=managed_problem_versions.id AND status IN ('queued','running','ready')) ORDER BY managed_problem_versions.problem_number",
  ).bind(owner, name, revision, activeRelease.releaseId).all<{ snapshot_id: string; problem_slug: string; problem_version_id: string }>();
  if (result.results.length === 0) return jsonResponse({ matched: false });
  return jsonResponse({
    matched: true,
    snapshotId: result.results[0]?.snapshot_id,
    problems: Object.fromEntries(result.results.map((row) => [row.problem_slug, row.problem_version_id])),
  });
}
