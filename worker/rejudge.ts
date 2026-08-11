import { parseCreateRejudgeRequest, classifyRejudgeChildState, classifyRejudgeProgress } from "../src/online-judge/rejudge";
import { requireMutationSession, requireSession } from "./auth";
import { sha256Hex } from "./crypto";
import type { AuthenticatedSession, ForgeWorkerEnv } from "./env";
import { requireStagingFormalAccess } from "./formal-access";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { requireOrganizer } from "./github";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { assertActiveRelease } from "./release";
import { operationalLog } from "./structured-log";
import { parseStoredProblemTitle } from "../src/online-judge/stored-problem-title";
import { prepareSubmissionEventInsert } from "./submission-events";
import {
  deriveSubmissionAttemptToken,
  parseSubmissionWorkflowParameters,
  type SubmissionWorkflowParameters,
} from "./submission-workflow-identity";

const REJUDGE_CONCURRENCY = 5;
const MATERIALIZATION_PAGE_SIZE = 20;
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
  return `${alias}.source_erased_at IS NULL
    AND EXISTS (SELECT 1 FROM users AS ${alias}_owner WHERE ${alias}_owner.id=${alias}.user_id AND ${alias}_owner.status='active')
    AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs AS ${alias}_erasure WHERE ${alias}_erasure.user_id=${alias}.user_id)`;
}

