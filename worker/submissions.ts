import { parseOfficialSubmissionRequest, type OfficialSubmissionRequest, type SubmissionVerdict } from "../src/online-judge/contracts";
import { parseStoredProblemTitle } from "../src/online-judge/stored-problem-title";
import { authenticatedSession, requireMutationSession, requireSession } from "./auth";
import { sha256Hex } from "./crypto";
import type { AuthenticatedSession, ForgeWorkerEnv } from "./env";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { requireOfficialSubmissionRiskTurnstile, requireStagingFormalAccess } from "./formal-access";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { assertActiveRelease } from "./release";
import { assertProblemVersionAcceptsSubmission } from "./rejudge";
import { putImmutableObject } from "./immutable-r2";
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
  readonly source_erased_at: string | null;
  readonly forge_release_id: string;
  readonly forge_manifest_sha256: string;
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

export const INSERT_OFFICIAL_SUBMISSION_SQL = `WITH candidate (
  id, user_id, managed_problem_version_id, contest_id, language, target, optimization,
  entry_path, source_r2_key, source_digest, forge_release_id, forge_manifest_sha256,
  environment, admitted_at
) AS (
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
INSERT INTO submissions (
  id, user_id, managed_problem_version_id, contest_id, language, target, optimization,
  entry_path, source_r2_key, source_digest, forge_release_id, forge_manifest_sha256,
  state, visibility, admitted_at, created_at, updated_at
)
SELECT id, user_id, managed_problem_version_id, contest_id, language, target, optimization,
       entry_path, source_r2_key, source_digest, forge_release_id, forge_manifest_sha256,
       'admitting', 'private', admitted_at, admitted_at, admitted_at
FROM candidate
WHERE EXISTS (SELECT 1 FROM users WHERE id=candidate.user_id AND status='active')
  AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=candidate.user_id)
  AND EXISTS (
    SELECT 1 FROM formal_mutation_controls
    WHERE environment=candidate.environment AND formal_mutations_enabled=1
  )
  AND EXISTS (
    SELECT 1
    FROM managed_problem_versions
    JOIN managed_snapshots ON managed_snapshots.id=managed_problem_versions.snapshot_id
    WHERE managed_problem_versions.id=candidate.managed_problem_version_id
      AND managed_snapshots.status='published'
      AND (
        (candidate.contest_id IS NULL AND managed_snapshots.mode='official-practice')
        OR (candidate.contest_id IS NOT NULL AND managed_snapshots.mode='contest')
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM rejudge_batches
    WHERE old_problem_version_id=candidate.managed_problem_version_id
      AND status IN ('queued','running','ready')
  )
  AND NOT EXISTS (
    SELECT 1 FROM effective_problem_versions
    WHERE original_problem_version_id=candidate.managed_problem_version_id
  )
  AND (
    candidate.contest_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM contests
      JOIN contest_problems ON contest_problems.contest_id=contests.id
      WHERE contests.id=candidate.contest_id
        AND contest_problems.managed_problem_version_id=candidate.managed_problem_version_id
        AND contests.status='published'
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
  )
  AND NOT EXISTS (
    SELECT 1 FROM submission_idempotency
    WHERE user_id=candidate.user_id AND idempotency_key=?
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
  SELECT ?, ?, ?, ?, admitted_at
  FROM submissions
  WHERE id=? AND user_id=? AND state='admitting'
    AND source_r2_key=? AND source_digest=?
  `;

export const INSERT_OFFICIAL_SUBMISSION_ATTEMPT_SQL = `INSERT INTO submission_attempts
  (submission_id, attempt, token_hash, container_key, state)
  SELECT id, 1, ?, ?, 'created'
  FROM submissions
  WHERE id=? AND user_id=? AND state='admitting'
    AND source_r2_key=? AND source_digest=?
  ON CONFLICT(submission_id, attempt) DO NOTHING`;

export const INSERT_OFFICIAL_SUBMISSION_OUTBOX_SQL = `INSERT INTO outbox
  (id, kind, aggregate_id, payload_json, created_at)
  SELECT ?, 'start-submission-workflow', id, ?, admitted_at
  FROM submissions
  WHERE id=? AND user_id=? AND state='admitting'
    AND source_r2_key=? AND source_digest=?
  ON CONFLICT DO NOTHING`;

