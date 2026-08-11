import { parseCreateRejudgeRequest, classifyRejudgeChildState, classifyRejudgeProgress } from "../src/online-judge/rejudge";
import { requireMutationSession, requireSession } from "./auth";
import { sha256Hex } from "./crypto";
import type { AuthenticatedSession, ForgeWorkerEnv } from "./env";
import { requireStagingFormalAccess } from "./formal-access";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { requireOrganizer } from "./github";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { assertActiveRelease } from "./release";
import { reconcileFormalSubmissionAdmissions } from "./formal-admissions";
import { operationalLog } from "./structured-log";
import { prepareSubmissionEventInsert } from "./submission-events";
import {
  deriveSubmissionAttemptToken,
  parseSubmissionWorkflowParameters,
  type SubmissionWorkflowParameters,
} from "./submission-workflow-identity";

const REJUDGE_CONCURRENCY = 5;
const MATERIALIZATION_PAGE_SIZE = 20;
const RESULT_PAGE_SIZE = 20;
const TERMINAL_WORKFLOW_STATES = new Set(["complete", "errored", "terminated", "unknown"]);
const UNKNOWN_WORKFLOW_REPAIR_GRACE_MS = 10 * 60 * 1_000;

export function rejudgeWorkflowNeedsInfrastructureRepair(input: {
  readonly status: string;
  readonly submissionUpdatedAt: string;
  readonly now: Date;
}): boolean {
  if (!TERMINAL_WORKFLOW_STATES.has(input.status)) return false;
  if (input.status !== "unknown") return true;
  const updatedAt = Date.parse(input.submissionUpdatedAt);
  return Number.isFinite(updatedAt) && updatedAt <= input.now.getTime() - UNKNOWN_WORKFLOW_REPAIR_GRACE_MS;
}

function availableSubmissionSourceSql(alias: "submissions" | "original" | "child"): string {
  return `${alias}.source_erased_at IS NULL AND NOT EXISTS (SELECT 1 FROM submission_owner_erasure_fences AS ${alias}_owner_fence WHERE ${alias}_owner_fence.owner_user_id=${alias}.user_id)`;
}

export const MATERIALIZE_REJUDGE_SUBMISSION_SQL = `INSERT OR IGNORE INTO submissions (id, user_id, managed_problem_version_id, contest_id, language, target, optimization, entry_path, source_r2_key, source_digest, forge_release_id, forge_manifest_sha256, state, visibility, created_at, updated_at, rejudge_batch_id, rejudge_of_submission_id)
SELECT ?, original.user_id, ?, original.contest_id, original.language, original.target, original.optimization, original.entry_path, original.source_r2_key, original.source_digest, ?, ?, 'admitting', 'private', ?, ?, ?, original.id
FROM submissions AS original
WHERE original.id=? AND original.user_id=? AND original.managed_problem_version_id=? AND original.source_r2_key=? AND original.source_digest=? AND original.state IN ('completed','compile-error') AND ${availableSubmissionSourceSql("original")}`;

export const MATERIALIZE_REJUDGE_ATTEMPT_SQL = `INSERT OR IGNORE INTO submission_attempts (submission_id, attempt, token_hash, container_key, state)
SELECT child.id, 1, ?, ?, 'created'
FROM submissions AS child
JOIN submissions AS original ON original.id=child.rejudge_of_submission_id
WHERE child.id=? AND child.rejudge_batch_id=? AND child.user_id=original.user_id AND ${availableSubmissionSourceSql("original")} AND ${availableSubmissionSourceSql("child")}`;

export const MATERIALIZE_REJUDGE_JOB_SQL = `INSERT OR IGNORE INTO rejudge_jobs (rejudge_batch_id, old_submission_id, new_submission_id, old_problem_version_id, new_problem_version_id, state, workflow_payload_json, created_at, updated_at)
SELECT ?, original.id, child.id, ?, ?, 'pending', ?, ?, ?
FROM submissions AS child
JOIN submissions AS original ON original.id=child.rejudge_of_submission_id
WHERE child.id=? AND child.rejudge_batch_id=? AND original.id=? AND child.user_id=original.user_id AND ${availableSubmissionSourceSql("original")} AND ${availableSubmissionSourceSql("child")}`;

const DISPATCH_REJUDGE_ELIGIBILITY_SQL = `rejudge_jobs.erasure_excluded_at IS NULL AND child.state='admitting' AND original.id=rejudge_jobs.old_submission_id AND child.id=rejudge_jobs.new_submission_id AND child.user_id=original.user_id AND ${availableSubmissionSourceSql("original")} AND ${availableSubmissionSourceSql("child")}`;

export const CLAIM_REJUDGE_OUTBOX_SQL = `INSERT OR IGNORE INTO submission_outbox (id, submission_id, kind, payload_json, created_at)
SELECT ?, child.id, 'start-workflow', ?, ?
FROM rejudge_jobs
JOIN submissions AS child ON child.id=rejudge_jobs.new_submission_id
JOIN submissions AS original ON original.id=rejudge_jobs.old_submission_id
WHERE rejudge_jobs.rejudge_batch_id=? AND rejudge_jobs.old_submission_id=? AND rejudge_jobs.state='pending' AND ${DISPATCH_REJUDGE_ELIGIBILITY_SQL}`;

export const CLAIM_REJUDGE_JOB_SQL = `UPDATE rejudge_jobs SET state='dispatched', workflow_payload_json='{}', updated_at=?
WHERE rejudge_batch_id=? AND old_submission_id=? AND state='pending' AND erasure_excluded_at IS NULL
AND EXISTS (
  SELECT 1 FROM submissions AS child
  JOIN submissions AS original ON original.id=rejudge_jobs.old_submission_id
  WHERE child.id=rejudge_jobs.new_submission_id AND child.user_id=original.user_id AND child.state='admitting' AND ${availableSubmissionSourceSql("original")} AND ${availableSubmissionSourceSql("child")}
)`;

export const UPSERT_REJUDGE_VERIFIED_SOLVE_SQL = `INSERT INTO rejudge_verified_solves (rejudge_batch_id, user_id, managed_problem_version_id, effective_submission_id, score, solved_at)
SELECT ?, ?, ?, ?, 100, ?
WHERE EXISTS (SELECT 1 FROM users WHERE id=? AND status='active')
  AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=?)
ON CONFLICT(rejudge_batch_id, user_id) DO UPDATE SET
  effective_submission_id=CASE WHEN excluded.solved_at < rejudge_verified_solves.solved_at THEN excluded.effective_submission_id ELSE rejudge_verified_solves.effective_submission_id END,
  solved_at=MIN(rejudge_verified_solves.solved_at, excluded.solved_at)`;

export function erasureAdjustedExpectedCount(current: number, materialized: number, materializationSettled: boolean): number {
  if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(materialized) || materialized < 0) {
    throw new TypeError("Rejudge expected counts must be non-negative safe integers.");
  }
  return materializationSettled && materialized < current ? materialized : current;
}

interface ManagedVersionRow {
  readonly id: string;
  readonly problem_slug: string;
  readonly judge_projection_r2_key: string;
  readonly allowed_languages_json: string;
  readonly compile_profiles_json: string;
  readonly bundle_digest: string;
  readonly snapshot_status: string;
  readonly snapshot_mode: string;
  readonly organizer_user_id: string;
  readonly forge_release_id: string;
}