export const MATERIALIZE_REJUDGE_SUBMISSION_SQL = `INSERT OR IGNORE INTO submissions (id, user_id, managed_problem_version_id, contest_id, language, target, optimization, entry_path, source_r2_key, source_digest, forge_release_id, forge_manifest_sha256, state, visibility, admitted_at, created_at, updated_at, rejudge_batch_id, rejudge_of_submission_id)
SELECT ?, original.user_id, ?, original.contest_id, original.language, original.target, original.optimization, original.entry_path, original.source_r2_key, original.source_digest, ?, ?, 'admitting', 'private', ?, ?, ?, ?, original.id
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

export const CLAIM_REJUDGE_OUTBOX_SQL = `INSERT OR IGNORE INTO outbox (id, kind, aggregate_id, payload_json, created_at)
SELECT ?, 'start-submission-workflow', child.id, ?, ?
FROM rejudge_jobs
JOIN submissions AS child ON child.id=rejudge_jobs.new_submission_id
JOIN submissions AS original ON original.id=rejudge_jobs.old_submission_id
WHERE rejudge_jobs.rejudge_batch_id=? AND rejudge_jobs.old_submission_id=? AND rejudge_jobs.state='pending' AND ${DISPATCH_REJUDGE_ELIGIBILITY_SQL}`;

export const CLAIM_REJUDGE_JOB_SQL = `UPDATE rejudge_jobs SET state='dispatched', workflow_payload_json='{}', updated_at=?
WHERE rejudge_batch_id=? AND old_submission_id=? AND state='pending' AND erasure_excluded_at IS NULL
AND EXISTS (
  SELECT 1 FROM submissions AS child
  JOIN submissions AS original ON original.id=rejudge_jobs.old_submission_id
  WHERE child.id=rejudge_jobs.new_submission_id AND child.user_id=original.user_id AND child.state='queued' AND ${availableSubmissionSourceSql("original")} AND ${availableSubmissionSourceSql("child")}
)`;

export const QUEUE_REJUDGE_CHILD_SQL = `UPDATE submissions SET state='queued', updated_at=?
WHERE id=? AND state='admitting' AND EXISTS (
  SELECT 1 FROM rejudge_jobs
  WHERE rejudge_jobs.rejudge_batch_id=?
    AND rejudge_jobs.old_submission_id=?
    AND rejudge_jobs.new_submission_id=submissions.id
    AND rejudge_jobs.state='pending'
    AND rejudge_jobs.erasure_excluded_at IS NULL
)`;

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
  return env.DB.prepare(
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
  const row = await env.DB.prepare("SELECT * FROM rejudge_batches WHERE id=?")
    .bind(batchId).first<RejudgeBatchRow>();
  if (!row || (!session.roles.includes("admin") && row.requested_by !== session.userId)) {
    throw new ApiError(404, "rejudge-batch-not-found", "Rejudge batch was not found.");
  }
  return row;
}

export async function assertProblemVersionAcceptsSubmission(env: ForgeWorkerEnv, problemVersionId: string): Promise<void> {
  const blocked = await env.DB.prepare(
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
  const existing = await env.DB.prepare("SELECT id, request_digest, status FROM rejudge_batches WHERE requested_by=? AND idempotency_key=?")
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
  const staleSource = await env.DB.prepare("SELECT 1 AS stale FROM effective_problem_versions WHERE original_problem_version_id=?")
    .bind(oldVersion.id).first<{ stale: number }>();
  if (staleSource) throw new ApiError(409, "rejudge-source-superseded", "Start the next rejudge from the currently effective problem version.");
  const staleSuccessor = await env.DB.prepare("SELECT 1 AS stale FROM effective_problem_versions WHERE original_problem_version_id=? UNION ALL SELECT 1 AS stale FROM rejudge_batches WHERE old_problem_version_id=? AND status IN ('queued','running','ready') LIMIT 1")
    .bind(newVersion.id, newVersion.id).first<{ stale: number }>();
  if (staleSuccessor) throw new ApiError(409, "rejudge-successor-superseded", "The successor problem version must itself be current and immutable.");

  await requireFormalMutationsEnabled(env);
  const active = await assertActiveRelease(
    env.DB,
    env.JUDGE_BUCKET,
    env.ENVIRONMENT,
    env.FORGE_RELEASE_ID,
    env.FORGE_RELEASE_MANIFEST_SHA256,
  );
  const batchId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rejudge_batches (id, old_problem_version_id, new_problem_version_id, requested_by, status, expected_count, completed_count, created_at, idempotency_key, request_digest, forge_release_id, forge_manifest_sha256, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?, ?, ?)")
        .bind(batchId, oldVersion.id, newVersion.id, session.userId, now, input.idempotencyKey, requestDigest, active.releaseId, active.manifestSha256, now),
      env.DB.prepare("INSERT INTO outbox (id, kind, aggregate_id, payload_json, created_at) VALUES (?, 'materialize-rejudge', ?, ?, ?)")
        .bind(outboxId, batchId, JSON.stringify({ batchId }), now),
    ]);
  } catch (error) {
    const winner = await env.DB.prepare("SELECT id, request_digest, status FROM rejudge_batches WHERE requested_by=? AND idempotency_key=?")
      .bind(session.userId, input.idempotencyKey).first<{ id: string; request_digest: string; status: string }>();
    if (winner?.request_digest === requestDigest) return jsonResponse({ rejudgeBatchId: winner.id, status: winner.status, replayed: true });
    const inFlight = await env.DB.prepare("SELECT id FROM rejudge_batches WHERE old_problem_version_id=? AND status IN ('queued','running','ready')")
      .bind(oldVersion.id).first<{ id: string }>();
    if (inFlight) throw new ApiError(409, "rejudge-already-running", "This problem version already has a rejudge in progress.");
    throw error;
  }
  return jsonResponse({ rejudgeBatchId: batchId, status: "queued", replayed: false }, 202);
}

interface RejudgeVersionOptionRow {
  readonly id: string;
  readonly problem_slug: string;
  readonly problem_number: number;
  readonly title_json: string;
  readonly snapshot_id: string;
  readonly collection_revision: string;
  readonly snapshot_status: string;
  readonly snapshot_mode: string;
  readonly published_at: string | null;
  readonly github_repository_id: number;
  readonly owner_login: string;
  readonly repository_name: string;
}

function rejudgeVersionOption(row: RejudgeVersionOptionRow) {
  return {
    problemVersionId: row.id,
    slug: row.problem_slug,
    number: row.problem_number,
    title: parseStoredProblemTitle(row.title_json),
    snapshotId: row.snapshot_id,
    collectionRevision: row.collection_revision,
    status: row.snapshot_status,
    mode: row.snapshot_mode,
    publishedAt: row.published_at,
    repository: {
      id: row.github_repository_id,
      owner: row.owner_login,
      name: row.repository_name,
    },
  };
}

export async function rejudgeOptions(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const sourceId = new URL(request.url).searchParams.get("source");
  const admin = session.roles.includes("admin") ? 1 : 0;
  const projection = `SELECT versions.id, versions.problem_slug, versions.problem_number, versions.title_json,
      snapshots.id AS snapshot_id, snapshots.collection_revision, snapshots.status AS snapshot_status,
      snapshots.mode AS snapshot_mode, snapshots.published_at,
      repositories.github_repository_id, repositories.owner_login, repositories.name AS repository_name
    FROM managed_problem_versions AS versions
    JOIN managed_snapshots AS snapshots ON snapshots.id=versions.snapshot_id
    JOIN collection_imports AS imports ON imports.id=snapshots.import_id
    JOIN github_repositories AS repositories ON repositories.github_repository_id=imports.github_repository_id`;
  if (sourceId === null) {
    const rows = await env.DB.prepare(`${projection}
      WHERE (?=1 OR imports.organizer_user_id=?)
        AND snapshots.status IN ('published','superseded')
        AND NOT EXISTS (SELECT 1 FROM effective_problem_versions WHERE original_problem_version_id=versions.id)
        AND NOT EXISTS (SELECT 1 FROM rejudge_batches WHERE old_problem_version_id=versions.id AND status IN ('queued','running','ready'))
      ORDER BY repositories.owner_login, repositories.name, snapshots.mode, versions.problem_number, snapshots.published_at DESC`)
      .bind(admin, session.userId).all<RejudgeVersionOptionRow>();
    return jsonResponse({ sources: rows.results.map(rejudgeVersionOption) });
  }
  const source = await managedVersion(env, sourceId);
  if (!source || (!session.roles.includes("admin") && source.organizer_user_id !== session.userId)) {
    throw new ApiError(404, "rejudge-version-not-found", "Managed problem version was not found.");
  }
  if (!['published', 'superseded'].includes(source.snapshot_status)) {
    throw new ApiError(409, "rejudge-version-state", "Rejudge source must be a published problem version.");
  }
  const rows = await env.DB.prepare(`${projection}
      WHERE (?=1 OR imports.organizer_user_id=?)
        AND versions.id<>? AND versions.problem_slug=? AND snapshots.mode=? AND snapshots.status='published'
        AND NOT EXISTS (SELECT 1 FROM effective_problem_versions WHERE original_problem_version_id=versions.id)
        AND NOT EXISTS (SELECT 1 FROM rejudge_batches WHERE old_problem_version_id=versions.id AND status IN ('queued','running','ready'))
      ORDER BY snapshots.published_at DESC, repositories.owner_login, repositories.name`)
    .bind(admin, session.userId, source.id, source.problem_slug, source.snapshot_mode).all<RejudgeVersionOptionRow>();
  return jsonResponse({ sourceProblemVersionId: source.id, successors: rows.results.map(rejudgeVersionOption) });
}

export async function listRejudgeBatches(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
  const rows = await env.DB.prepare(`SELECT batches.*,
      old_versions.problem_slug AS old_slug, old_versions.problem_number AS old_number, old_versions.title_json AS old_title_json,
      old_snapshots.collection_revision AS old_revision,
      new_versions.problem_slug AS new_slug, new_versions.problem_number AS new_number, new_versions.title_json AS new_title_json,
      new_snapshots.collection_revision AS new_revision,
      repositories.owner_login, repositories.name AS repository_name
    FROM rejudge_batches AS batches
    JOIN managed_problem_versions AS old_versions ON old_versions.id=batches.old_problem_version_id
    JOIN managed_snapshots AS old_snapshots ON old_snapshots.id=old_versions.snapshot_id
    JOIN collection_imports AS imports ON imports.id=old_snapshots.import_id
    JOIN github_repositories AS repositories ON repositories.github_repository_id=imports.github_repository_id
    JOIN managed_problem_versions AS new_versions ON new_versions.id=batches.new_problem_version_id
    JOIN managed_snapshots AS new_snapshots ON new_snapshots.id=new_versions.snapshot_id
    WHERE batches.requested_by=?
    ORDER BY batches.created_at DESC LIMIT ?`)
    .bind(session.userId, limit).all<Record<string, unknown>>();
  return jsonResponse({ rejudgeBatches: rows.results.map((row) => ({
    id: row.id,
    status: row.cancel_requested_at && !["effective", "failed"].includes(String(row.status)) ? "cancelling" : row.status,
    expectedCount: row.expected_count,
    completedCount: row.completed_count,
    readyCount: row.ready_count,
    failedCount: row.failed_count,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    effectiveAt: row.effective_at,
    cancellable: ["queued", "running", "ready"].includes(String(row.status)) && row.cancel_requested_at === null,
    repository: `${row.owner_login}/${row.repository_name}`,
    oldProblem: { problemVersionId: row.old_problem_version_id, slug: row.old_slug, number: row.old_number, title: parseStoredProblemTitle(row.old_title_json), collectionRevision: row.old_revision },
    newProblem: { problemVersionId: row.new_problem_version_id, slug: row.new_slug, number: row.new_number, title: parseStoredProblemTitle(row.new_title_json), collectionRevision: row.new_revision },
  })) });
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
  const result = await env.DB.prepare("UPDATE rejudge_batches SET cancel_requested_at=?, updated_at=? WHERE id=? AND status IN ('queued','running','ready') AND cancel_requested_at IS NULL")
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
  const activePredecessors = await env.DB.prepare("SELECT DISTINCT rejudge_batch_id FROM effective_problem_versions WHERE effective_problem_version_id=?")
    .bind(oldProblemVersionId).all<{ rejudge_batch_id: string }>();
  if (activePredecessors.results.length === 0) return { sql: "submissions.rejudge_batch_id IS NULL", bindings: [] };
  const ids = activePredecessors.results.map((row) => row.rejudge_batch_id);
  return {
    sql: `(submissions.rejudge_batch_id IS NULL OR submissions.rejudge_batch_id IN (${ids.map(() => "?").join(",")}))`,
    bindings: ids,
  };
}

export async function materializeRejudgeBatch(env: ForgeWorkerEnv, batchId: string): Promise<boolean> {
  const batch = await env.DB.prepare("SELECT * FROM rejudge_batches WHERE id=?")
    .bind(batchId).first<RejudgeBatchRow>();
  if (!batch || ["effective", "failed"].includes(batch.status)) return true;
  if (batch.cancel_requested_at) {
    return cancelRejudgeChildren(env, batch, batch.failure_code ?? "rejudge-cancelled");
  }
  const version = await managedVersion(env, batch.new_problem_version_id);
  if (!version || version.snapshot_status !== "published" || !batch.forge_release_id || !batch.forge_manifest_sha256) {
    return cancelRejudgeChildren(env, batch, "rejudge-version-unavailable");
  }
  const active = await assertActiveRelease(env.DB, env.JUDGE_BUCKET, env.ENVIRONMENT, batch.forge_release_id, batch.forge_manifest_sha256);
  const predicate = await eligibleRejudgePredicate(env, batch.old_problem_version_id);
  const baseBindings = [batch.old_problem_version_id, ...predicate.bindings] as const;
  const sourceAvailable = availableSubmissionSourceSql("submissions");
  const nonterminal = await env.DB.prepare(`SELECT 1 AS pending FROM submissions WHERE managed_problem_version_id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled') AND ${predicate.sql} AND ${sourceAvailable} LIMIT 1`)
    .bind(...baseBindings).first<{ pending: number }>();
  if (nonterminal) return false;
  const sourceSetEligibility = `(${sourceAvailable} OR EXISTS (SELECT 1 FROM rejudge_jobs WHERE rejudge_jobs.rejudge_batch_id=? AND rejudge_jobs.old_submission_id=submissions.id AND rejudge_jobs.state='ready' AND rejudge_jobs.erasure_excluded_at IS NULL))`;
  const profiles = await env.DB.prepare(`SELECT DISTINCT language, target, optimization FROM submissions WHERE managed_problem_version_id=? AND state IN ('completed','compile-error') AND ${predicate.sql} AND ${sourceSetEligibility}`)
    .bind(...baseBindings, batchId).all<{ language: string; target: string; optimization: string }>();
  const allowedProfiles = parseProfiles(version.compile_profiles_json);
  const allowedLanguages = JSON.parse(version.allowed_languages_json) as unknown;
  if (!Array.isArray(allowedLanguages) || profiles.results.some((profile) => !allowedLanguages.includes(profile.language) || allowedProfiles[profile.language]?.target !== profile.target || allowedProfiles[profile.language]?.optimization !== profile.optimization)) {
    return cancelRejudgeChildren(env, batch, "rejudge-profile-incompatible");
  }
  const eligible = await env.DB.prepare(`SELECT COUNT(*) AS count FROM submissions WHERE managed_problem_version_id=? AND state IN ('completed','compile-error') AND ${predicate.sql} AND ${sourceSetEligibility}`)
    .bind(...baseBindings, batchId).first<{ count: number }>();
  const expectedCount = eligible?.count ?? 0;
  await env.DB.prepare("UPDATE rejudge_batches SET status='running', expected_count=?, updated_at=? WHERE id=? AND status IN ('queued','running')")
    .bind(expectedCount, new Date().toISOString(), batchId).run();

  const rows = await env.DB.prepare(`SELECT submissions.id, submissions.user_id, submissions.contest_id, submissions.language, submissions.target, submissions.optimization, submissions.entry_path, submissions.source_r2_key, submissions.source_digest, submissions.completed_at FROM submissions LEFT JOIN rejudge_jobs ON rejudge_jobs.rejudge_batch_id=? AND rejudge_jobs.old_submission_id=submissions.id WHERE submissions.managed_problem_version_id=? AND submissions.state IN ('completed','compile-error') AND ${predicate.sql} AND ${sourceAvailable} AND rejudge_jobs.old_submission_id IS NULL ORDER BY submissions.created_at, submissions.id LIMIT ?`)
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
    await env.DB.batch([
      env.DB.prepare(MATERIALIZE_REJUDGE_SUBMISSION_SQL)
        .bind(childId, version.id, active.releaseId, active.manifestSha256, now, now, now, batchId, source.id, source.user_id, batch.old_problem_version_id, source.source_r2_key, source.source_digest),
      env.DB.prepare(MATERIALIZE_REJUDGE_ATTEMPT_SQL)
        .bind(await sha256Hex(attemptToken), `${childId}:1`, childId, batchId),
      env.DB.prepare(MATERIALIZE_REJUDGE_JOB_SQL)
        .bind(batchId, batch.old_problem_version_id, version.id, JSON.stringify(parameters), now, now, childId, batchId, source.id),
    ]);
  }
  const materialized = await env.DB.prepare("SELECT COUNT(*) AS count FROM rejudge_jobs WHERE rejudge_batch_id=? AND erasure_excluded_at IS NULL")
    .bind(batchId).first<{ count: number }>();
  return (materialized?.count ?? 0) === expectedCount;
}

