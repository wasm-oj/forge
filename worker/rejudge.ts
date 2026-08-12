import { parseCreateRejudgeRequest, classifyRejudgeChildState } from "../src/online-judge/rejudge";
import { parseStoredProblemTitle } from "../src/online-judge/stored-problem-title";
import { requireMutationSession, requireSession } from "./auth";
import { sha256Hex } from "./crypto";
import { dispatchSubmissionJobs } from "./dispatcher";
import type { AuthenticatedSession, WasmOjWorkerEnv } from "./env";
import { requireStagingFormalAccess } from "./formal-access";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { requireOrganizer } from "./github";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { assertActiveRelease } from "./release";
import { MAX_QUEUED_SUBMISSIONS, MAX_QUEUED_SUBMISSIONS_PER_USER } from "./submission-capacity";
import { prepareSubmissionEventInsert } from "./submission-events";
import { deriveSubmissionAttemptToken } from "./submission-workflow-identity";
import { operationalLog } from "./structured-log";

const MATERIALIZATION_PAGE_SIZE = 20;
const TERMINAL_WORKFLOW_STATES = new Set(["complete", "errored", "terminated", "unknown"]);
const UNKNOWN_WORKFLOW_REPAIR_GRACE_MS = 10 * 60 * 1_000;
const REJUDGEABLE_STATES = "'completed','compile-error','judge-error','infrastructure-error'";

interface ProblemVersionRow {
  readonly id: string;
  readonly problem_series_id: string;
  readonly problem_slug: string;
  readonly problem_number: number;
  readonly title_json: string;
  readonly mode: "official-practice" | "contest";
  readonly execution_semantic_sha256: string;
  readonly organizer_user_id: string;
  readonly publication_status: "published";
  readonly published_at: string;
  readonly github_repository_id: number;
  readonly owner_login: string;
  readonly repository_name: string;
}

interface RejudgeBatchRow {
  readonly id: string;
  readonly old_problem_version_id: string;
  readonly new_problem_version_id: string;
  readonly problem_series_id: string;
  readonly requested_by: string;
  readonly state: "queued" | "running" | "ready" | "effective" | "failed" | "cancelled";
  readonly expected_count: number;
  readonly completed_count: number;
  readonly ready_count: number;
  readonly failed_count: number;
  readonly wasm_oj_release_id: string;
  readonly wasm_oj_manifest_sha256: string;
  readonly failure_code: string | null;
  readonly cancel_requested_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly effective_at: string | null;
}

const REJUDGE_BATCH_SELECT_SQL = `SELECT batches.*,
    COALESCE((SELECT SUM(CASE WHEN jobs.state IN ('ready','failed','cancelled') THEN 1 ELSE 0 END)
      FROM rejudge_jobs AS jobs WHERE jobs.rejudge_batch_id=batches.id), 0) AS completed_count,
    COALESCE((SELECT SUM(CASE WHEN jobs.state='ready' THEN 1 ELSE 0 END)
      FROM rejudge_jobs AS jobs WHERE jobs.rejudge_batch_id=batches.id), 0) AS ready_count,
    COALESCE((SELECT SUM(CASE WHEN jobs.state IN ('failed','cancelled') THEN 1 ELSE 0 END)
      FROM rejudge_jobs AS jobs WHERE jobs.rejudge_batch_id=batches.id), 0) AS failed_count
  FROM rejudge_batches AS batches`;

interface MaterializationCandidate {
  readonly origin_submission_id: string;
  readonly predecessor_submission_id: string;
  readonly user_id: string;
}

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

export function erasureAdjustedExpectedCount(current: number, materialized: number, materializationSettled: boolean): number {
  if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(materialized) || materialized < 0) {
    throw new TypeError("Rejudge expected counts must be non-negative safe integers.");
  }
  return materializationSettled && materialized < current ? materialized : current;
}