interface RejudgeBatchRow {
  readonly id: string;
  readonly old_problem_version_id: string;
  readonly new_problem_version_id: string;
  readonly requested_by: string;
  readonly status: string;
  readonly expected_count: number;
  readonly completed_count: number;
  readonly ready_count: number;
  readonly failed_count: number;
  readonly forge_release_id: string | null;
  readonly forge_manifest_sha256: string | null;
  readonly cancel_requested_at: string | null;
  readonly failure_code: string | null;
  readonly created_at: string;
  readonly updated_at: string | null;
  readonly effective_at: string | null;
  readonly mappings_finalized_at: string | null;
}

interface SourceSubmissionRow {
  readonly id: string;
  readonly user_id: string;
  readonly contest_id: string | null;
  readonly language: string;
  readonly target: string;
  readonly optimization: string;
  readonly entry_path: string;
  readonly source_r2_key: string;
  readonly source_digest: string;
  readonly completed_at: string;
}

interface RejudgeResultRow {
  readonly outbox_id: string;
  readonly rejudge_batch_id: string;
  readonly old_submission_id: string;
  readonly new_submission_id: string;
  readonly old_problem_version_id: string;
  readonly new_problem_version_id: string;
  readonly user_id: string;
  readonly contest_id: string | null;
  readonly state: "completed" | "compile-error" | "judge-error" | "infrastructure-error" | "cancelled";
  readonly score: number | null;
  readonly fully_passed_cases: number | null;
  readonly deterministic_cost: number | null;
  readonly peak_memory_bytes: number | null;
  readonly effective_attempt: number | null;
  readonly old_achieved_at: string;
  readonly attempts: number;
}

function canonicalBytes(value: unknown): Uint8Array {
  if (!value || typeof value !== "object" || Array.isArray(value)) return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  const record = value as Record<string, unknown>;
  return new TextEncoder().encode(`${JSON.stringify(Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]])))}\n`);
}

async function deterministicChildSubmissionId(batchId: string, oldSubmissionId: string): Promise<string> {
  const digest = await sha256Hex(new TextEncoder().encode(`forge-rejudge-child-v1\0${batchId}\0${oldSubmissionId}`));
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function managedVersion(env: ForgeWorkerEnv, id: string): Promise<ManagedVersionRow | null> {
  return env.CORE_DB.prepare(
    "SELECT managed_problem_versions.id, managed_problem_versions.problem_slug, managed_problem_versions.bundle_digest, managed_problem_versions.judge_projection_r2_key, managed_problem_versions.allowed_languages_json, managed_problem_versions.compile_profiles_json, managed_snapshots.status AS snapshot_status, managed_snapshots.mode AS snapshot_mode, collection_imports.organizer_user_id, collection_imports.forge_release_id FROM managed_problem_versions JOIN managed_snapshots ON managed_snapshots.id=managed_problem_versions.snapshot_id JOIN collection_imports ON collection_imports.id=managed_snapshots.import_id WHERE managed_problem_versions.id=?",
  ).bind(id).first<ManagedVersionRow>();
}

function assertVersionAuthorization(session: AuthenticatedSession, oldVersion: ManagedVersionRow, newVersion: ManagedVersionRow): void {
  if (!session.roles.includes("admin") && (oldVersion.organizer_user_id !== session.userId || newVersion.organizer_user_id !== session.userId)) {
    throw new ApiError(404, "rejudge-version-not-found", "Managed problem versions were not found.");
  }
  if (newVersion.snapshot_status !== "published" || !["published", "superseded"].includes(oldVersion.snapshot_status)) {
    throw new ApiError(409, "rejudge-version-state", "Rejudge requires immutable published problem versions.");
  }
  if (oldVersion.problem_slug !== newVersion.problem_slug || oldVersion.snapshot_mode !== newVersion.snapshot_mode) {
    throw new ApiError(409, "rejudge-version-mismatch", "Rejudge versions must represent the same problem and collection mode.");
  }
}

async function batchForActor(env: ForgeWorkerEnv, batchId: string, session: AuthenticatedSession): Promise<RejudgeBatchRow> {
  const row = await env.CORE_DB.prepare("SELECT * FROM rejudge_batches WHERE id=?")
    .bind(batchId).first<RejudgeBatchRow>();
  if (!row || (!session.roles.includes("admin") && row.requested_by !== session.userId)) {
    throw new ApiError(404, "rejudge-batch-not-found", "Rejudge batch was not found.");
  }
  return row;
}

export async function assertProblemVersionAcceptsSubmission(env: ForgeWorkerEnv, problemVersionId: string): Promise<void> {
  const blocked = await env.CORE_DB.prepare(
    "SELECT 1 AS blocked FROM rejudge_batches WHERE old_problem_version_id=? AND status IN ('queued','running','ready') UNION ALL SELECT 1 AS blocked FROM effective_problem_versions WHERE original_problem_version_id=? LIMIT 1",
  ).bind(problemVersionId, problemVersionId).first<{ blocked: number }>();
  if (blocked) throw new ApiError(409, "problem-version-superseded", "This managed problem version no longer accepts formal submissions.");
}

export async function createRejudgeBatch(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  let input;
  try {
    input = parseCreateRejudgeRequest(await readJsonBody(request, 16 * 1024));
  } catch (error) {
    if (error instanceof TypeError) throw new ApiError(400, "rejudge-request-invalid", error.message);
    throw error;
  }
  const requestDigest = await sha256Hex(canonicalBytes(input));
  const existing = await env.CORE_DB.prepare("SELECT id, request_digest, status FROM rejudge_batches WHERE requested_by=? AND idempotency_key=?")
    .bind(session.userId, input.idempotencyKey).first<{ id: string; request_digest: string; status: string }>();
  if (existing) {
    if (existing.request_digest !== requestDigest) throw new ApiError(409, "idempotency-conflict", "Idempotency key was already used for another rejudge request.");
    return jsonResponse({ rejudgeBatchId: existing.id, status: existing.status, replayed: true });
  }
  const [oldVersion, newVersion] = await Promise.all([
    managedVersion(env, input.oldProblemVersionId),
    managedVersion(env, input.newProblemVersionId),
  ]);
  if (!oldVersion || !newVersion) throw new ApiError(404, "rejudge-version-not-found", "Managed problem versions were not found.");
  assertVersionAuthorization(session, oldVersion, newVersion);
  const staleSource = await env.CORE_DB.prepare("SELECT 1 AS stale FROM effective_problem_versions WHERE original_problem_version_id=?")
    .bind(oldVersion.id).first<{ stale: number }>();
  if (staleSource) throw new ApiError(409, "rejudge-source-superseded", "Start the next rejudge from the currently effective problem version.");
  const staleSuccessor = await env.CORE_DB.prepare("SELECT 1 AS stale FROM effective_problem_versions WHERE original_problem_version_id=? UNION ALL SELECT 1 AS stale FROM rejudge_batches WHERE old_problem_version_id=? AND status IN ('queued','running','ready') LIMIT 1")
    .bind(newVersion.id, newVersion.id).first<{ stale: number }>();
  if (staleSuccessor) throw new ApiError(409, "rejudge-successor-superseded", "The successor problem version must itself be current and immutable.");

  await requireFormalMutationsEnabled(env);
  const active = await assertActiveRelease(env.CORE_DB, env.JUDGE_BUCKET, env.ENVIRONMENT, newVersion.forge_release_id);
  const batchId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.CORE_DB.batch([
      env.CORE_DB.prepare("INSERT INTO rejudge_batches (id, old_problem_version_id, new_problem_version_id, requested_by, status, expected_count, completed_count, created_at, idempotency_key, request_digest, forge_release_id, forge_manifest_sha256, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?, ?, ?)")
        .bind(batchId, oldVersion.id, newVersion.id, session.userId, now, input.idempotencyKey, requestDigest, active.releaseId, active.manifestSha256, now),
      env.CORE_DB.prepare("INSERT INTO core_outbox (id, kind, aggregate_id, payload_json, created_at) VALUES (?, 'materialize-rejudge', ?, ?, ?)")
        .bind(outboxId, batchId, JSON.stringify({ batchId }), now),
    ]);
  } catch (error) {
    const winner = await env.CORE_DB.prepare("SELECT id, request_digest, status FROM rejudge_batches WHERE requested_by=? AND idempotency_key=?")
      .bind(session.userId, input.idempotencyKey).first<{ id: string; request_digest: string; status: string }>();
    if (winner?.request_digest === requestDigest) return jsonResponse({ rejudgeBatchId: winner.id, status: winner.status, replayed: true });
    const inFlight = await env.CORE_DB.prepare("SELECT id FROM rejudge_batches WHERE old_problem_version_id=? AND status IN ('queued','running','ready')")
      .bind(oldVersion.id).first<{ id: string }>();
    if (inFlight) throw new ApiError(409, "rejudge-already-running", "This problem version already has a rejudge in progress.");
    throw error;
  }
  return jsonResponse({ rejudgeBatchId: batchId, status: "queued", replayed: false }, 202);
}