function workflowPayload(value: string): SubmissionWorkflowParameters {
  return parseSubmissionWorkflowParameters(JSON.parse(value) as unknown);
}

async function dispatchRejudgeBatch(env: ForgeWorkerEnv, batch: RejudgeBatchRow, allowance: number): Promise<number> {
  if (allowance <= 0 || batch.cancel_requested_at || batch.status !== "running") return 0;
  const jobs = await env.DB.prepare(`SELECT rejudge_jobs.old_submission_id, rejudge_jobs.new_submission_id, rejudge_jobs.workflow_payload_json
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
    const [, queued, claimed] = await env.DB.batch([
      env.DB.prepare(CLAIM_REJUDGE_OUTBOX_SQL)
        .bind(outboxId, JSON.stringify(payload), now, batch.id, job.old_submission_id),
      env.DB.prepare(QUEUE_REJUDGE_CHILD_SQL)
        .bind(now, job.new_submission_id, batch.id, job.old_submission_id),
      env.DB.prepare(CLAIM_REJUDGE_JOB_SQL)
        .bind(now, batch.id, job.old_submission_id),
    ]);
    if (queued?.meta.changes === 1 && claimed?.meta.changes === 1) dispatched += 1;
  }
  return dispatched;
}

export async function dispatchRejudgeJobs(env: ForgeWorkerEnv): Promise<number> {
  const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM rejudge_jobs WHERE state='dispatched'")
    .first<{ count: number }>();
  let allowance = Math.max(0, REJUDGE_CONCURRENCY - (active?.count ?? 0));
  if (allowance === 0) return 0;
  const batches = await env.DB.prepare("SELECT * FROM rejudge_batches WHERE status='running' AND cancel_requested_at IS NULL ORDER BY created_at LIMIT 10")
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

async function settleTerminalRejudgeJob(env: ForgeWorkerEnv, row: RejudgeResultRow): Promise<boolean> {
  const now = new Date().toISOString();
  const batch = await env.DB.prepare("SELECT status, cancel_requested_at FROM rejudge_batches WHERE id=?")
    .bind(row.rejudge_batch_id).first<{ status: string; cancel_requested_at: string | null }>();
  if (!batch || batch.status !== "running" || batch.cancel_requested_at) {
    const cancelled = await env.DB.prepare("UPDATE rejudge_jobs SET state='cancelled', result_state='cancelled', workflow_payload_json='{}', updated_at=? WHERE rejudge_batch_id=? AND old_submission_id=? AND state='dispatched'")
      .bind(now, row.rejudge_batch_id, row.old_submission_id).run();
    return cancelled.meta.changes === 1;
  }
  const ownerActive = await env.DB.prepare(`SELECT 1 AS valid
    FROM submissions AS original
    JOIN submissions AS child ON child.id=? AND child.user_id=original.user_id
    JOIN users ON users.id=child.user_id AND users.status='active'
    WHERE original.id=?
      AND original.source_erased_at IS NULL
      AND child.source_erased_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=child.user_id)`)
    .bind(row.new_submission_id, row.old_submission_id).first<{ valid: number }>();
  if (!ownerActive) {
    const cancelled = await env.DB.prepare("UPDATE rejudge_jobs SET state='cancelled', result_state='cancelled', erasure_excluded_at=COALESCE(erasure_excluded_at, ?), workflow_payload_json='{}', updated_at=? WHERE rejudge_batch_id=? AND old_submission_id=? AND state='dispatched'")
      .bind(now, now, row.rejudge_batch_id, row.old_submission_id).run();
    return cancelled.meta.changes === 1;
  }
  const disposition = classifyRejudgeChildState(row.state);
  if (disposition === "failed") {
    const failed = await env.DB.prepare("UPDATE rejudge_jobs SET state='failed', result_state=?, workflow_payload_json='{}', updated_at=? WHERE rejudge_batch_id=? AND old_submission_id=? AND state='dispatched'")
      .bind(row.state, now, row.rejudge_batch_id, row.old_submission_id).run();
    return failed.meta.changes === 1;
  }
  if (row.effective_attempt === null) {
    const failed = await env.DB.prepare("UPDATE rejudge_jobs SET state='failed', result_state='infrastructure-error', workflow_payload_json='{}', updated_at=? WHERE rejudge_batch_id=? AND old_submission_id=? AND state='dispatched'")
      .bind(now, row.rejudge_batch_id, row.old_submission_id).run();
    return failed.meta.changes === 1;
  }
  const attempt = await env.DB.prepare("SELECT 1 AS valid FROM submission_attempts WHERE submission_id=? AND attempt=? AND state='succeeded'")
    .bind(row.new_submission_id, row.effective_attempt).first<{ valid: number }>();
  if (!attempt) return false;
  const [ready] = await env.DB.batch([
    env.DB.prepare(`UPDATE rejudge_jobs SET state='ready', result_state=?, workflow_payload_json='{}', updated_at=?
      WHERE rejudge_batch_id=? AND old_submission_id=? AND state='dispatched'
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND status='active')
        AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=?)`)
      .bind(row.state, now, row.rejudge_batch_id, row.old_submission_id, row.user_id, row.user_id),
    env.DB.prepare(`INSERT INTO effective_rejudges (old_submission_id, rejudge_batch_id, new_submission_id)
      SELECT ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM rejudge_jobs WHERE rejudge_batch_id=? AND old_submission_id=? AND state='ready'
      )
      ON CONFLICT(old_submission_id) DO UPDATE SET
        rejudge_batch_id=excluded.rejudge_batch_id,
        new_submission_id=excluded.new_submission_id,
        became_effective_at=NULL`)
      .bind(row.old_submission_id, row.rejudge_batch_id, row.new_submission_id, row.rejudge_batch_id, row.old_submission_id),
  ]);
  return ready.meta.changes === 1;
}

export async function settleTerminalRejudgeJobs(env: ForgeWorkerEnv): Promise<number> {
  const terminal = await env.DB.prepare(`SELECT
      rejudge_jobs.rejudge_batch_id,
      rejudge_jobs.old_submission_id,
      rejudge_jobs.new_submission_id,
      rejudge_jobs.old_problem_version_id,
      rejudge_jobs.new_problem_version_id,
      child.user_id,
      child.contest_id,
      child.state,
      child.score,
      child.fully_passed_cases,
      child.deterministic_cost,
      child.peak_memory_bytes,
      child.effective_attempt,
      original.completed_at AS old_achieved_at
    FROM rejudge_jobs
    JOIN submissions AS child ON child.id=rejudge_jobs.new_submission_id
    JOIN submissions AS original ON original.id=rejudge_jobs.old_submission_id
    WHERE rejudge_jobs.state='dispatched'
      AND child.state IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')
    ORDER BY rejudge_jobs.updated_at
    LIMIT 20`).all<RejudgeResultRow>();
  let settled = 0;
  for (const row of terminal.results) {
    if (await settleTerminalRejudgeJob(env, row)) settled += 1;
  }
  return settled;
}

export async function repairDispatchedRejudgeJobs(env: ForgeWorkerEnv): Promise<number> {
  const repairTime = new Date();
  const now = repairTime.toISOString();
  const pendingCancelled = await env.DB.prepare("UPDATE rejudge_jobs SET state='cancelled', result_state='cancelled', workflow_payload_json='{}', updated_at=? WHERE state='pending' AND EXISTS (SELECT 1 FROM submissions WHERE submissions.id=rejudge_jobs.new_submission_id AND submissions.state='cancelled')")
    .bind(now).run();
  const rows = await env.DB.prepare(
    "SELECT rejudge_jobs.rejudge_batch_id, rejudge_jobs.old_submission_id, rejudge_jobs.new_submission_id, submissions.state, submissions.updated_at AS submission_updated_at, outbox.delivered_at AS workflow_delivered_at, outbox.attempts AS workflow_attempts FROM rejudge_jobs JOIN submissions ON submissions.id=rejudge_jobs.new_submission_id LEFT JOIN outbox ON outbox.aggregate_id=rejudge_jobs.new_submission_id AND outbox.kind='start-submission-workflow' WHERE rejudge_jobs.state='dispatched' AND submissions.state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled') ORDER BY rejudge_jobs.updated_at LIMIT 20",
  ).all<{ rejudge_batch_id: string; old_submission_id: string; new_submission_id: string; state: string; submission_updated_at: string; workflow_delivered_at: string | null; workflow_attempts: number | null }>();
  let repaired = pendingCancelled.meta.changes + await settleTerminalRejudgeJobs(env);
  for (const row of rows.results) {
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
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE submissions SET state='infrastructure-error', score=0, fully_passed_cases=0, updated_at=?, completed_at=? WHERE id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')")
          .bind(terminalAt, terminalAt, row.new_submission_id),
        env.DB.prepare("UPDATE submission_attempts SET state='failed', finished_at=COALESCE(finished_at, ?), failure_code=COALESCE(failure_code, 'workflow-terminal-without-result') WHERE submission_id=? AND state IN ('created','running') AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='infrastructure-error')")
          .bind(terminalAt, row.new_submission_id, row.new_submission_id),
        prepareSubmissionEventInsert(env.DB, {
          submissionId: row.new_submission_id,
          eventKey: `rejudge:terminal:${row.rejudge_batch_id}`,
          event: { kind: "state", state: "infrastructure-error" },
          timestamp: terminalAt,
          requiredState: "infrastructure-error",
        }),
        env.DB.prepare("UPDATE rejudge_jobs SET state='failed', result_state='infrastructure-error', workflow_payload_json='{}', updated_at=? WHERE rejudge_batch_id=? AND old_submission_id=? AND state='dispatched' AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='infrastructure-error')")
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
  await env.DB.prepare("UPDATE rejudge_batches SET cancel_requested_at=COALESCE(cancel_requested_at, ?), failure_code=COALESCE(failure_code, ?), updated_at=? WHERE id=? AND status IN ('queued','running','ready')")
    .bind(now, failureCode, now, batch.id).run();
  const runningChildren = await env.DB.prepare("SELECT new_submission_id FROM rejudge_jobs WHERE rejudge_batch_id=? AND state='dispatched'")
    .bind(batch.id).all<{ new_submission_id: string }>();
  await env.DB.batch([
    env.DB.prepare("UPDATE submissions SET state='cancelled', updated_at=?, completed_at=COALESCE(completed_at, ?) WHERE rejudge_batch_id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')")
      .bind(now, now, batch.id),
    env.DB.prepare(`INSERT INTO submission_events (submission_id, event_key, payload_json, created_at)
      SELECT id, ?, '{"kind":"state","state":"cancelled"}', ?
      FROM submissions
      WHERE rejudge_batch_id=? AND state='cancelled'
      ON CONFLICT(submission_id, event_key) DO NOTHING`)
      .bind(`rejudge:cancelled:${batch.id}`, now, batch.id),
    env.DB.prepare("UPDATE submission_attempts SET state='cancelled', finished_at=COALESCE(finished_at, ?) WHERE submission_id IN (SELECT new_submission_id FROM rejudge_jobs WHERE rejudge_batch_id=?) AND state IN ('created','running')")
      .bind(now, batch.id),
    env.DB.prepare("UPDATE rejudge_jobs SET state='cancelled', result_state='cancelled', workflow_payload_json='{}', updated_at=? WHERE rejudge_batch_id=? AND state IN ('pending','dispatched')")
      .bind(now, batch.id),
    env.DB.prepare("UPDATE outbox SET delivered_at=COALESCE(delivered_at, ?), payload_json='{}', last_error='rejudge-cancelled' WHERE aggregate_id IN (SELECT new_submission_id FROM rejudge_jobs WHERE rejudge_batch_id=?) AND kind='start-submission-workflow' AND delivered_at IS NULL")
      .bind(now, batch.id),
    env.DB.prepare("DELETE FROM effective_rejudges WHERE rejudge_batch_id=? AND became_effective_at IS NULL")
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
  await env.DB.prepare("UPDATE rejudge_batches SET status='failed', failure_code=?, updated_at=? WHERE id=? AND status<>'effective'")
    .bind(failureCode, new Date().toISOString(), batch.id).run();
  return true;
}

async function activateReadyBatch(env: ForgeWorkerEnv, batch: RejudgeBatchRow): Promise<boolean> {
  const aggregate = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN state='ready' THEN 1 ELSE 0 END) AS ready, SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed FROM rejudge_jobs WHERE rejudge_batch_id=? AND erasure_excluded_at IS NULL")
    .bind(batch.id).first<{ total: number; ready: number | null; failed: number | null }>();
  const mappings = await env.DB.prepare("SELECT COUNT(*) AS count FROM effective_rejudges JOIN rejudge_jobs ON rejudge_jobs.rejudge_batch_id=effective_rejudges.rejudge_batch_id AND rejudge_jobs.old_submission_id=effective_rejudges.old_submission_id WHERE effective_rejudges.rejudge_batch_id=? AND rejudge_jobs.erasure_excluded_at IS NULL")
    .bind(batch.id).first<{ count: number }>();
  if ((aggregate?.total ?? -1) !== batch.expected_count || (aggregate?.ready ?? 0) !== batch.expected_count || (aggregate?.failed ?? 0) !== 0 || (mappings?.count ?? 0) !== batch.expected_count) return false;
  const now = new Date().toISOString();
  const [activation] = await env.DB.batch([
    env.DB.prepare("UPDATE rejudge_batches SET status='effective', effective_at=?, updated_at=? WHERE id=? AND status='ready' AND ready_count=expected_count AND failed_count=0 AND cancel_requested_at IS NULL")
      .bind(now, now, batch.id),
    env.DB.prepare("UPDATE effective_problem_versions SET effective_problem_version_id=?, rejudge_batch_id=?, effective_at=? WHERE effective_problem_version_id=? AND EXISTS (SELECT 1 FROM rejudge_batches WHERE id=? AND status='effective')")
      .bind(batch.new_problem_version_id, batch.id, now, batch.old_problem_version_id, batch.id),
    env.DB.prepare("INSERT INTO effective_problem_versions (original_problem_version_id, effective_problem_version_id, rejudge_batch_id, effective_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM rejudge_batches WHERE id=? AND status='effective') ON CONFLICT(original_problem_version_id) DO UPDATE SET effective_problem_version_id=excluded.effective_problem_version_id, rejudge_batch_id=excluded.rejudge_batch_id, effective_at=excluded.effective_at")
      .bind(batch.old_problem_version_id, batch.new_problem_version_id, batch.id, now, batch.id),
  ]);
  if (activation.meta.changes !== 1) return false;
  await env.DB.prepare("UPDATE effective_rejudges SET became_effective_at=COALESCE(became_effective_at, ?) WHERE rejudge_batch_id=?")
    .bind(now, batch.id).run();
  await env.DB.prepare("UPDATE rejudge_batches SET mappings_finalized_at=COALESCE(mappings_finalized_at, ?), updated_at=? WHERE id=? AND status='effective'")
    .bind(now, now, batch.id).run();
  return true;
}

async function reconcileErasureAdjustedExpectedCount(env: ForgeWorkerEnv, batch: RejudgeBatchRow): Promise<RejudgeBatchRow> {
  const materialization = await env.DB.prepare("SELECT 1 AS settled FROM outbox WHERE kind='materialize-rejudge' AND aggregate_id=? AND delivered_at IS NOT NULL LIMIT 1")
    .bind(batch.id).first<{ settled: number }>();
  if (!materialization) return batch;
  const aggregate = await env.DB.prepare("SELECT COUNT(*) AS count FROM rejudge_jobs WHERE rejudge_batch_id=? AND erasure_excluded_at IS NULL")
    .bind(batch.id).first<{ count: number }>();
  const expectedCount = erasureAdjustedExpectedCount(batch.expected_count, aggregate?.count ?? 0, true);
  if (expectedCount === batch.expected_count) return batch;
  const updated = await env.DB.prepare("UPDATE rejudge_batches SET expected_count=?, completed_count=MIN(completed_count, ?), ready_count=MIN(ready_count, ?), updated_at=? WHERE id=? AND expected_count=? AND status IN ('running','ready')")
    .bind(expectedCount, expectedCount, expectedCount, new Date().toISOString(), batch.id, batch.expected_count).run();
  if (updated.meta.changes === 1) return {
    ...batch,
    expected_count: expectedCount,
    completed_count: Math.min(batch.completed_count, expectedCount),
    ready_count: Math.min(batch.ready_count, expectedCount),
  };
  const current = await env.DB.prepare("SELECT * FROM rejudge_batches WHERE id=?")
    .bind(batch.id).first<RejudgeBatchRow>();
  if (!current) throw new Error("Rejudge batch disappeared while reconciling erasure exclusions.");
  return current;
}

export async function refreshRejudgeBatches(env: ForgeWorkerEnv): Promise<number> {
  await repairDispatchedRejudgeJobs(env);
  const batches = await env.DB.prepare("SELECT * FROM rejudge_batches WHERE status IN ('queued','running','ready') OR (status='effective' AND mappings_finalized_at IS NULL) ORDER BY created_at LIMIT 20")
    .all<RejudgeBatchRow>();
  let changed = 0;
  for (const selectedBatch of batches.results) {
    const batch = selectedBatch.status === "effective" ? selectedBatch : await reconcileErasureAdjustedExpectedCount(env, selectedBatch);
    if (batch.status === "effective") {
      await env.DB.prepare("UPDATE effective_rejudges SET became_effective_at=COALESCE(became_effective_at, ?) WHERE rejudge_batch_id=?")
        .bind(batch.effective_at, batch.id).run();
      await env.DB.prepare("UPDATE rejudge_batches SET mappings_finalized_at=COALESCE(mappings_finalized_at, ?), updated_at=? WHERE id=? AND status='effective'")
        .bind(batch.effective_at, new Date().toISOString(), batch.id).run();
      continue;
    }
    if (batch.cancel_requested_at) {
      if (await cancelRejudgeChildren(env, batch, batch.failure_code ?? "rejudge-cancelled")) changed += 1;
      continue;
    }
    if (batch.status === "queued") continue;
    const aggregate = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN state='ready' THEN 1 ELSE 0 END) AS ready, SUM(CASE WHEN state IN ('failed','cancelled') THEN 1 ELSE 0 END) AS failed FROM rejudge_jobs WHERE rejudge_batch_id=? AND erasure_excluded_at IS NULL")
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
      await env.DB.prepare("UPDATE rejudge_batches SET completed_count=?, ready_count=?, failed_count=?, updated_at=? WHERE id=? AND status IN ('running','ready')")
        .bind(ready + failed, ready, failed, new Date().toISOString(), batch.id).run();
      if (await cancelRejudgeChildren(env, batch, "rejudge-child-failed")) changed += 1;
      continue;
    }
    const nextStatus = progress === "ready" ? "ready" : batch.status;
    await env.DB.prepare("UPDATE rejudge_batches SET status=?, completed_count=?, ready_count=?, failed_count=0, updated_at=? WHERE id=? AND status IN ('running','ready')")
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
  const row = await env.DB.prepare(
    "SELECT effective_problem_versions.effective_problem_version_id, effective_problem_versions.rejudge_batch_id, rejudge_batches.old_problem_version_id AS staged_problem_version_id FROM effective_problem_versions JOIN rejudge_batches ON rejudge_batches.id=effective_problem_versions.rejudge_batch_id WHERE effective_problem_versions.original_problem_version_id=? AND rejudge_batches.status='effective'",
  ).bind(requestedProblemVersionId).first<{ effective_problem_version_id: string; rejudge_batch_id: string; staged_problem_version_id: string }>();
  return row ? {
    effectiveProblemVersionId: row.effective_problem_version_id,
    rejudgeBatchId: row.rejudge_batch_id,
    stagedProblemVersionId: row.staged_problem_version_id,
  } : { effectiveProblemVersionId: requestedProblemVersionId };
}