export const QUEUE_ADMITTED_SUBMISSION_SQL = `UPDATE submissions
  SET state='queued', updated_at=?
  WHERE id=? AND user_id=? AND state='admitting'
    AND source_r2_key=? AND source_digest=?
    AND EXISTS (
      SELECT 1 FROM submission_attempts
      WHERE submission_id=submissions.id AND attempt=1 AND state='created'
    )
    AND EXISTS (
      SELECT 1 FROM outbox
      WHERE aggregate_id=submissions.id AND kind='start-submission-workflow' AND delivered_at IS NULL
    )
    AND EXISTS (SELECT 1 FROM users WHERE users.id=submissions.user_id AND users.status='active')
    AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=submissions.user_id)`;

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

async function putSource(
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
  await putImmutableObject(env.JUDGE_BUCKET, key, bytes, digest, options);
}

async function managedProblem(env: ForgeWorkerEnv, id: string): Promise<ManagedProblemRow> {
  const row = await env.DB.prepare(
    "SELECT managed_problem_versions.id, managed_problem_versions.problem_slug, managed_problem_versions.allowed_languages_json, managed_problem_versions.compile_profiles_json, managed_snapshots.status AS snapshot_status, managed_snapshots.mode AS snapshot_mode FROM managed_problem_versions JOIN managed_snapshots ON managed_snapshots.id = managed_problem_versions.snapshot_id WHERE managed_problem_versions.id = ?",
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
  const contest = await env.DB.prepare(
    "SELECT contests.starts_at, contests.ends_at, contests.status, contests.access_mode, contest_problems.managed_problem_version_id, contest_participants.user_id AS participant_user_id FROM contests JOIN contest_problems ON contest_problems.contest_id = contests.id LEFT JOIN contest_participants ON contest_participants.contest_id = contests.id AND contest_participants.user_id = ? WHERE contests.id = ? AND contest_problems.managed_problem_version_id = ?",
  ).bind(session.userId, request.contestId, request.managedProblemVersionId).first<{
    starts_at: string; ends_at: string; status: string; access_mode: string; managed_problem_version_id: string; participant_user_id: string | null;
  }>();
  const now = new Date().toISOString();
  if (!contest || contest.status !== "published" || now < contest.starts_at || now >= contest.ends_at) {
    throw new ApiError(409, "contest-not-running", "Contest is not accepting submissions.");
  }
  if (contest.access_mode === "invite" && contest.participant_user_id !== session.userId) {
    throw new ApiError(403, "contest-invite-required", "Join this invite-only contest before submitting.");
  }
}

async function submissionForOwner(env: ForgeWorkerEnv, submissionId: string, userId: string): Promise<SubmissionRow> {
  const row = await env.DB.prepare("SELECT * FROM submissions WHERE id = ? AND user_id = ? AND rejudge_batch_id IS NULL")
    .bind(submissionId, userId).first<SubmissionRow>();
  if (!row) throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  return row;
}

async function finishAdmittingSubmission(
  env: ForgeWorkerEnv,
  input: {
    readonly submissionId: string;
    readonly userId: string;
    readonly sourceR2Key: string;
    readonly sourceDigest: string;
    readonly sourceBytes: Uint8Array;
    readonly workflowParameters: SubmissionWorkflowParameters;
  },
): Promise<void> {
  await putSource(env, input.sourceR2Key, input.sourceBytes, input.sourceDigest, {
    submissionId: input.submissionId,
    userId: input.userId,
  });
  const timestamp = new Date().toISOString();
  const attemptToken = await deriveSubmissionAttemptToken(env.ACCOUNT_ERASURE_HMAC_SECRET, input.submissionId, 1);
  await env.DB.batch([
    env.DB.prepare(INSERT_OFFICIAL_SUBMISSION_ATTEMPT_SQL)
      .bind(await sha256Hex(attemptToken), `${input.submissionId}:1`, input.submissionId, input.userId, input.sourceR2Key, input.sourceDigest),
    env.DB.prepare(INSERT_OFFICIAL_SUBMISSION_OUTBOX_SQL)
      .bind(crypto.randomUUID(), JSON.stringify(input.workflowParameters), input.submissionId, input.userId, input.sourceR2Key, input.sourceDigest),
    env.DB.prepare(QUEUE_ADMITTED_SUBMISSION_SQL)
      .bind(timestamp, input.submissionId, input.userId, input.sourceR2Key, input.sourceDigest),
  ]);
  const queued = await env.DB.prepare("SELECT state FROM submissions WHERE id=? AND user_id=?")
    .bind(input.submissionId, input.userId).first<{ readonly state: string }>();
  if (!queued || queued.state === "admitting") throw new Error("Submission admission could not be queued.");
  if (!["queued", "waiting-capacity", "preparing", "compiling", "running", "finalizing"].includes(queued.state)) return;
  try {
    await env.SUBMISSION_WORKFLOW.create({ id: input.submissionId, params: input.workflowParameters });
    await env.DB.prepare("UPDATE outbox SET delivered_at=?, attempts=attempts+1, payload_json='{}', last_error=NULL WHERE aggregate_id=? AND kind='start-submission-workflow' AND delivered_at IS NULL")
      .bind(new Date().toISOString(), input.submissionId).run();
  } catch {
    operationalLog("warn", {
      event: "workflow.delivery-deferred",
      outcome: "deferred",
      code: "start-submission-workflow",
      aggregateType: "submission",
      aggregateId: input.submissionId,
    });
  }
}

export async function reconcileAdmittingSubmission(
  env: ForgeWorkerEnv,
  submissionId: string,
  now = new Date(),
): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT id, user_id, source_r2_key, source_digest,
      forge_release_id, forge_manifest_sha256, state, updated_at
    FROM submissions WHERE id=? AND rejudge_batch_id IS NULL`)
    .bind(submissionId).first<{
      readonly id: string;
      readonly user_id: string;
      readonly source_r2_key: string;
      readonly source_digest: string;
      readonly forge_release_id: string;
      readonly forge_manifest_sha256: string;
      readonly state: string;
      readonly updated_at: string;
    }>();
  if (!row || row.state !== "admitting") return true;
  if (Date.parse(row.updated_at) > now.getTime() - 2 * 60 * 1_000) return false;
  const object = await env.JUDGE_BUCKET.get(row.source_r2_key);
  if (object && object.size > 0 && object.size <= 2 * 1024 * 1024 && object.customMetadata?.sha256 === row.source_digest) {
    const bytes = new Uint8Array(await object.arrayBuffer());
    try {
      if (bytes.byteLength === object.size && await sha256Hex(bytes) === row.source_digest) {
        await finishAdmittingSubmission(env, {
          submissionId: row.id,
          userId: row.user_id,
          sourceR2Key: row.source_r2_key,
          sourceDigest: row.source_digest,
          sourceBytes: bytes,
          workflowParameters: {
            submissionId: row.id,
            attempt: 1,
            expectedReleaseId: row.forge_release_id,
            expectedManifestSha256: row.forge_manifest_sha256,
          },
        });
        return true;
      }
    } finally {
      bytes.fill(0);
    }
  }
  await env.JUDGE_BUCKET.delete(row.source_r2_key);
  if (await env.JUDGE_BUCKET.head(row.source_r2_key)) throw new Error("Stranded submission source cleanup failed.");
  const timestamp = now.toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE submissions SET state='infrastructure-error', score=0, fully_passed_cases=0, updated_at=?, completed_at=? WHERE id=? AND state='admitting'")
      .bind(timestamp, timestamp, row.id),
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

  const replay = async (submissionId: string): Promise<Response> => {
    const current = await submissionForOwner(env, submissionId, session.userId);
    if (current.state === "admitting") {
      const workflowParameters = {
        submissionId,
        attempt: 1,
        expectedReleaseId: current.forge_release_id,
        expectedManifestSha256: current.forge_manifest_sha256,
      } satisfies SubmissionWorkflowParameters;
      await finishAdmittingSubmission(env, {
        submissionId,
        userId: session.userId,
        sourceR2Key: current.source_r2_key,
        sourceDigest: current.source_digest,
        sourceBytes,
        workflowParameters,
      });
    }
    return submissionCreatedResponse(request, env, submissionId, true);
  };

  const existing = await env.DB.prepare("SELECT submission_id, request_digest FROM submission_idempotency WHERE user_id=? AND idempotency_key=?")
    .bind(session.userId, input.idempotencyKey).first<{ readonly submission_id: string; readonly request_digest: string }>();
  if (existing) {
    if (existing.request_digest !== requestDigest) throw new ApiError(409, "idempotency-conflict", "Idempotency key was already used for different source.");
    return replay(existing.submission_id);
  }

  await requireFormalMutationsEnabled(env);
  const formalRiskRequestKey = await sha256Hex(canonicalBytes({ idempotencyKey: input.idempotencyKey, requestDigest }));
  await requireOfficialSubmissionRiskTurnstile(request, env, session.userId, formalRiskRequestKey);
  await assertProblemVersionAcceptsSubmission(env, problem.id);
  const capacity = await submissionCapacitySnapshot(env, session.userId);
  if (capacity.userQueued >= MAX_QUEUED_SUBMISSIONS_PER_USER) throw new ApiError(429, "submission-queue-full", "This account already has three queued submissions.");
  if (capacity.globalNonterminal >= MAX_NONTERMINAL_SUBMISSIONS) throw new ApiError(429, "submission-capacity", "The submission queue is temporarily full.");

  const activeRelease = await assertActiveRelease(env.DB, env.JUDGE_BUCKET, env.ENVIRONMENT, env.FORGE_RELEASE_ID, env.FORGE_RELEASE_MANIFEST_SHA256);
  const submissionId = crypto.randomUUID();
  const sourceR2Key = `sources/${session.userId}/${submissionId}.${sourceDigest}.json`;
  const workflowParameters = {
    submissionId,
    attempt: 1,
    expectedReleaseId: activeRelease.releaseId,
    expectedManifestSha256: activeRelease.manifestSha256,
  } satisfies SubmissionWorkflowParameters;

  try {
    const [inserted, idempotency] = await env.DB.batch([
      env.DB.prepare(INSERT_OFFICIAL_SUBMISSION_SQL).bind(
        submissionId,
        session.userId,
        input.managedProblemVersionId,
        input.contestId ?? null,
        input.language,
        input.target,
        input.optimization,
        input.entry,
        sourceR2Key,
        sourceDigest,
        activeRelease.releaseId,
        activeRelease.manifestSha256,
        env.ENVIRONMENT,
        input.idempotencyKey,
      ),
      env.DB.prepare(INSERT_OFFICIAL_SUBMISSION_IDEMPOTENCY_SQL)
        .bind(session.userId, input.idempotencyKey, requestDigest, submissionId, submissionId, session.userId, sourceR2Key, sourceDigest),
    ]);
    if (inserted?.meta.changes !== 1 || idempotency?.meta.changes !== 1) {
      const winner = await env.DB.prepare("SELECT submission_id, request_digest FROM submission_idempotency WHERE user_id=? AND idempotency_key=?")
        .bind(session.userId, input.idempotencyKey).first<{ readonly submission_id: string; readonly request_digest: string }>();
      if (winner?.request_digest === requestDigest) return replay(winner.submission_id);
      const updatedCapacity = await submissionCapacitySnapshot(env, session.userId);
      if (updatedCapacity.userQueued >= MAX_QUEUED_SUBMISSIONS_PER_USER) throw new ApiError(429, "submission-queue-full", "This account already has three queued submissions.");
      if (updatedCapacity.globalNonterminal >= MAX_NONTERMINAL_SUBMISSIONS) throw new ApiError(429, "submission-capacity", "The submission queue is temporarily full.");
      await requireFormalMutationsEnabled(env);
      if (input.contestId) await verifyContestAdmission(env, session, input);
      await assertProblemVersionAcceptsSubmission(env, problem.id);
      throw new ApiError(409, "submission-admission-rejected", "The submission is no longer eligible for admission.");
    }
  } catch (error) {
    const winner = await env.DB.prepare("SELECT submission_id, request_digest FROM submission_idempotency WHERE user_id=? AND idempotency_key=?")
      .bind(session.userId, input.idempotencyKey).first<{ readonly submission_id: string; readonly request_digest: string }>();
    if (winner?.request_digest === requestDigest) return replay(winner.submission_id);
    throw error;
  }

  await finishAdmittingSubmission(env, {
    submissionId,
    userId: session.userId,
    sourceR2Key,
    sourceDigest,
    sourceBytes,
    workflowParameters,
  });
  return submissionCreatedResponse(request, env, submissionId, false);
}

async function submissionCreatedResponse(
  request: Request,
  env: ForgeWorkerEnv,
  submissionId: string,
  replayed: boolean,
): Promise<Response> {
  const snapshot = await env.DB.prepare("SELECT state FROM submissions WHERE id=?")
    .bind(submissionId).first<{ readonly state: string }>();
  if (!snapshot) throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  const base = new URL(request.url);
  base.pathname = `/api/submissions/${submissionId}/events`;
  base.search = "";
  return jsonResponse({
    submissionId,
    state: snapshot.state,
    // The create response carries only the authoritative state, not the public
    // verdict/resource summary. Replaying from zero hydrates both fresh and
    // idempotently replayed submissions without fabricating result details.
    eventCursor: 0,
    eventsUrl: base.toString(),
    replayed,
  }, replayed ? 200 : 202);
}

export async function getSubmission(request: Request, env: ForgeWorkerEnv, submissionId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const row = await env.DB.prepare("SELECT * FROM submissions WHERE id = ? AND rejudge_batch_id IS NULL")
    .bind(submissionId).first<SubmissionRow>();
  if (!row || !submissionDetailReadable(row, session?.userId)) throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  const owner = row.user_id === session?.userId;
  const [problem, contest] = await Promise.all([
    env.DB.prepare("SELECT problem_slug, title_json FROM managed_problem_versions WHERE id=?")
      .bind(row.managed_problem_version_id).first<{ problem_slug: string; title_json: string }>(),
    row.contest_id
      ? env.DB.prepare("SELECT id, title FROM contests WHERE id=?").bind(row.contest_id).first<{ id: string; title: string }>()
      : Promise.resolve(null),
  ]);
  return jsonResponse({ submission: {
    ...publicSubmissionProjection(row),
    owner,
    sourceAvailable: row.source_erased_at === null,
    problem: problem ? { slug: problem.problem_slug, title: parseStoredProblemTitle(problem.title_json) } : null,
    contest: contest ? { id: contest.id, title: contest.title } : null,
  } });
}

export function submissionDetailReadable(
  row: Pick<SubmissionRow, "user_id" | "state" | "visibility">,
  viewerUserId?: string,
): boolean {
  return row.user_id === viewerUserId || (row.state === "completed" && row.visibility === "public");
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
  const rows = await env.DB.prepare(`SELECT id, user_id, managed_problem_version_id, contest_id, language, target, optimization, entry_path, source_r2_key, source_digest, state, verdict, visibility, score, fully_passed_cases, deterministic_cost, peak_memory_bytes, created_at, updated_at, completed_at
    FROM submissions
    WHERE user_id=? AND (? IS NULL OR created_at<? OR (created_at=? AND id<?))
    ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(session.userId, before, before, before, beforeId, limit).all<SubmissionRow>();
  const problemIds = [...new Set(rows.results.map((row) => row.managed_problem_version_id))];
  const contestIds = [...new Set(rows.results.flatMap((row) => row.contest_id ? [row.contest_id] : []))];
  const problems = problemIds.length === 0 ? [] : (await env.DB.prepare(`SELECT id, problem_slug, title_json FROM managed_problem_versions WHERE id IN (${problemIds.map(() => "?").join(",")})`)
    .bind(...problemIds).all<{ id: string; problem_slug: string; title_json: string }>()).results;
  const contests = contestIds.length === 0 ? [] : (await env.DB.prepare(`SELECT id, title FROM contests WHERE id IN (${contestIds.map(() => "?").join(",")})`)
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
  const [claim] = await env.DB.batch([
    env.DB.prepare(CANCEL_OWNED_NONTERMINAL_SUBMISSION_SQL)
      .bind(now, now, submissionId, session.userId),
    env.DB.prepare(CANCEL_ACTIVE_SUBMISSION_ATTEMPTS_SQL)
      .bind(now, submissionId, submissionId),
    env.DB.prepare(SETTLE_CANCELLED_SUBMISSION_OUTBOX_SQL)
      .bind(now, "cancelled-before-delivery", submissionId, submissionId),
    prepareSubmissionEventInsert(env.DB, {
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
    const contest = await env.DB.prepare("SELECT ends_at FROM contests WHERE id = ?").bind(row.contest_id).first<{ ends_at: string }>();
    if (!contest || contest.ends_at > new Date().toISOString()) throw new ApiError(409, "contest-source-embargo", "Contest source remains private until the contest ends.");
  }
  await env.DB.prepare("UPDATE submissions SET visibility = ?, updated_at = ? WHERE id = ?")
    .bind(visibility, new Date().toISOString(), submissionId).run();
  return jsonResponse({ submissionId, visibility });
}

export async function publicSubmissionSource(request: Request, env: ForgeWorkerEnv, submissionId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const row = await env.DB.prepare("SELECT * FROM submissions WHERE id = ? AND rejudge_batch_id IS NULL")
    .bind(submissionId).first<SubmissionRow>();
  if (!row || (row.visibility !== "public" && row.user_id !== session?.userId)) throw new ApiError(404, "source-not-found", "Submission source is private.");
  const source = await env.JUDGE_BUCKET.get(row.source_r2_key);
  if (
    !source
    || source.size < 1 || source.size > 2 * 1024 * 1024
    || source.customMetadata?.sha256 !== row.source_digest
  ) throw new ApiError(500, "source-object-integrity", "Submission source is unavailable or inconsistent.");
  const sourceBytes = new Uint8Array(await source.arrayBuffer());
  if (sourceBytes.byteLength !== source.size || await sha256Hex(sourceBytes) !== row.source_digest) {
    throw new ApiError(500, "source-object-integrity", "Submission source failed digest verification.");
  }
  return new Response(sourceBytes, {
    headers: {
      "content-type": "application/json",
      "content-length": String(sourceBytes.byteLength),
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
  const result = await env.DB.prepare(
    "SELECT managed_snapshots.id AS snapshot_id, managed_problem_versions.problem_slug, managed_problem_versions.id AS problem_version_id FROM github_repositories JOIN collection_imports ON collection_imports.github_repository_id = github_repositories.github_repository_id JOIN managed_snapshots ON managed_snapshots.import_id = collection_imports.id JOIN managed_problem_versions ON managed_problem_versions.snapshot_id = managed_snapshots.id WHERE github_repositories.owner_login = ? COLLATE NOCASE AND github_repositories.name = ? COLLATE NOCASE AND github_repositories.is_private = 0 AND managed_snapshots.collection_revision = ? AND managed_snapshots.mode = 'official-practice' AND managed_snapshots.status = 'published' AND NOT EXISTS (SELECT 1 FROM effective_problem_versions WHERE original_problem_version_id=managed_problem_versions.id) AND NOT EXISTS (SELECT 1 FROM rejudge_batches WHERE old_problem_version_id=managed_problem_versions.id AND status IN ('queued','running','ready')) ORDER BY managed_problem_versions.problem_number",
  ).bind(owner, name, revision).all<{ snapshot_id: string; problem_slug: string; problem_version_id: string }>();
  if (result.results.length === 0) return jsonResponse({ matched: false });
  return jsonResponse({
    matched: true,
    snapshotId: result.results[0]?.snapshot_id,
    problems: Object.fromEntries(result.results.map((row) => [row.problem_slug, row.problem_version_id])),
  });
}