export function rejudgeSideEffectPlan(
  noOp: boolean,
  publicationAlreadyAdvanced: boolean,
  mode: ProblemVersionRow["mode"],
): {
  readonly lineageReason: "publication" | "rejudge" | null;
  readonly enqueueMaterialization: boolean;
} {
  return {
    lineageReason: noOp && !publicationAlreadyAdvanced
      ? mode === "contest" ? "rejudge" : "publication"
      : null,
    enqueueMaterialization: !noOp,
  };
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

function uuidFromDigest(digest: string): string {
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function deterministicChildSubmissionId(batchId: string, originSubmissionId: string): Promise<string> {
  return uuidFromDigest(await sha256Hex(`wasm-oj-rejudge-child-v2\0${batchId}\0${originSubmissionId}`));
}

async function deterministicRejudgeJobId(batchId: string, originSubmissionId: string): Promise<string> {
  return uuidFromDigest(await sha256Hex(`wasm-oj-rejudge-job-v2\0${batchId}\0${originSubmissionId}`));
}

async function problemVersion(env: WasmOjWorkerEnv, id: string): Promise<ProblemVersionRow | null> {
  return env.DB.prepare(`SELECT versions.id, versions.problem_series_id, versions.problem_slug,
      versions.problem_number, versions.title_json, versions.mode,
      versions.execution_semantic_sha256, collections.organizer_user_id,
      'published' AS publication_status, publications.published_at,
      repositories.github_repository_id, repositories.owner_login,
      repositories.name AS repository_name
    FROM problem_version_details AS versions
    JOIN catalog_publications AS publications ON publications.id=versions.catalog_publication_id
    JOIN problem_collections AS collections ON collections.id=versions.collection_id
    JOIN github_repositories AS repositories
      ON repositories.github_repository_id=collections.github_repository_id
    WHERE versions.id=?`)
    .bind(id).first<ProblemVersionRow>();
}

function assertVersionAuthorization(
  session: AuthenticatedSession,
  oldVersion: ProblemVersionRow,
  newVersion: ProblemVersionRow,
): void {
  if (!session.roles.includes("admin") && (
    oldVersion.organizer_user_id !== session.userId || newVersion.organizer_user_id !== session.userId
  )) throw new ApiError(404, "rejudge-version-not-found", "Problem versions were not found.");
  if (oldVersion.problem_series_id !== newVersion.problem_series_id || oldVersion.mode !== newVersion.mode) {
    throw new ApiError(409, "rejudge-version-mismatch", "Rejudge versions must belong to the same problem series and mode.");
  }
  if (newVersion.publication_status !== "published") {
    throw new ApiError(409, "rejudge-version-state", "The successor problem version must be published.");
  }
}

async function assertSuccessorActivated(env: WasmOjWorkerEnv, version: ProblemVersionRow): Promise<void> {
  if (version.mode !== "official-practice") return;
  const head = await env.DB.prepare(
    "SELECT 1 AS active FROM official_practice_heads WHERE problem_series_id=? AND problem_version_id=?",
  ).bind(version.problem_series_id, version.id).first<{ readonly active: number }>();
  if (!head) throw new ApiError(409, "rejudge-successor-not-active", "Activate the successor before rejudging the previous version.");
}

async function assertLineageEndpointsAreCurrent(
  env: WasmOjWorkerEnv,
  problemSeriesId: string,
  oldProblemVersionId: string,
  newProblemVersionId: string,
): Promise<void> {
  const conflict = await env.DB.prepare(`SELECT
      EXISTS(SELECT 1 FROM problem_version_lineages WHERE predecessor_problem_version_id=?)
      + EXISTS(SELECT 1 FROM problem_version_lineages WHERE predecessor_problem_version_id=? OR successor_problem_version_id=?)
      + EXISTS(SELECT 1 FROM rejudge_batches WHERE problem_series_id=? AND state IN ('queued','running','ready'))
      AS conflicts`)
    .bind(oldProblemVersionId, newProblemVersionId, newProblemVersionId, problemSeriesId)
    .first<{ readonly conflicts: number }>();
  if ((conflict?.conflicts ?? 0) !== 0) {
    throw new ApiError(409, "rejudge-lineage-conflict", "Rejudge must start at the current lineage head and target an unused successor.");
  }
}

async function hasExactPublicationLineage(
  env: WasmOjWorkerEnv,
  oldProblemVersionId: string,
  newProblemVersionId: string,
): Promise<boolean> {
  return Boolean(await env.DB.prepare(`SELECT 1 AS linked
      FROM problem_version_lineages
     WHERE predecessor_problem_version_id=?
       AND successor_problem_version_id=?
       AND reason='publication' AND rejudge_batch_id IS NULL`)
    .bind(oldProblemVersionId, newProblemVersionId).first<{ readonly linked: number }>());
}

async function assertContestEnded(env: WasmOjWorkerEnv, version: ProblemVersionRow, now: string): Promise<void> {
  if (version.mode !== "contest") return;
  const running = await env.DB.prepare(`SELECT 1 AS running
      FROM effective_submission_results AS effective
      JOIN submissions AS submission ON submission.id=effective.effective_submission_id
      JOIN contests ON contests.id=submission.contest_id
     WHERE effective.effective_problem_version_id=? AND contests.ends_at>?
    UNION ALL
    SELECT 1 AS running
      FROM contest_problems JOIN contests ON contests.id=contest_problems.contest_id
     WHERE contest_problems.problem_version_id=? AND contests.ends_at>?
    LIMIT 1`)
    .bind(version.id, now, version.id, now).first<{ readonly running: number }>();
  if (running) throw new ApiError(409, "contest-rejudge-before-end", "Contest problem versions can be rejudged only after the contest ends.");
}

const ELIGIBLE_ORIGINS_SQL = `FROM effective_submission_results AS effective
  JOIN submissions AS predecessor ON predecessor.id=effective.effective_submission_id
  JOIN submissions AS origin ON origin.id=effective.origin_submission_id
  JOIN submission_sources AS source ON source.id=predecessor.source_id
  JOIN users ON users.id=predecessor.user_id
 WHERE effective.effective_problem_version_id=?
   AND predecessor.problem_series_id=?
   AND predecessor.state IN (${REJUDGEABLE_STATES})
   AND source.state='ready' AND source.owner_user_id=predecessor.user_id
   AND source.admission_erasure_epoch=users.erasure_epoch
   AND users.status='active'
   AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=predecessor.user_id)`;

async function eligibleOriginCount(env: WasmOjWorkerEnv, version: ProblemVersionRow): Promise<number> {
  const count = await env.DB.prepare(`SELECT COUNT(*) AS count ${ELIGIBLE_ORIGINS_SQL}`)
    .bind(version.id, version.problem_series_id).first<{ readonly count: number }>();
  return count?.count ?? 0;
}

async function assertNoUnsettledOrigins(env: WasmOjWorkerEnv, version: ProblemVersionRow): Promise<void> {
  const unsettled = await env.DB.prepare(`SELECT 1 AS unsettled FROM submissions
     WHERE problem_version_id=? AND problem_series_id=?
       AND state IN ('admitting','queued','preparing','compiling','running','finalizing')
     LIMIT 1`)
    .bind(version.id, version.problem_series_id).first<{ readonly unsettled: number }>();
  if (unsettled) throw new ApiError(409, "rejudge-source-busy", "Wait for all submissions on the predecessor version to become terminal.");
}

async function batchForActor(env: WasmOjWorkerEnv, batchId: string, session: AuthenticatedSession): Promise<RejudgeBatchRow> {
  const row = await env.DB.prepare(`${REJUDGE_BATCH_SELECT_SQL} WHERE batches.id=?`)
    .bind(batchId).first<RejudgeBatchRow>();
  if (!row || (!session.roles.includes("admin") && row.requested_by !== session.userId)) {
    throw new ApiError(404, "rejudge-batch-not-found", "Rejudge batch was not found.");
  }
  return row;
}

export async function createRejudgeBatch(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
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
  const existing = await env.DB.prepare(
    "SELECT id, request_digest, state FROM rejudge_batches WHERE requested_by=? AND idempotency_key=?",
  ).bind(session.userId, input.idempotencyKey).first<{
    readonly id: string;
    readonly request_digest: string;
    readonly state: string;
  }>();
  if (existing) {
    if (existing.request_digest !== requestDigest) throw new ApiError(409, "idempotency-conflict", "Idempotency key was used for another rejudge request.");
    return jsonResponse({ rejudgeBatchId: existing.id, status: existing.state, replayed: true });
  }

  const [oldVersion, newVersion] = await Promise.all([
    problemVersion(env, input.oldProblemVersionId),
    problemVersion(env, input.newProblemVersionId),
  ]);
  if (!oldVersion || !newVersion) throw new ApiError(404, "rejudge-version-not-found", "Problem versions were not found.");
  assertVersionAuthorization(session, oldVersion, newVersion);
  await assertSuccessorActivated(env, newVersion);
  const noOp = oldVersion.execution_semantic_sha256 === newVersion.execution_semantic_sha256;
  const publicationAlreadyAdvanced = noOp
    && await hasExactPublicationLineage(env, oldVersion.id, newVersion.id);
  if (!publicationAlreadyAdvanced) {
    await assertLineageEndpointsAreCurrent(env, oldVersion.problem_series_id, oldVersion.id, newVersion.id);
  }
  const now = new Date().toISOString();
  await assertContestEnded(env, oldVersion, now);
  await assertNoUnsettledOrigins(env, oldVersion);
  await requireFormalMutationsEnabled(env, request);
  const active = await assertActiveRelease(
    env.DB,
    env.ENVIRONMENT,
    env.WASM_OJ_RELEASE_ID,
    env.WASM_OJ_RELEASE_MANIFEST_SHA256,
  );
  const batchId = crypto.randomUUID();
  const expectedCount = noOp ? 0 : await eligibleOriginCount(env, oldVersion);
  const initialState = noOp ? "effective" : "queued";
  const sideEffects = rejudgeSideEffectPlan(noOp, publicationAlreadyAdvanced, oldVersion.mode);
  try {
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(`INSERT INTO rejudge_batches
          (id, old_problem_version_id, new_problem_version_id, problem_series_id,
           requested_by, state, expected_count,
           idempotency_key, request_digest, wasm_oj_release_id, wasm_oj_manifest_sha256,
           created_at, updated_at, effective_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          batchId, oldVersion.id, newVersion.id, oldVersion.problem_series_id,
          session.userId, initialState, expectedCount, input.idempotencyKey, requestDigest,
          active.releaseId, active.manifestSha256, now, now, noOp ? now : null,
        ),
    ];
    if (sideEffects.lineageReason !== null) {
      statements.push(env.DB.prepare(`INSERT INTO problem_version_lineages
          (problem_series_id, predecessor_problem_version_id, successor_problem_version_id,
           reason, rejudge_batch_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(
          oldVersion.problem_series_id,
          oldVersion.id,
          newVersion.id,
          sideEffects.lineageReason,
          sideEffects.lineageReason === "rejudge" ? batchId : null,
          now,
        ));
    }
    await env.DB.batch(statements);
  } catch (error) {
    const winner = await env.DB.prepare(
      "SELECT id, request_digest, state FROM rejudge_batches WHERE requested_by=? AND idempotency_key=?",
    ).bind(session.userId, input.idempotencyKey).first<{
      readonly id: string;
      readonly request_digest: string;
      readonly state: string;
    }>();
    if (winner?.request_digest === requestDigest) {
      return jsonResponse({ rejudgeBatchId: winner.id, status: winner.state, replayed: true });
    }
    // The partial unique index is the final race fence. Re-read the canonical
    // lineage state so a concurrent generation reports a stable domain error
    // instead of leaking a storage constraint failure.
    if (!publicationAlreadyAdvanced) {
      await assertLineageEndpointsAreCurrent(
        env,
        oldVersion.problem_series_id,
        oldVersion.id,
        newVersion.id,
      );
    }
    throw error;
  }
  if (sideEffects.enqueueMaterialization) {
    try {
      await materializeRejudgeBatch(env, batchId);
      await dispatchSubmissionJobs(env);
    } catch {
      operationalLog("warn", {
        event: "reconciler.delivery-failed",
        outcome: "deferred",
        code: "rejudge-materialization",
        aggregateType: "submission",
        aggregateId: batchId,
      });
    }
  }
  return jsonResponse({ rejudgeBatchId: batchId, status: initialState, replayed: false, noOp }, noOp ? 200 : 202);
}

function versionOption(row: ProblemVersionRow) {
  return {
    problemVersionId: row.id,
    problemSeriesId: row.problem_series_id,
    slug: row.problem_slug,
    number: row.problem_number,
    title: parseStoredProblemTitle(row.title_json),
    mode: row.mode,
    publicationStatus: row.publication_status,
    publishedAt: row.published_at,
    executionSemanticSha256: row.execution_semantic_sha256,
    repository: {
      id: row.github_repository_id,
      owner: row.owner_login,
      name: row.repository_name,
    },
  };
}

async function versionOptionsForActor(env: WasmOjWorkerEnv, session: AuthenticatedSession): Promise<readonly ProblemVersionRow[]> {
  const admin = session.roles.includes("admin") ? 1 : 0;
  const rows = await env.DB.prepare(`SELECT versions.id, versions.problem_series_id,
      versions.problem_slug, versions.problem_number, versions.title_json, versions.mode,
      versions.execution_semantic_sha256, collections.organizer_user_id,
      'published' AS publication_status, publications.published_at,
      repositories.github_repository_id, repositories.owner_login,
      repositories.name AS repository_name
    FROM problem_version_details AS versions
    JOIN catalog_publications AS publications ON publications.id=versions.catalog_publication_id
    JOIN problem_collections AS collections ON collections.id=versions.collection_id
    JOIN github_repositories AS repositories
      ON repositories.github_repository_id=collections.github_repository_id
    WHERE (?=1 OR collections.organizer_user_id=?)
      AND NOT EXISTS (
        SELECT 1 FROM problem_version_lineages
         WHERE predecessor_problem_version_id=versions.id
      )
    ORDER BY repositories.owner_login, repositories.name, versions.problem_slug,
      publications.published_at DESC`)
    .bind(admin, session.userId).all<ProblemVersionRow>();
  return rows.results;
}

export async function rejudgeOptions(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const sourceId = new URL(request.url).searchParams.get("source");
  const rows = await versionOptionsForActor(env, session);
  if (sourceId === null) return jsonResponse({ sources: rows.map(versionOption) });
  const source = rows.find((row) => row.id === sourceId);
  if (!source) throw new ApiError(404, "rejudge-version-not-found", "Problem version was not found.");
  return jsonResponse({
    sourceProblemVersionId: source.id,
    successors: rows
      .filter((row) => row.id !== source.id && row.problem_series_id === source.problem_series_id && row.mode === source.mode)
      .map(versionOption),
  });
}

function batchProjection(row: RejudgeBatchRow): Record<string, unknown> {
  return {
    id: row.id,
    oldProblemVersionId: row.old_problem_version_id,
    newProblemVersionId: row.new_problem_version_id,
    problemSeriesId: row.problem_series_id,
    status: row.state,
    expectedCount: row.expected_count,
    completedCount: row.completed_count,
    readyCount: row.ready_count,
    failedCount: row.failed_count,
    failureCode: row.failure_code,
    cancelRequestedAt: row.cancel_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    effectiveAt: row.effective_at,
  };
}

export async function listRejudgeBatches(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
  const admin = session.roles.includes("admin") ? 1 : 0;
  const rows = await env.DB.prepare(`${REJUDGE_BATCH_SELECT_SQL}
      WHERE (?=1 OR batches.requested_by=?) ORDER BY batches.created_at DESC LIMIT ?`)
    .bind(admin, session.userId, limit).all<RejudgeBatchRow>();
  return jsonResponse({ rejudgeBatches: rows.results.map(batchProjection) });
}

export async function getRejudgeBatch(
  request: Request,
  env: WasmOjWorkerEnv,
  batchId: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const batch = await batchForActor(env, batchId, session);
  const jobs = await env.DB.prepare(`SELECT id, origin_submission_id, old_submission_id,
      new_submission_id, state, result_state, created_at, updated_at
    FROM rejudge_jobs WHERE rejudge_batch_id=? ORDER BY created_at, origin_submission_id LIMIT 200`)
    .bind(batchId).all<Record<string, unknown>>();
  return jsonResponse({ rejudgeBatch: batchProjection(batch), jobs: jobs.results });
}

async function cancelBatchChildren(env: WasmOjWorkerEnv, batch: RejudgeBatchRow, reason: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE submissions
        SET state='cancelled', verdict='cancelled', score=COALESCE(score, 0),
            fully_passed_cases=COALESCE(fully_passed_cases, 0), updated_at=?,
            completed_at=COALESCE(completed_at, ?)
      WHERE id IN (SELECT new_submission_id FROM rejudge_jobs WHERE rejudge_batch_id=?)
        AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')`)
      .bind(now, now, batch.id),
    env.DB.prepare(`UPDATE submission_attempts
        SET state='cancelled', finished_at=COALESCE(finished_at, ?), failure_code=?
      WHERE submission_id IN (SELECT new_submission_id FROM rejudge_jobs WHERE rejudge_batch_id=?)
        AND state IN ('created','running')`).bind(now, reason, batch.id),
    env.DB.prepare(`UPDATE workflow_outbox SET state='cancelled', settled_at=?, updated_at=?, last_error=?
      WHERE state='pending'
        AND submission_id IN (SELECT new_submission_id FROM rejudge_jobs WHERE rejudge_batch_id=?)`)
      .bind(now, now, reason, batch.id),
    env.DB.prepare(`UPDATE rejudge_jobs
        SET state='cancelled', result_state='cancelled', updated_at=?
      WHERE rejudge_batch_id=? AND state IN ('pending','dispatched')`)
      .bind(now, batch.id),
  ]);
}