export async function getRejudgeBatch(request: Request, env: ForgeWorkerEnv, batchId: string): Promise<Response> {
  const session = await requireSession(request, env);
  const row = await batchForActor(env, batchId, session);
  return jsonResponse({
    rejudgeBatch: {
      id: row.id,
      oldProblemVersionId: row.old_problem_version_id,
      newProblemVersionId: row.new_problem_version_id,
      status: row.status,
      expectedCount: row.expected_count,
      completedCount: row.completed_count,
      readyCount: row.ready_count,
      failedCount: row.failed_count,
      failureCode: row.failure_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      effectiveAt: row.effective_at,
    },
  });
}

export async function cancelRejudgeBatch(request: Request, env: ForgeWorkerEnv, batchId: string): Promise<Response> {
  const session = await requireMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const row = await batchForActor(env, batchId, session);
  if (["effective", "failed"].includes(row.status)) return jsonResponse({ rejudgeBatchId: batchId, status: row.status, changed: false });
  const now = new Date().toISOString();
  const result = await env.CORE_DB.prepare("UPDATE rejudge_batches SET cancel_requested_at=?, updated_at=? WHERE id=? AND status IN ('queued','running','ready') AND cancel_requested_at IS NULL")
    .bind(now, now, batchId).run();
  if (result.meta.changes !== 1) {
    const current = await batchForActor(env, batchId, session);
    return jsonResponse({ rejudgeBatchId: batchId, status: current.cancel_requested_at ? "cancelling" : current.status, changed: false });
  }
  return jsonResponse({ rejudgeBatchId: batchId, status: "cancelling", changed: result.meta.changes === 1 }, 202);
}

function parseProfiles(value: string): Readonly<Record<string, { readonly target?: unknown; readonly optimization?: unknown }>> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Managed compile profiles are invalid.");
  return parsed as Readonly<Record<string, { readonly target?: unknown; readonly optimization?: unknown }>>;
}

async function eligibleRejudgePredicate(env: ForgeWorkerEnv, oldProblemVersionId: string): Promise<{ readonly sql: string; readonly bindings: readonly string[] }> {
  const activePredecessors = await env.CORE_DB.prepare("SELECT DISTINCT rejudge_batch_id FROM effective_problem_versions WHERE effective_problem_version_id=?")
    .bind(oldProblemVersionId).all<{ rejudge_batch_id: string }>();
  if (activePredecessors.results.length === 0) return { sql: "submissions.rejudge_batch_id IS NULL", bindings: [] };
  const ids = activePredecessors.results.map((row) => row.rejudge_batch_id);
  return {
    sql: `(submissions.rejudge_batch_id IS NULL OR submissions.rejudge_batch_id IN (${ids.map(() => "?").join(",")}))`,
    bindings: ids,
  };
}

async function formalSubmissionAdmissionsSettled(env: ForgeWorkerEnv, problemVersionId: string): Promise<boolean> {
  const result = await reconcileFormalSubmissionAdmissions(env, { managedProblemVersionId: problemVersionId, limit: 100 });
  return result.pending === 0;
}

export async function materializeRejudgeBatch(env: ForgeWorkerEnv, batchId: string): Promise<boolean> {
  const batch = await env.CORE_DB.prepare("SELECT * FROM rejudge_batches WHERE id=?")
    .bind(batchId).first<RejudgeBatchRow>();
  if (!batch || ["effective", "failed"].includes(batch.status)) return true;
  if (batch.cancel_requested_at) {
    return cancelRejudgeChildren(env, batch, batch.failure_code ?? "rejudge-cancelled");
  }
  const version = await managedVersion(env, batch.new_problem_version_id);
  if (!version || version.snapshot_status !== "published" || version.forge_release_id !== batch.forge_release_id || !batch.forge_manifest_sha256) {
    return cancelRejudgeChildren(env, batch, "rejudge-version-unavailable");
  }
  const active = await assertActiveRelease(env.CORE_DB, env.JUDGE_BUCKET, env.ENVIRONMENT, version.forge_release_id, batch.forge_manifest_sha256);
  if (!await formalSubmissionAdmissionsSettled(env, batch.old_problem_version_id)) return false;
  const predicate = await eligibleRejudgePredicate(env, batch.old_problem_version_id);
  const baseBindings = [batch.old_problem_version_id, ...predicate.bindings] as const;
  const sourceAvailable = availableSubmissionSourceSql("submissions");
  const nonterminal = await env.SUBMISSIONS_DB.prepare(`SELECT 1 AS pending FROM submissions WHERE managed_problem_version_id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled') AND ${predicate.sql} AND ${sourceAvailable} LIMIT 1`)
    .bind(...baseBindings).first<{ pending: number }>();
  if (nonterminal) return false;
  const sourceSetEligibility = `(${sourceAvailable} OR EXISTS (SELECT 1 FROM rejudge_jobs WHERE rejudge_jobs.rejudge_batch_id=? AND rejudge_jobs.old_submission_id=submissions.id AND rejudge_jobs.state='ready' AND rejudge_jobs.erasure_excluded_at IS NULL))`;
  const profiles = await env.SUBMISSIONS_DB.prepare(`SELECT DISTINCT language, target, optimization FROM submissions WHERE managed_problem_version_id=? AND state IN ('completed','compile-error') AND ${predicate.sql} AND ${sourceSetEligibility}`)
    .bind(...baseBindings, batchId).all<{ language: string; target: string; optimization: string }>();
  const allowedProfiles = parseProfiles(version.compile_profiles_json);
  const allowedLanguages = JSON.parse(version.allowed_languages_json) as unknown;
  if (!Array.isArray(allowedLanguages) || profiles.results.some((profile) => !allowedLanguages.includes(profile.language) || allowedProfiles[profile.language]?.target !== profile.target || allowedProfiles[profile.language]?.optimization !== profile.optimization)) {
    return cancelRejudgeChildren(env, batch, "rejudge-profile-incompatible");
  }
  const eligible = await env.SUBMISSIONS_DB.prepare(`SELECT COUNT(*) AS count FROM submissions WHERE managed_problem_version_id=? AND state IN ('completed','compile-error') AND ${predicate.sql} AND ${sourceSetEligibility}`)
    .bind(...baseBindings, batchId).first<{ count: number }>();
  const expectedCount = eligible?.count ?? 0;
  await env.CORE_DB.prepare("UPDATE rejudge_batches SET status='running', expected_count=?, updated_at=? WHERE id=? AND status IN ('queued','running')")
    .bind(expectedCount, new Date().toISOString(), batchId).run();

  const rows = await env.SUBMISSIONS_DB.prepare(`SELECT submissions.id, submissions.user_id, submissions.contest_id, submissions.language, submissions.target, submissions.optimization, submissions.entry_path, submissions.source_r2_key, submissions.source_digest, submissions.completed_at FROM submissions LEFT JOIN rejudge_jobs ON rejudge_jobs.rejudge_batch_id=? AND rejudge_jobs.old_submission_id=submissions.id WHERE submissions.managed_problem_version_id=? AND submissions.state IN ('completed','compile-error') AND ${predicate.sql} AND ${sourceAvailable} AND rejudge_jobs.old_submission_id IS NULL ORDER BY submissions.created_at, submissions.id LIMIT ?`)
    .bind(batchId, ...baseBindings, MATERIALIZATION_PAGE_SIZE).all<SourceSubmissionRow>();
  const now = new Date().toISOString();
  for (const source of rows.results) {
    const childId = await deterministicChildSubmissionId(batchId, source.id);
    const attemptToken = await deriveSubmissionAttemptToken(env.ACCOUNT_ERASURE_HMAC_SECRET, childId, 1);
    const parameters: SubmissionWorkflowParameters = {
      submissionId: childId,
      attempt: 1,
      expectedReleaseId: active.releaseId,
      expectedManifestSha256: active.manifestSha256,
    };
    await env.SUBMISSIONS_DB.batch([
      env.SUBMISSIONS_DB.prepare(MATERIALIZE_REJUDGE_SUBMISSION_SQL)
        .bind(childId, version.id, active.releaseId, active.manifestSha256, now, now, batchId, source.id, source.user_id, batch.old_problem_version_id, source.source_r2_key, source.source_digest),
      env.SUBMISSIONS_DB.prepare(MATERIALIZE_REJUDGE_ATTEMPT_SQL)
        .bind(await sha256Hex(attemptToken), `${childId}:1`, childId, batchId),
      env.SUBMISSIONS_DB.prepare(MATERIALIZE_REJUDGE_JOB_SQL)
        .bind(batchId, batch.old_problem_version_id, version.id, JSON.stringify(parameters), now, now, childId, batchId, source.id),
    ]);
  }
  const materialized = await env.SUBMISSIONS_DB.prepare("SELECT COUNT(*) AS count FROM rejudge_jobs WHERE rejudge_batch_id=? AND erasure_excluded_at IS NULL")
    .bind(batchId).first<{ count: number }>();
  return (materialized?.count ?? 0) === expectedCount;
}

function workflowPayload(value: string): SubmissionWorkflowParameters {
  return parseSubmissionWorkflowParameters(JSON.parse(value) as unknown);
}

async function dispatchRejudgeBatch(env: ForgeWorkerEnv, batch: RejudgeBatchRow, allowance: number): Promise<number> {
  if (allowance <= 0 || batch.cancel_requested_at || batch.status !== "running") return 0;
  const jobs = await env.SUBMISSIONS_DB.prepare(`SELECT rejudge_jobs.old_submission_id, rejudge_jobs.new_submission_id, rejudge_jobs.workflow_payload_json
    FROM rejudge_jobs
    JOIN submissions AS child ON child.id=rejudge_jobs.new_submission_id
    JOIN submissions AS original ON original.id=rejudge_jobs.old_submission_id
    WHERE rejudge_jobs.rejudge_batch_id=? AND rejudge_jobs.state='pending' AND ${DISPATCH_REJUDGE_ELIGIBILITY_SQL}
    ORDER BY rejudge_jobs.created_at, rejudge_jobs.old_submission_id LIMIT ?`)
    .bind(batch.id, allowance).all<{ old_submission_id: string; new_submission_id: string; workflow_payload_json: string }>();
  let dispatched = 0;
  for (const job of jobs.results) {
    const payload = workflowPayload(job.workflow_payload_json);
    if (payload.submissionId !== job.new_submission_id || payload.expectedReleaseId !== batch.forge_release_id || payload.expectedManifestSha256 !== batch.forge_manifest_sha256) {
      throw new Error("Rejudge Workflow reference does not match its fenced batch and submission.");
    }
    const now = new Date().toISOString();
    const outboxId = await deterministicChildSubmissionId(batch.id, `outbox:${job.old_submission_id}`);
    const [, claimed] = await env.SUBMISSIONS_DB.batch([
      env.SUBMISSIONS_DB.prepare(CLAIM_REJUDGE_OUTBOX_SQL)
        .bind(outboxId, JSON.stringify(payload), now, batch.id, job.old_submission_id),
      env.SUBMISSIONS_DB.prepare(CLAIM_REJUDGE_JOB_SQL)
        .bind(now, batch.id, job.old_submission_id),
    ]);
    if (claimed?.meta.changes === 1) dispatched += 1;
  }
  return dispatched;
}

export async function dispatchRejudgeJobs(env: ForgeWorkerEnv): Promise<number> {
  const active = await env.SUBMISSIONS_DB.prepare("SELECT COUNT(*) AS count FROM rejudge_jobs WHERE state='dispatched'")
    .first<{ count: number }>();
  let allowance = Math.max(0, REJUDGE_CONCURRENCY - (active?.count ?? 0));
  if (allowance === 0) return 0;
  const batches = await env.CORE_DB.prepare("SELECT * FROM rejudge_batches WHERE status='running' AND cancel_requested_at IS NULL ORDER BY created_at LIMIT 10")
    .all<RejudgeBatchRow>();
  let dispatched = 0;
  for (const batch of batches.results) {
    const count = await dispatchRejudgeBatch(env, batch, allowance);
    dispatched += count;
    allowance -= count;
    if (allowance === 0) break;
  }
  return dispatched;
}