export async function cancelRejudgeBatch(
  request: Request,
  env: WasmOjWorkerEnv,
  batchId: string,
): Promise<Response> {
  const session = await requireMutationSession(request, env);
  await requireOrganizer(env, session);
  const batch = await batchForActor(env, batchId, session);
  if (["effective", "failed", "cancelled"].includes(batch.state)) {
    return jsonResponse({ rejudgeBatchId: batch.id, status: batch.state, changed: false });
  }
  await cancelBatchChildren(env, batch, "rejudge-cancelled");
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE rejudge_batches
      SET state='cancelled', cancel_requested_at=?, failure_code='rejudge-cancelled', updated_at=?
    WHERE id=? AND state IN ('queued','running','ready')`)
    .bind(now, now, batch.id).run();
  return jsonResponse({ rejudgeBatchId: batch.id, status: "cancelled", changed: true });
}

export const MATERIALIZE_REJUDGE_SUBMISSION_SQL = `INSERT OR IGNORE INTO submissions
  (id, origin_submission_id, origin_submitted_at, user_id, problem_version_id,
   problem_series_id, execution_semantic_sha256, contest_id, source_id,
   language, target, optimization, entry_path, wasm_oj_release_id, wasm_oj_manifest_sha256,
   state, visibility, admitted_at, created_at, updated_at)
SELECT ?, origin.id, origin.origin_submitted_at, predecessor.user_id, successor.id,
       predecessor.problem_series_id, successor.execution_semantic_sha256,
       predecessor.contest_id, predecessor.source_id, predecessor.language, predecessor.target,
       predecessor.optimization, predecessor.entry_path, batch.wasm_oj_release_id,
       batch.wasm_oj_manifest_sha256, 'admitting', 'private', ?, ?, ?
  FROM rejudge_batches AS batch
  JOIN problem_version_details AS successor ON successor.id=batch.new_problem_version_id
  JOIN submissions AS predecessor ON predecessor.id=?
  JOIN submissions AS origin ON origin.id=? AND origin.origin_submission_id=origin.id
  JOIN submission_sources AS source ON source.id=predecessor.source_id
  JOIN users ON users.id=predecessor.user_id
 WHERE batch.id=? AND batch.state IN ('queued','running')
   AND predecessor.origin_submission_id=origin.id
   AND predecessor.problem_series_id=batch.problem_series_id
   AND predecessor.state IN (${REJUDGEABLE_STATES})
   AND successor.problem_series_id=batch.problem_series_id
   AND successor.mode=CASE WHEN predecessor.contest_id IS NULL THEN 'official-practice' ELSE 'contest' END
   AND source.state='ready' AND source.owner_user_id=predecessor.user_id
   AND source.admission_erasure_epoch=users.erasure_epoch AND users.status='active'
   AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=predecessor.user_id)
   AND (SELECT COUNT(*) FROM submissions
         WHERE state IN ('admitting','queued')) < ${MAX_QUEUED_SUBMISSIONS}
   AND (SELECT COUNT(*) FROM submissions
         WHERE user_id=predecessor.user_id
           AND state IN ('admitting','queued')) < ${MAX_QUEUED_SUBMISSIONS_PER_USER}
   AND EXISTS (
     SELECT 1 FROM effective_submission_results AS effective
      WHERE effective.origin_submission_id=origin.id
        AND effective.effective_submission_id=predecessor.id
        AND effective.effective_problem_version_id=batch.old_problem_version_id
   )`;

export const MATERIALIZE_REJUDGE_ATTEMPT_SQL = `INSERT OR IGNORE INTO submission_attempts
  (submission_id, attempt, token_hash, state)
SELECT id, 1, ?, 'created' FROM submissions WHERE id=? AND state='admitting'`;

export const MATERIALIZE_REJUDGE_JOB_SQL = `INSERT OR IGNORE INTO rejudge_jobs
  (id, rejudge_batch_id, problem_series_id, origin_submission_id, old_submission_id,
   new_submission_id, old_problem_version_id, new_problem_version_id, source_id,
   user_id, state, created_at, updated_at)
SELECT ?, batch.id, batch.problem_series_id, origin.id, predecessor.id, child.id,
       batch.old_problem_version_id, batch.new_problem_version_id, child.source_id,
       child.user_id, 'dispatched', ?, ?
  FROM rejudge_batches AS batch
  JOIN submissions AS child ON child.id=?
  JOIN submissions AS predecessor ON predecessor.id=?
  JOIN submissions AS origin ON origin.id=?
 WHERE batch.id=? AND batch.state IN ('queued','running')
   AND child.origin_submission_id=origin.id
   AND predecessor.origin_submission_id=origin.id
   AND child.source_id=predecessor.source_id AND child.user_id=predecessor.user_id`;

export const CLAIM_REJUDGE_OUTBOX_SQL = `INSERT OR IGNORE INTO workflow_outbox
  (id, state, submission_id, attempts, created_at, updated_at)