async function rejudgeOwnerErasureReplacement(env: ForgeWorkerEnv, oldSubmissionId: string, newSubmissionId: string): Promise<string | null> {
  const row = await env.SUBMISSIONS_DB.prepare(`SELECT COALESCE(child_fence.anonymous_user_id, original_fence.anonymous_user_id) AS anonymous_user_id
    FROM submissions AS original
    JOIN submissions AS child ON child.id=?
    LEFT JOIN submission_owner_erasure_fences AS original_fence ON original_fence.owner_user_id=original.user_id
    LEFT JOIN submission_owner_erasure_fences AS child_fence ON child_fence.owner_user_id=child.user_id
    WHERE original.id=? AND (original.source_erased_at IS NOT NULL OR child.source_erased_at IS NOT NULL OR original_fence.owner_user_id IS NOT NULL OR child_fence.owner_user_id IS NOT NULL)`)
    .bind(newSubmissionId, oldSubmissionId).first<{ anonymous_user_id: string | null }>();
  if (row && typeof row.anonymous_user_id !== "string") throw new Error("Erased rejudge owner has no anonymous fence.");
  return row?.anonymous_user_id ?? null;
}

async function rejectErasedRejudgeResult(env: ForgeWorkerEnv, row: RejudgeResultRow): Promise<void> {
  const now = new Date().toISOString();
  await env.SUBMISSIONS_DB.batch([
    env.SUBMISSIONS_DB.prepare("UPDATE rejudge_jobs SET state=CASE WHEN state IN ('pending','dispatched') THEN 'cancelled' ELSE state END, result_state=CASE WHEN state IN ('pending','dispatched') THEN 'cancelled' ELSE result_state END, erasure_excluded_at=CASE WHEN state IN ('pending','dispatched') THEN COALESCE(erasure_excluded_at, ?) ELSE erasure_excluded_at END, workflow_payload_json='{}', updated_at=? WHERE rejudge_batch_id=? AND old_submission_id=?")
      .bind(now, now, row.rejudge_batch_id, row.old_submission_id),
    env.SUBMISSIONS_DB.prepare("UPDATE rejudge_result_outbox SET delivered_at=?, attempts=attempts+1, last_error='account-erasure' WHERE id=? AND delivered_at IS NULL")
      .bind(now, row.outbox_id),
  ]);
}

function resultEntry(row: RejudgeResultRow): Record<string, unknown> | null {
  if (row.state !== "completed") return null;
  if (row.score === null || row.fully_passed_cases === null || row.deterministic_cost === null || row.peak_memory_bytes === null || row.effective_attempt === null) {
    throw new Error("Completed rejudge result is incomplete.");
  }
  return {
    userId: row.user_id,
    score: row.score,
    fullyPassedCases: row.fully_passed_cases,
    deterministicCost: row.deterministic_cost,
    peakMemoryBytes: row.peak_memory_bytes,
    achievedAt: row.old_achieved_at,
  };
}

async function deliverRejudgeResult(env: ForgeWorkerEnv, row: RejudgeResultRow): Promise<void> {
  const initialErasureReplacement = await rejudgeOwnerErasureReplacement(env, row.old_submission_id, row.new_submission_id);
  if (initialErasureReplacement) {
    await rejectErasedRejudgeResult(env, row);
    return;
  }
  const batch = await env.CORE_DB.prepare("SELECT status, cancel_requested_at FROM rejudge_batches WHERE id=?")
    .bind(row.rejudge_batch_id).first<{ status: string; cancel_requested_at: string | null }>();
  if (!batch) throw new Error("Rejudge result batch is missing.");
  if (batch.status !== "running" || batch.cancel_requested_at) {
    const now = new Date().toISOString();
    await env.SUBMISSIONS_DB.batch([
      env.SUBMISSIONS_DB.prepare("UPDATE rejudge_jobs SET state='cancelled', result_state='cancelled', workflow_payload_json='{}', updated_at=? WHERE rejudge_batch_id=? AND old_submission_id=? AND state IN ('pending','dispatched')")
        .bind(now, row.rejudge_batch_id, row.old_submission_id),
      env.SUBMISSIONS_DB.prepare("UPDATE rejudge_result_outbox SET delivered_at=?, attempts=attempts+1, last_error='rejudge-batch-not-active' WHERE id=? AND delivered_at IS NULL")
        .bind(now, row.outbox_id),
    ]);
    return;
  }
  const disposition = classifyRejudgeChildState(row.state);
  const now = new Date().toISOString();
  if (row.state === "completed" || row.state === "compile-error") {
    if (row.effective_attempt === null) throw new Error("Rejudge result has no effective attempt.");
    const attempt = await env.SUBMISSIONS_DB.prepare("SELECT 1 AS valid FROM submission_attempts WHERE submission_id=? AND attempt=? AND state='succeeded'")
      .bind(row.new_submission_id, row.effective_attempt).first<{ valid: number }>();
    if (!attempt) throw new Error("Rejudge effective attempt is not finalized.");
  }
  if (disposition === "failed") {
    await env.SUBMISSIONS_DB.batch([
      env.SUBMISSIONS_DB.prepare("UPDATE rejudge_jobs SET state='failed', result_state=?, workflow_payload_json='{}', updated_at=? WHERE rejudge_batch_id=? AND old_submission_id=? AND state='dispatched'")
        .bind(row.state, now, row.rejudge_batch_id, row.old_submission_id),
      env.SUBMISSIONS_DB.prepare("UPDATE rejudge_result_outbox SET delivered_at=?, attempts=attempts+1, last_error=NULL WHERE id=? AND delivered_at IS NULL")
        .bind(now, row.outbox_id),
    ]);
    return;
  }
  const entry = resultEntry(row);
  // CORE verified-solves and SUBMISSIONS rejudge readiness cannot share one
  // D1 transaction. Re-read the owner fence before writing either projection.
  const finalErasureReplacement = await rejudgeOwnerErasureReplacement(env, row.old_submission_id, row.new_submission_id);
  if (finalErasureReplacement) {
    await rejectErasedRejudgeResult(env, row);
    return;
  }
  if (entry?.score === 100) {
    const projected = await env.CORE_DB.prepare(UPSERT_REJUDGE_VERIFIED_SOLVE_SQL)
      .bind(row.rejudge_batch_id, row.user_id, row.new_problem_version_id, row.new_submission_id, row.old_achieved_at, row.user_id, row.user_id).run();
    if (projected.meta.changes !== 1) {
      // CORE_DB account suspension/job creation is atomic. If erasure commits
      // after the earlier SUBMISSIONS_DB fence read, this conditional write
      // loses and cannot resurrect the original UUID. Throwing leaves final D1
      // delivery to the erasure scrub/reconciler instead of marking it ready.
      throw new Error("Rejudge solve owner is no longer active.");
    }
  }
  await env.SUBMISSIONS_DB.batch([
    env.SUBMISSIONS_DB.prepare("INSERT INTO effective_rejudges (old_submission_id, rejudge_batch_id, new_submission_id) VALUES (?, ?, ?) ON CONFLICT(old_submission_id) DO UPDATE SET rejudge_batch_id=excluded.rejudge_batch_id, new_submission_id=excluded.new_submission_id, became_effective_at=NULL")
      .bind(row.old_submission_id, row.rejudge_batch_id, row.new_submission_id),
    env.SUBMISSIONS_DB.prepare("UPDATE rejudge_jobs SET state='ready', result_state=?, workflow_payload_json='{}', updated_at=? WHERE rejudge_batch_id=? AND old_submission_id=? AND state='dispatched'")
      .bind(row.state, now, row.rejudge_batch_id, row.old_submission_id),
    env.SUBMISSIONS_DB.prepare("UPDATE rejudge_result_outbox SET delivered_at=?, attempts=attempts+1, last_error=NULL WHERE id=? AND delivered_at IS NULL")
      .bind(now, row.outbox_id),
  ]);
}

export async function deliverRejudgeResults(env: ForgeWorkerEnv): Promise<number> {
  const pending = await env.SUBMISSIONS_DB.prepare(
    "SELECT rejudge_result_outbox.id AS outbox_id, rejudge_result_outbox.rejudge_batch_id, rejudge_result_outbox.old_submission_id, rejudge_result_outbox.new_submission_id, rejudge_result_outbox.attempts, rejudge_jobs.old_problem_version_id, rejudge_jobs.new_problem_version_id, child.user_id, child.contest_id, child.state, child.score, child.fully_passed_cases, child.deterministic_cost, child.peak_memory_bytes, child.effective_attempt, original.completed_at AS old_achieved_at FROM rejudge_result_outbox JOIN rejudge_jobs ON rejudge_jobs.rejudge_batch_id=rejudge_result_outbox.rejudge_batch_id AND rejudge_jobs.old_submission_id=rejudge_result_outbox.old_submission_id JOIN submissions AS child ON child.id=rejudge_result_outbox.new_submission_id JOIN submissions AS original ON original.id=rejudge_result_outbox.old_submission_id WHERE rejudge_result_outbox.delivered_at IS NULL AND rejudge_result_outbox.attempts < 20 AND rejudge_jobs.erasure_excluded_at IS NULL ORDER BY rejudge_result_outbox.created_at LIMIT ?",
  ).bind(RESULT_PAGE_SIZE).all<RejudgeResultRow>();
  for (const row of pending.results) {
    try {
      await deliverRejudgeResult(env, row);
    } catch {
      const exhausted = row.attempts + 1 >= 20;
      await env.SUBMISSIONS_DB.batch([
        env.SUBMISSIONS_DB.prepare("UPDATE rejudge_result_outbox SET attempts=attempts+1, last_error='rejudge-result-delivery-failed' WHERE id=? AND delivered_at IS NULL")
          .bind(row.outbox_id),
        env.SUBMISSIONS_DB.prepare("UPDATE rejudge_jobs SET state='failed', result_state='infrastructure-error', updated_at=? WHERE rejudge_batch_id=? AND old_submission_id=? AND state='dispatched' AND ?=1")
          .bind(new Date().toISOString(), row.rejudge_batch_id, row.old_submission_id, exhausted ? 1 : 0),
      ]);
    }
  }
  return pending.results.length;
}