SELECT ?, 'pending', child.id, 0, ?, ?
  FROM submissions AS child
  JOIN rejudge_jobs AS job ON job.new_submission_id=child.id
 WHERE child.id=? AND job.rejudge_batch_id=? AND job.state='dispatched'`;

export const QUEUE_REJUDGE_CHILD_SQL = `UPDATE submissions SET state='queued', updated_at=?
 WHERE id=? AND state='admitting'
   AND EXISTS (SELECT 1 FROM rejudge_jobs WHERE new_submission_id=submissions.id AND state='dispatched')
   AND EXISTS (SELECT 1 FROM workflow_outbox WHERE submission_id=submissions.id AND state='pending')`;

async function materializationCandidates(
  env: WasmOjWorkerEnv,
  batch: RejudgeBatchRow,
): Promise<readonly MaterializationCandidate[]> {
  const capacity = await env.DB.prepare(`SELECT
      ${MAX_QUEUED_SUBMISSIONS} - COUNT(*) AS available
    FROM submissions
    WHERE state IN ('admitting','queued')`)
    .first<{ readonly available: number }>();
  const available = Math.max(0, Math.min(MATERIALIZATION_PAGE_SIZE, capacity?.available ?? 0));
  if (available === 0) return [];
  const candidates = await env.DB.prepare(`SELECT effective.origin_submission_id,
      effective.effective_submission_id AS predecessor_submission_id,
      predecessor.user_id
    ${ELIGIBLE_ORIGINS_SQL}
      AND NOT EXISTS (
        SELECT 1 FROM rejudge_jobs
         WHERE rejudge_batch_id=? AND origin_submission_id=effective.origin_submission_id
      )
    ORDER BY origin.origin_submitted_at, origin.id LIMIT 100`)
    .bind(batch.old_problem_version_id, batch.problem_series_id, batch.id)
    .all<MaterializationCandidate>();
  const queuedRows = await env.DB.prepare(`SELECT user_id, COUNT(*) AS count FROM submissions
      WHERE state IN ('admitting','queued') GROUP BY user_id`)
    .all<{ readonly user_id: string; readonly count: number }>();
  const queued = new Map(queuedRows.results.map((row) => [row.user_id, row.count]));
  const selected: MaterializationCandidate[] = [];
  for (const candidate of candidates.results) {
    const userQueued = queued.get(candidate.user_id) ?? 0;
    if (userQueued >= MAX_QUEUED_SUBMISSIONS_PER_USER) continue;
    selected.push(candidate);
    queued.set(candidate.user_id, userQueued + 1);
    if (selected.length >= available) break;
  }
  return selected;
}

async function materializeCandidate(
  env: WasmOjWorkerEnv,
  batch: RejudgeBatchRow,
  candidate: MaterializationCandidate,
): Promise<boolean> {
  const childId = await deterministicChildSubmissionId(batch.id, candidate.origin_submission_id);
  const jobId = await deterministicRejudgeJobId(batch.id, candidate.origin_submission_id);
  const now = new Date().toISOString();
  const token = await deriveSubmissionAttemptToken(env.ACCOUNT_ERASURE_HMAC_SECRET, childId, 1);
  await env.DB.batch([
    env.DB.prepare(MATERIALIZE_REJUDGE_SUBMISSION_SQL).bind(
      childId, now, now, now,
      candidate.predecessor_submission_id, candidate.origin_submission_id, batch.id,
    ),
    env.DB.prepare(MATERIALIZE_REJUDGE_ATTEMPT_SQL)
      .bind(await sha256Hex(token), childId),
    env.DB.prepare(MATERIALIZE_REJUDGE_JOB_SQL).bind(
      jobId, now, now, childId, candidate.predecessor_submission_id,
      candidate.origin_submission_id, batch.id,
    ),
    env.DB.prepare(CLAIM_REJUDGE_OUTBOX_SQL)
      .bind(crypto.randomUUID(), now, now, childId, batch.id),
    env.DB.prepare(QUEUE_REJUDGE_CHILD_SQL).bind(now, childId),
  ]);
  const exact = await env.DB.prepare(`SELECT 1 AS materialized FROM rejudge_jobs
      JOIN submissions ON submissions.id=rejudge_jobs.new_submission_id
      WHERE rejudge_jobs.id=? AND rejudge_jobs.rejudge_batch_id=?
        AND rejudge_jobs.origin_submission_id=? AND submissions.source_id=rejudge_jobs.source_id
        AND submissions.state IN ('queued','preparing','compiling','running','finalizing','completed','compile-error','judge-error','infrastructure-error','cancelled')`)
    .bind(jobId, batch.id, candidate.origin_submission_id).first<{ readonly materialized: number }>();
  return exact !== null;
}

export async function materializeRejudgeBatch(env: WasmOjWorkerEnv, batchId: string): Promise<boolean> {
  let batch = await env.DB.prepare(`${REJUDGE_BATCH_SELECT_SQL} WHERE batches.id=?`)
    .bind(batchId).first<RejudgeBatchRow>();
  if (!batch) return false;
  if (!["queued", "running"].includes(batch.state)) return true;
  if (batch.state === "queued") {
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE rejudge_batches SET state='running', updated_at=? WHERE id=? AND state='queued'")
      .bind(now, batch.id).run();
    batch = { ...batch, state: "running", updated_at: now };
  }
  const candidates = await materializationCandidates(env, batch);
  for (const candidate of candidates) await materializeCandidate(env, batch, candidate);
  return true;
}

export async function materializePendingRejudgeBatches(env: WasmOjWorkerEnv): Promise<number> {
  const rows = await env.DB.prepare(`SELECT id FROM rejudge_batches
    WHERE state IN ('queued','running') ORDER BY created_at, id LIMIT 20`)
    .all<{ readonly id: string }>();
  let materialized = 0;
  for (const row of rows.results) {
    if (await materializeRejudgeBatch(env, row.id)) materialized += 1;
  }
  return materialized;
}

export async function settleTerminalRejudgeJobs(env: WasmOjWorkerEnv): Promise<number> {
  const rows = await env.DB.prepare(`SELECT jobs.id, jobs.rejudge_batch_id,
      jobs.origin_submission_id, jobs.new_submission_id, child.state
    FROM rejudge_jobs AS jobs
    JOIN submissions AS child ON child.id=jobs.new_submission_id
    WHERE jobs.state='dispatched'
      AND child.state IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')
    ORDER BY jobs.created_at LIMIT 50`)
    .all<{
      readonly id: string;
      readonly rejudge_batch_id: string;
      readonly origin_submission_id: string;
      readonly new_submission_id: string;
      readonly state: "completed" | "compile-error" | "judge-error" | "infrastructure-error" | "cancelled";
    }>();
  let settled = 0;
  for (const row of rows.results) {
    const disposition = classifyRejudgeChildState(row.state);
    const now = new Date().toISOString();
    const claim = await env.DB.prepare(`UPDATE rejudge_jobs SET state=?, result_state=?, updated_at=?
      WHERE id=? AND state='dispatched'`)
      .bind(disposition, row.state, now, row.id).run();
    if (claim.meta.changes === 1) settled += 1;
  }
  return settled;
}

export async function repairDispatchedRejudgeJobs(env: WasmOjWorkerEnv): Promise<number> {
  const rows = await env.DB.prepare(`SELECT jobs.id, jobs.new_submission_id,
      child.updated_at, child.state
    FROM rejudge_jobs AS jobs
    JOIN submissions AS child ON child.id=jobs.new_submission_id
    WHERE jobs.state='dispatched'
      AND child.state IN ('preparing','compiling','running','finalizing')
    ORDER BY jobs.updated_at LIMIT 20`)
    .all<{
      readonly id: string;
      readonly new_submission_id: string;
      readonly updated_at: string;
      readonly state: string;
    }>();
  let repaired = 0;
  const now = new Date();
  for (const row of rows.results) {
    const workflow = await env.SUBMISSION_WORKFLOW.get(row.new_submission_id);
    const status = await workflow.status();
    if (!rejudgeWorkflowNeedsInfrastructureRepair({
      status: status.status,
      submissionUpdatedAt: row.updated_at,
      now,
    })) continue;
    const timestamp = now.toISOString();
    const [submission] = await env.DB.batch([
      env.DB.prepare(`UPDATE submissions
          SET state='infrastructure-error', verdict='judge-error', score=0,
              fully_passed_cases=0, updated_at=?, completed_at=?
        WHERE id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')`)
        .bind(timestamp, timestamp, row.new_submission_id),
      env.DB.prepare(`UPDATE submission_attempts
          SET state='failed', finished_at=?, failure_code='workflow-terminal-without-result'
        WHERE submission_id=? AND state IN ('created','running')`)
        .bind(timestamp, row.new_submission_id),
      env.DB.prepare(`UPDATE rejudge_jobs
          SET state='failed', result_state='infrastructure-error', updated_at=?
        WHERE id=? AND state='dispatched'`).bind(timestamp, row.id),
      prepareSubmissionEventInsert(env.DB, {
        submissionId: row.new_submission_id,
        eventKey: "rejudge-workflow-terminal-without-result",
        event: { kind: "state", state: "infrastructure-error" },
        timestamp,
        requiredState: "infrastructure-error",
      }),
    ]);
    if (submission?.meta.changes === 1) repaired += 1;
  }
  return repaired;
}

async function remainingEligibleOrigins(env: WasmOjWorkerEnv, batch: RejudgeBatchRow): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count ${ELIGIBLE_ORIGINS_SQL}
      AND NOT EXISTS (
        SELECT 1 FROM rejudge_jobs
         WHERE rejudge_batch_id=? AND origin_submission_id=effective.origin_submission_id
      )`)
    .bind(batch.old_problem_version_id, batch.problem_series_id, batch.id)
    .first<{ readonly count: number }>();
  return row?.count ?? 0;
}

export async function activateReadyBatch(env: WasmOjWorkerEnv, batch: RejudgeBatchRow): Promise<boolean> {
  if (await remainingEligibleOrigins(env, batch) !== 0) return false;
  const now = new Date().toISOString();
  const [activated] = await env.DB.batch([
    env.DB.prepare(`UPDATE rejudge_batches
        SET state='effective', effective_at=?, updated_at=?
      WHERE id=? AND state='ready'
        AND (SELECT COUNT(*) FROM rejudge_jobs WHERE rejudge_batch_id=rejudge_batches.id)=expected_count
        AND (SELECT COUNT(*) FROM rejudge_jobs
              WHERE rejudge_batch_id=rejudge_batches.id AND state='ready')=expected_count
        AND NOT EXISTS (
          SELECT 1 ${ELIGIBLE_ORIGINS_SQL}
            AND NOT EXISTS (
              SELECT 1 FROM rejudge_jobs
               WHERE rejudge_batch_id=rejudge_batches.id
                 AND origin_submission_id=effective.origin_submission_id
            )
        )`)
      .bind(now, now, batch.id, batch.old_problem_version_id, batch.problem_series_id),
    env.DB.prepare(`INSERT INTO problem_version_lineages
        (problem_series_id, predecessor_problem_version_id, successor_problem_version_id,
         reason, rejudge_batch_id, created_at)
      SELECT problem_series_id, old_problem_version_id, new_problem_version_id,
             'rejudge', id, ? FROM rejudge_batches
       WHERE id=? AND state='effective' AND effective_at=?`)
      .bind(now, batch.id, now),
  ]);
  return activated?.meta.changes === 1;
}

async function failBatch(env: WasmOjWorkerEnv, batch: RejudgeBatchRow, failureCode: string): Promise<boolean> {
  await cancelBatchChildren(env, batch, failureCode);
  const now = new Date().toISOString();
  const updated = await env.DB.prepare(`UPDATE rejudge_batches
      SET state='failed', failure_code=?, updated_at=?
    WHERE id=? AND state IN ('queued','running','ready')`)
    .bind(failureCode, now, batch.id).run();
  return updated.meta.changes === 1;
}

export async function refreshRejudgeBatches(env: WasmOjWorkerEnv): Promise<number> {
  const batches = await env.DB.prepare(`${REJUDGE_BATCH_SELECT_SQL}
      WHERE batches.state IN ('queued','running','ready') ORDER BY batches.created_at LIMIT 20`)
    .all<RejudgeBatchRow>();
  let changed = 0;
  for (let batch of batches.results) {
    if (batch.cancel_requested_at) {
      if (await failBatch(env, batch, batch.failure_code ?? "rejudge-cancelled")) changed += 1;
      continue;
    }
    const aggregate = await env.DB.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN state='ready' THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN state IN ('failed','cancelled') THEN 1 ELSE 0 END) AS failed
      FROM rejudge_jobs WHERE rejudge_batch_id=?`)
      .bind(batch.id).first<{ readonly total: number; readonly ready: number | null; readonly failed: number | null }>();
    const total = aggregate?.total ?? 0;
    const ready = aggregate?.ready ?? 0;
    const failed = aggregate?.failed ?? 0;
    if (failed > 0) {
      if (await failBatch(env, batch, "rejudge-child-failed")) changed += 1;
      continue;
    }
    const remaining = await remainingEligibleOrigins(env, batch);
    const expected = erasureAdjustedExpectedCount(batch.expected_count, total, remaining === 0);
    if (expected !== batch.expected_count) {
      await env.DB.prepare(`UPDATE rejudge_batches SET expected_count=?, updated_at=?
        WHERE id=? AND state='running' AND expected_count=?`)
        .bind(expected, new Date().toISOString(), batch.id, batch.expected_count).run();
      batch = { ...batch, expected_count: expected };
    }
    const complete = total === batch.expected_count && ready === batch.expected_count;
    const nextState = complete ? "ready" : "running";
    await env.DB.prepare(`UPDATE rejudge_batches
        SET state=?, updated_at=?
      WHERE id=? AND state IN ('running','ready')`)
      .bind(nextState, new Date().toISOString(), batch.id).run();
    if (complete && await activateReadyBatch(env, {
      ...batch,
      state: "ready",
    })) changed += 1;
  }
  return changed;
}