export async function repairDispatchedRejudgeJobs(env: ForgeWorkerEnv): Promise<number> {
  const repairTime = new Date();
  const now = repairTime.toISOString();
  const pendingCancelled = await env.SUBMISSIONS_DB.prepare("UPDATE rejudge_jobs SET state='cancelled', result_state='cancelled', workflow_payload_json='{}', updated_at=? WHERE state='pending' AND EXISTS (SELECT 1 FROM submissions WHERE submissions.id=rejudge_jobs.new_submission_id AND submissions.state='cancelled')")
    .bind(now).run();
  const rows = await env.SUBMISSIONS_DB.prepare(
    "SELECT rejudge_jobs.rejudge_batch_id, rejudge_jobs.old_submission_id, rejudge_jobs.new_submission_id, submissions.state, submissions.updated_at AS submission_updated_at, submission_outbox.delivered_at AS workflow_delivered_at, submission_outbox.attempts AS workflow_attempts FROM rejudge_jobs JOIN submissions ON submissions.id=rejudge_jobs.new_submission_id LEFT JOIN submission_outbox ON submission_outbox.submission_id=rejudge_jobs.new_submission_id AND submission_outbox.kind='start-workflow' WHERE rejudge_jobs.state='dispatched' ORDER BY rejudge_jobs.updated_at LIMIT 20",
  ).all<{ rejudge_batch_id: string; old_submission_id: string; new_submission_id: string; state: string; submission_updated_at: string; workflow_delivered_at: string | null; workflow_attempts: number | null }>();
  let repaired = pendingCancelled.meta.changes;
  for (const row of rows.results) {
    if (["completed", "compile-error", "judge-error", "infrastructure-error", "cancelled"].includes(row.state)) {
      await env.SUBMISSIONS_DB.prepare("INSERT OR IGNORE INTO rejudge_result_outbox (id, rejudge_batch_id, old_submission_id, new_submission_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), row.rejudge_batch_id, row.old_submission_id, row.new_submission_id, new Date().toISOString()).run();
      repaired += 1;
      continue;
    }
    if (row.workflow_delivered_at === null && (row.workflow_attempts ?? 0) < 20) continue;
    try {
      const workflow = await env.SUBMISSION_WORKFLOW.get(row.new_submission_id);
      const status = await workflow.status();
      if (!rejudgeWorkflowNeedsInfrastructureRepair({
        status: status.status,
        submissionUpdatedAt: row.submission_updated_at,
        now: repairTime,
      })) continue;
      const terminalAt = new Date().toISOString();
      const results = await env.SUBMISSIONS_DB.batch([
        env.SUBMISSIONS_DB.prepare("UPDATE submissions SET state='infrastructure-error', score=0, fully_passed_cases=0, updated_at=?, completed_at=? WHERE id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')")
          .bind(terminalAt, terminalAt, row.new_submission_id),
        env.SUBMISSIONS_DB.prepare("UPDATE submission_attempts SET state='failed', finished_at=COALESCE(finished_at, ?), failure_code=COALESCE(failure_code, 'workflow-terminal-without-result') WHERE submission_id=? AND state IN ('created','running') AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='infrastructure-error')")
          .bind(terminalAt, row.new_submission_id, row.new_submission_id),
        prepareSubmissionEventInsert(env.SUBMISSIONS_DB, {
          submissionId: row.new_submission_id,
          eventKey: `rejudge:terminal:${row.rejudge_batch_id}`,
          event: { kind: "state", state: "infrastructure-error" },
          timestamp: terminalAt,
          requiredState: "infrastructure-error",
        }),
        env.SUBMISSIONS_DB.prepare("UPDATE rejudge_jobs SET state='failed', result_state='infrastructure-error', workflow_payload_json='{}', updated_at=? WHERE rejudge_batch_id=? AND old_submission_id=? AND state='dispatched' AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='infrastructure-error')")
          .bind(terminalAt, row.rejudge_batch_id, row.old_submission_id, row.new_submission_id),
      ]);
      repaired += results[3]?.meta.changes ?? 0;
    } catch {
      operationalLog("warn", {
        event: "reconciler.delivery-failed",
        outcome: "deferred",
        code: "rejudge-workflow-terminal-repair",
        aggregateType: "submission",
        aggregateId: row.new_submission_id,
      });
    }
  }
  return repaired;
}

async function cancelRejudgeChildren(env: ForgeWorkerEnv, batch: RejudgeBatchRow, failureCode = "rejudge-cancelled"): Promise<boolean> {
  const now = new Date().toISOString();
  await env.CORE_DB.prepare("UPDATE rejudge_batches SET cancel_requested_at=COALESCE(cancel_requested_at, ?), failure_code=COALESCE(failure_code, ?), updated_at=? WHERE id=? AND status IN ('queued','running','ready')")
    .bind(now, failureCode, now, batch.id).run();
  const runningChildren = await env.SUBMISSIONS_DB.prepare("SELECT new_submission_id FROM rejudge_jobs WHERE rejudge_batch_id=? AND state='dispatched'")
    .bind(batch.id).all<{ new_submission_id: string }>();
  await env.SUBMISSIONS_DB.batch([
    env.SUBMISSIONS_DB.prepare("UPDATE submissions SET state='cancelled', updated_at=?, completed_at=COALESCE(completed_at, ?) WHERE rejudge_batch_id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')")
      .bind(now, now, batch.id),
    env.SUBMISSIONS_DB.prepare(`INSERT INTO submission_events (submission_id, event_key, payload_json, created_at)
      SELECT id, ?, '{"kind":"state","state":"cancelled"}', ?
      FROM submissions
      WHERE rejudge_batch_id=? AND state='cancelled'
      ON CONFLICT(submission_id, event_key) DO NOTHING`)
      .bind(`rejudge:cancelled:${batch.id}`, now, batch.id),
    env.SUBMISSIONS_DB.prepare("UPDATE submission_attempts SET state='cancelled', finished_at=COALESCE(finished_at, ?) WHERE submission_id IN (SELECT new_submission_id FROM rejudge_jobs WHERE rejudge_batch_id=?) AND state IN ('created','running')")
      .bind(now, batch.id),
    env.SUBMISSIONS_DB.prepare("UPDATE rejudge_jobs SET state='cancelled', result_state='cancelled', workflow_payload_json='{}', updated_at=? WHERE rejudge_batch_id=? AND state IN ('pending','dispatched')")
      .bind(now, batch.id),
    env.SUBMISSIONS_DB.prepare("UPDATE submission_outbox SET delivered_at=COALESCE(delivered_at, ?), payload_json='{}', last_error='rejudge-cancelled' WHERE submission_id IN (SELECT new_submission_id FROM rejudge_jobs WHERE rejudge_batch_id=?) AND kind='start-workflow' AND delivered_at IS NULL")
      .bind(now, batch.id),
    env.SUBMISSIONS_DB.prepare("UPDATE rejudge_result_outbox SET delivered_at=COALESCE(delivered_at, ?), last_error='rejudge-cancelled' WHERE rejudge_batch_id=? AND delivered_at IS NULL")
      .bind(now, batch.id),
    env.SUBMISSIONS_DB.prepare("DELETE FROM effective_rejudges WHERE rejudge_batch_id=? AND became_effective_at IS NULL")
      .bind(batch.id),
  ]);
  for (const child of runningChildren.results) {
    try {
      const workflow = await env.SUBMISSION_WORKFLOW.get(child.new_submission_id);
      const status = await workflow.status();
      if (!TERMINAL_WORKFLOW_STATES.has(status.status)) await workflow.terminate();
    } catch {
      // The D1 terminal state is authoritative and rejects late callbacks.
    }
  }
  await env.CORE_DB.batch([
    env.CORE_DB.prepare("DELETE FROM rejudge_verified_solves WHERE rejudge_batch_id=?").bind(batch.id),
    env.CORE_DB.prepare("UPDATE rejudge_batches SET status='failed', failure_code=?, updated_at=? WHERE id=? AND status<>'effective'")
      .bind(failureCode, new Date().toISOString(), batch.id),
  ]);
  return true;
}

async function activateReadyBatch(env: ForgeWorkerEnv, batch: RejudgeBatchRow): Promise<boolean> {
  const aggregate = await env.SUBMISSIONS_DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN state='ready' THEN 1 ELSE 0 END) AS ready, SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed FROM rejudge_jobs WHERE rejudge_batch_id=? AND erasure_excluded_at IS NULL")
    .bind(batch.id).first<{ total: number; ready: number | null; failed: number | null }>();
  const pending = await env.SUBMISSIONS_DB.prepare("SELECT 1 AS pending FROM rejudge_result_outbox JOIN rejudge_jobs ON rejudge_jobs.rejudge_batch_id=rejudge_result_outbox.rejudge_batch_id AND rejudge_jobs.old_submission_id=rejudge_result_outbox.old_submission_id WHERE rejudge_result_outbox.rejudge_batch_id=? AND rejudge_result_outbox.delivered_at IS NULL AND rejudge_jobs.erasure_excluded_at IS NULL LIMIT 1")
    .bind(batch.id).first<{ pending: number }>();
  const mappings = await env.SUBMISSIONS_DB.prepare("SELECT COUNT(*) AS count FROM effective_rejudges JOIN rejudge_jobs ON rejudge_jobs.rejudge_batch_id=effective_rejudges.rejudge_batch_id AND rejudge_jobs.old_submission_id=effective_rejudges.old_submission_id WHERE effective_rejudges.rejudge_batch_id=? AND rejudge_jobs.erasure_excluded_at IS NULL")
    .bind(batch.id).first<{ count: number }>();
  if ((aggregate?.total ?? -1) !== batch.expected_count || (aggregate?.ready ?? 0) !== batch.expected_count || (aggregate?.failed ?? 0) !== 0 || pending || (mappings?.count ?? 0) !== batch.expected_count) return false;
  const now = new Date().toISOString();
  const [activation] = await env.CORE_DB.batch([
    env.CORE_DB.prepare("UPDATE rejudge_batches SET status='effective', effective_at=?, updated_at=? WHERE id=? AND status='ready' AND ready_count=expected_count AND failed_count=0 AND cancel_requested_at IS NULL")
      .bind(now, now, batch.id),
    env.CORE_DB.prepare("DELETE FROM verified_solves WHERE managed_problem_version_id=? AND EXISTS (SELECT 1 FROM rejudge_batches WHERE id=? AND status='effective')")
      .bind(batch.old_problem_version_id, batch.id),
    env.CORE_DB.prepare("DELETE FROM verified_solves WHERE managed_problem_version_id IN (SELECT original_problem_version_id FROM effective_problem_versions WHERE effective_problem_version_id=?) AND EXISTS (SELECT 1 FROM rejudge_batches WHERE id=? AND status='effective')")
      .bind(batch.old_problem_version_id, batch.id),
    env.CORE_DB.prepare("INSERT INTO verified_solves (user_id, managed_problem_version_id, effective_submission_id, score, solved_at) SELECT rejudge_verified_solves.user_id, rejudge_verified_solves.managed_problem_version_id, rejudge_verified_solves.effective_submission_id, 100, rejudge_verified_solves.solved_at FROM rejudge_verified_solves JOIN users ON users.id=rejudge_verified_solves.user_id AND users.status='active' WHERE rejudge_verified_solves.rejudge_batch_id=? AND EXISTS (SELECT 1 FROM rejudge_batches WHERE id=? AND status='effective') ON CONFLICT(user_id, managed_problem_version_id) DO UPDATE SET effective_submission_id=CASE WHEN excluded.solved_at < solved_at THEN excluded.effective_submission_id ELSE effective_submission_id END, score=100, solved_at=MIN(solved_at, excluded.solved_at)")
      .bind(batch.id, batch.id),
    env.CORE_DB.prepare("UPDATE effective_problem_versions SET effective_problem_version_id=?, rejudge_batch_id=?, effective_at=? WHERE effective_problem_version_id=? AND EXISTS (SELECT 1 FROM rejudge_batches WHERE id=? AND status='effective')")
      .bind(batch.new_problem_version_id, batch.id, now, batch.old_problem_version_id, batch.id),
    env.CORE_DB.prepare("INSERT INTO effective_problem_versions (original_problem_version_id, effective_problem_version_id, rejudge_batch_id, effective_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM rejudge_batches WHERE id=? AND status='effective') ON CONFLICT(original_problem_version_id) DO UPDATE SET effective_problem_version_id=excluded.effective_problem_version_id, rejudge_batch_id=excluded.rejudge_batch_id, effective_at=excluded.effective_at")
      .bind(batch.old_problem_version_id, batch.new_problem_version_id, batch.id, now, batch.id),
  ]);
  if (activation.meta.changes !== 1) return false;
  await env.SUBMISSIONS_DB.prepare("UPDATE effective_rejudges SET became_effective_at=COALESCE(became_effective_at, ?) WHERE rejudge_batch_id=?")
    .bind(now, batch.id).run();
  await env.CORE_DB.prepare("UPDATE rejudge_batches SET mappings_finalized_at=COALESCE(mappings_finalized_at, ?), updated_at=? WHERE id=? AND status='effective'")
    .bind(now, now, batch.id).run();
  return true;
}

async function reconcileErasureAdjustedExpectedCount(env: ForgeWorkerEnv, batch: RejudgeBatchRow): Promise<RejudgeBatchRow> {
  const materialization = await env.CORE_DB.prepare("SELECT 1 AS settled FROM core_outbox WHERE kind='materialize-rejudge' AND aggregate_id=? AND delivered_at IS NOT NULL LIMIT 1")
    .bind(batch.id).first<{ settled: number }>();
  if (!materialization) return batch;
  const aggregate = await env.SUBMISSIONS_DB.prepare("SELECT COUNT(*) AS count FROM rejudge_jobs WHERE rejudge_batch_id=? AND erasure_excluded_at IS NULL")
    .bind(batch.id).first<{ count: number }>();
  const expectedCount = erasureAdjustedExpectedCount(batch.expected_count, aggregate?.count ?? 0, true);
  if (expectedCount === batch.expected_count) return batch;
  const updated = await env.CORE_DB.prepare("UPDATE rejudge_batches SET expected_count=?, completed_count=MIN(completed_count, ?), ready_count=MIN(ready_count, ?), updated_at=? WHERE id=? AND expected_count=? AND status IN ('running','ready')")
    .bind(expectedCount, expectedCount, expectedCount, new Date().toISOString(), batch.id, batch.expected_count).run();
  if (updated.meta.changes === 1) return {
    ...batch,
    expected_count: expectedCount,
    completed_count: Math.min(batch.completed_count, expectedCount),
    ready_count: Math.min(batch.ready_count, expectedCount),
  };
  const current = await env.CORE_DB.prepare("SELECT * FROM rejudge_batches WHERE id=?")
    .bind(batch.id).first<RejudgeBatchRow>();
  if (!current) throw new Error("Rejudge batch disappeared while reconciling erasure exclusions.");
  return current;
}

export async function refreshRejudgeBatches(env: ForgeWorkerEnv): Promise<number> {
  await repairDispatchedRejudgeJobs(env);
  const batches = await env.CORE_DB.prepare("SELECT * FROM rejudge_batches WHERE status IN ('queued','running','ready') OR (status='effective' AND mappings_finalized_at IS NULL) ORDER BY created_at LIMIT 20")
    .all<RejudgeBatchRow>();
  let changed = 0;
  for (const selectedBatch of batches.results) {
    const batch = selectedBatch.status === "effective" ? selectedBatch : await reconcileErasureAdjustedExpectedCount(env, selectedBatch);
    if (batch.status === "effective") {
      await env.SUBMISSIONS_DB.prepare("UPDATE effective_rejudges SET became_effective_at=COALESCE(became_effective_at, ?) WHERE rejudge_batch_id=?")
        .bind(batch.effective_at, batch.id).run();
      await env.CORE_DB.prepare("UPDATE rejudge_batches SET mappings_finalized_at=COALESCE(mappings_finalized_at, ?), updated_at=? WHERE id=? AND status='effective'")
        .bind(batch.effective_at, new Date().toISOString(), batch.id).run();
      continue;
    }
    if (batch.cancel_requested_at) {
      if (await cancelRejudgeChildren(env, batch, batch.failure_code ?? "rejudge-cancelled")) changed += 1;
      continue;
    }
    if (batch.status === "queued") continue;
    const aggregate = await env.SUBMISSIONS_DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN state='ready' THEN 1 ELSE 0 END) AS ready, SUM(CASE WHEN state IN ('failed','cancelled') THEN 1 ELSE 0 END) AS failed FROM rejudge_jobs WHERE rejudge_batch_id=? AND erasure_excluded_at IS NULL")
      .bind(batch.id).first<{ total: number; ready: number | null; failed: number | null }>();
    const ready = aggregate?.ready ?? 0;
    const failed = aggregate?.failed ?? 0;
    const total = aggregate?.total ?? 0;
    let progress;
    try {
      progress = classifyRejudgeProgress({ expected: batch.expected_count, materialized: total, ready, failed });
    } catch {
      if (await cancelRejudgeChildren(env, batch, "rejudge-source-set-changed")) changed += 1;
      continue;
    }
    if (progress === "failed") {
      await env.CORE_DB.prepare("UPDATE rejudge_batches SET completed_count=?, ready_count=?, failed_count=?, updated_at=? WHERE id=? AND status IN ('running','ready')")
        .bind(ready + failed, ready, failed, new Date().toISOString(), batch.id).run();
      if (await cancelRejudgeChildren(env, batch, "rejudge-child-failed")) changed += 1;
      continue;
    }
    const nextStatus = progress === "ready" ? "ready" : batch.status;
    await env.CORE_DB.prepare("UPDATE rejudge_batches SET status=?, completed_count=?, ready_count=?, failed_count=0, updated_at=? WHERE id=? AND status IN ('running','ready')")
      .bind(nextStatus, ready, ready, new Date().toISOString(), batch.id).run();
    if (nextStatus === "ready" && await activateReadyBatch(env, { ...batch, status: "ready", completed_count: ready, ready_count: ready, failed_count: 0 })) changed += 1;
  }
  return changed;
}

export async function effectiveProblemVersion(env: ForgeWorkerEnv, requestedProblemVersionId: string): Promise<{
  readonly effectiveProblemVersionId: string;
  readonly rejudgeBatchId?: string;
  readonly stagedProblemVersionId?: string;
}> {
  const row = await env.CORE_DB.prepare(
    "SELECT effective_problem_versions.effective_problem_version_id, effective_problem_versions.rejudge_batch_id, rejudge_batches.old_problem_version_id AS staged_problem_version_id FROM effective_problem_versions JOIN rejudge_batches ON rejudge_batches.id=effective_problem_versions.rejudge_batch_id WHERE effective_problem_versions.original_problem_version_id=? AND rejudge_batches.status='effective'",
  ).bind(requestedProblemVersionId).first<{ effective_problem_version_id: string; rejudge_batch_id: string; staged_problem_version_id: string }>();
  return row ? {
    effectiveProblemVersionId: row.effective_problem_version_id,
    rejudgeBatchId: row.rejudge_batch_id,
    stagedProblemVersionId: row.staged_problem_version_id,
  } : { effectiveProblemVersionId: requestedProblemVersionId };
}
