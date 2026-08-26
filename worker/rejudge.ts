import { classifyRejudgeChildState, parseCreateRejudgeRequest } from "../src/online-judge/rejudge";
import { parseStoredProblemTitle } from "../src/online-judge/stored-problem-title";
import { requireBrowserOrBearerMutationSession, requireSession } from "./auth";
import { sha256Hex } from "./crypto";
import { dispatchSubmissionJobs } from "./dispatcher";
import type { AuthenticatedSession, WasmOjWorkerEnv } from "./env";
import { requireStagingFormalAccess } from "./formal-access";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { requireOrganizer } from "./github";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { MAX_QUEUED_SUBMISSIONS, MAX_QUEUED_SUBMISSIONS_PER_USER } from "./submission-capacity";
import { prepareSubmissionEventInsert } from "./submission-events";
import { deriveSubmissionAttemptToken } from "./submission-workflow-identity";
import { operationalLog } from "./structured-log";
import { workflowStatusOrUnknown } from "./workflow-instance-status";

const MATERIALIZATION_PAGE_SIZE = 20;
const TERMINAL_WORKFLOW_STATES = new Set(["complete", "errored", "terminated", "unknown"]);
const UNKNOWN_WORKFLOW_REPAIR_GRACE_MS = 10 * 60 * 1_000;
const REJUDGEABLE_STATES = "'completed','compile-error','judge-error','infrastructure-error'";

interface ProblemRevisionRow {
  readonly problem_id: string;
  readonly commit_sha: string;
  readonly judge_digest: string;
  readonly ordinal: number;
  readonly title_json: string;
  readonly problem_slug: string;
  readonly catalog_id: string;
  readonly active_commit_sha: string | null;
  readonly organizer_user_id: string;
  readonly github_repository_id: number;
  readonly owner_login: string;
  readonly repository_name: string;
}

export interface RejudgeBatchRow {
  readonly id: string;
  readonly problem_id: string;
  readonly from_commit: string;
  readonly to_commit: string;
  readonly contest_id: string | null;
  readonly requested_by: string;
  readonly state: "queued" | "running" | "ready" | "effective" | "failed" | "cancelled";
  readonly expected_count: number;
  readonly completed_count: number;
  readonly ready_count: number;
  readonly failed_count: number;
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

const ELIGIBLE_ORIGINS_SQL = `FROM effective_submission_results AS effective
  JOIN submissions AS origin ON origin.id=effective.origin_submission_id
  JOIN submissions AS predecessor ON predecessor.id=effective.effective_submission_id
  JOIN submission_sources AS source ON source.id=predecessor.source_id
  JOIN users ON users.id=predecessor.user_id
 WHERE effective.problem_id=? AND effective.judged_commit=?
   AND origin.contest_id IS ?
   AND predecessor.state IN (${REJUDGEABLE_STATES})
   AND source.state='ready' AND source.owner_user_id=predecessor.user_id
   AND source.admission_erasure_epoch=users.erasure_epoch AND users.status='active'
   AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=predecessor.user_id)`;

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
  return uuidFromDigest(await sha256Hex(`wasm-oj-rejudge-child-v3\0${batchId}\0${originSubmissionId}`));
}

async function deterministicRejudgeJobId(batchId: string, originSubmissionId: string): Promise<string> {
  return uuidFromDigest(await sha256Hex(`wasm-oj-rejudge-job-v3\0${batchId}\0${originSubmissionId}`));
}

async function problemRevision(env: WasmOjWorkerEnv, problemId: string, commit: string): Promise<ProblemRevisionRow | null> {
  return env.DB.prepare(`SELECT revisions.problem_id, revisions.commit_sha, revisions.judge_digest,
      revisions.ordinal, revisions.title_json, problems.slug AS problem_slug,
      catalogs.id AS catalog_id, catalogs.active_commit_sha, catalogs.organizer_user_id,
      repositories.github_repository_id, repositories.owner_login,
      repositories.name AS repository_name
    FROM problem_revisions AS revisions
    JOIN problem_series AS problems ON problems.id=revisions.problem_id
    JOIN catalogs ON catalogs.id=problems.catalog_id
    JOIN github_repositories AS repositories
      ON repositories.github_repository_id=catalogs.github_repository_id
    WHERE revisions.problem_id=? AND revisions.commit_sha=?`)
    .bind(problemId, commit).first<ProblemRevisionRow>();
}

function assertRevisionAuthorization(
  session: AuthenticatedSession,
  fromRevision: ProblemRevisionRow,
  toRevision: ProblemRevisionRow,
): void {
  if (!session.roles.includes("admin") && fromRevision.organizer_user_id !== session.userId) {
    throw new ApiError(404, "rejudge-revision-not-found", "Problem revisions were not found.");
  }
  if (fromRevision.problem_id !== toRevision.problem_id || fromRevision.catalog_id !== toRevision.catalog_id) {
    throw new ApiError(409, "rejudge-revision-mismatch", "Rejudge commits must identify the same problem.");
  }
  if (toRevision.active_commit_sha !== toRevision.commit_sha) {
    throw new ApiError(409, "rejudge-target-not-active", "The target commit must be the catalog's active commit.");
  }
}

async function assertContestScope(
  env: WasmOjWorkerEnv,
  revision: ProblemRevisionRow,
  contestId: string | undefined,
  now: string,
): Promise<void> {
  if (!contestId) return;
  const contest = await env.DB.prepare(`SELECT revisions.ends_at
    FROM contest_series AS contests
    JOIN contest_revisions AS revisions
      ON revisions.contest_id=contests.id AND revisions.commit_sha=?
    JOIN contest_revision_problems AS problems
      ON problems.contest_id=contests.id AND problems.commit_sha=revisions.commit_sha
     AND problems.problem_id=?
    WHERE contests.id=? AND contests.catalog_id=?`)
    .bind(revision.commit_sha, revision.problem_id, contestId, revision.catalog_id)
    .first<{ readonly ends_at: string }>();
  if (!contest) throw new ApiError(409, "rejudge-contest-mismatch", "Contest does not contain the target problem revision.");
  if (contest.ends_at > now) throw new ApiError(409, "rejudge-contest-running", "A contest cannot be rejudged before it ends.");
}

async function assertNoUnsettledOrigins(
  env: WasmOjWorkerEnv,
  problemId: string,
  fromCommit: string,
  contestId: string | undefined,
): Promise<void> {
  const unsettled = await env.DB.prepare(`SELECT 1 AS unsettled FROM submissions
     WHERE problem_id=? AND catalog_commit=? AND contest_id IS ?
       AND state IN ('admitting','queued','preparing','compiling','running','finalizing')
     LIMIT 1`)
    .bind(problemId, fromCommit, contestId ?? null).first<{ readonly unsettled: number }>();
  if (unsettled) throw new ApiError(409, "rejudge-source-busy", "Wait for source-commit submissions to become terminal.");
}

async function eligibleOriginCount(
  env: WasmOjWorkerEnv,
  problemId: string,
  fromCommit: string,
  contestId: string | undefined,
): Promise<number> {
  const count = await env.DB.prepare(`SELECT COUNT(*) AS count ${ELIGIBLE_ORIGINS_SQL}`)
    .bind(problemId, fromCommit, contestId ?? null).first<{ readonly count: number }>();
  return count?.count ?? 0;
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
  const session = await requireBrowserOrBearerMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  let input;
  try { input = parseCreateRejudgeRequest(await readJsonBody(request, 16 * 1024)); }
  catch (error) {
    if (error instanceof TypeError) throw new ApiError(400, "rejudge-request-invalid", error.message);
    throw error;
  }
  const requestDigest = await sha256Hex(canonicalBytes(input));
  const existing = await env.DB.prepare(
    "SELECT id, request_digest, state FROM rejudge_batches WHERE requested_by=? AND idempotency_key=?",
  ).bind(session.userId, input.idempotencyKey).first<{ readonly id: string; readonly request_digest: string; readonly state: string }>();
  if (existing) {
    if (existing.request_digest !== requestDigest) throw new ApiError(409, "idempotency-conflict", "Idempotency key was used for another rejudge request.");
    return jsonResponse({ rejudgeBatchId: existing.id, status: existing.state, replayed: true });
  }
  const [fromRevision, toRevision] = await Promise.all([
    problemRevision(env, input.problemId, input.fromCommit),
    problemRevision(env, input.problemId, input.toCommit),
  ]);
  if (!fromRevision || !toRevision) throw new ApiError(404, "rejudge-revision-not-found", "Problem revisions were not found.");
  assertRevisionAuthorization(session, fromRevision, toRevision);
  const now = new Date().toISOString();
  await assertContestScope(env, fromRevision, input.contestId, now);
  await assertNoUnsettledOrigins(env, input.problemId, input.fromCommit, input.contestId);
  await requireFormalMutationsEnabled(env, request);
  const noOp = fromRevision.judge_digest === toRevision.judge_digest;
  const batchId = crypto.randomUUID();
  const expectedCount = noOp ? 0 : await eligibleOriginCount(env, input.problemId, input.fromCommit, input.contestId);
  const state = noOp ? "effective" : "queued";
  try {
    await env.DB.prepare(`INSERT INTO rejudge_batches
        (id, problem_id, from_commit, to_commit, contest_id, requested_by, state,
         expected_count, idempotency_key, request_digest, created_at, updated_at, effective_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        batchId, input.problemId, input.fromCommit, input.toCommit, input.contestId ?? null,
        session.userId, state, expectedCount, input.idempotencyKey, requestDigest,
        now, now, noOp ? now : null,
      ).run();
  } catch (error) {
    const winner = await env.DB.prepare(
      "SELECT id, request_digest, state FROM rejudge_batches WHERE requested_by=? AND idempotency_key=?",
    ).bind(session.userId, input.idempotencyKey).first<{ readonly id: string; readonly request_digest: string; readonly state: string }>();
    if (winner?.request_digest === requestDigest) return jsonResponse({ rejudgeBatchId: winner.id, status: winner.state, replayed: true });
    throw error;
  }
  if (!noOp) {
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
  return jsonResponse({ rejudgeBatchId: batchId, status: state, replayed: false, noOp }, noOp ? 200 : 202);
}

function revisionOption(row: ProblemRevisionRow) {
  return {
    problemId: row.problem_id,
    catalogCommit: row.commit_sha,
    active: row.active_commit_sha === row.commit_sha,
    judgeDigest: row.judge_digest,
    slug: row.problem_slug,
    order: row.ordinal,
    title: parseStoredProblemTitle(row.title_json),
    repository: { id: row.github_repository_id, owner: row.owner_login, name: row.repository_name },
  };
}

async function revisionOptionsForActor(env: WasmOjWorkerEnv, session: AuthenticatedSession): Promise<readonly ProblemRevisionRow[]> {
  const admin = session.roles.includes("admin") ? 1 : 0;
  const rows = await env.DB.prepare(`SELECT revisions.problem_id, revisions.commit_sha,
      revisions.judge_digest, revisions.ordinal, revisions.title_json,
      problems.slug AS problem_slug, catalogs.id AS catalog_id,
      catalogs.active_commit_sha, catalogs.organizer_user_id,
      repositories.github_repository_id, repositories.owner_login,
      repositories.name AS repository_name
    FROM problem_revisions AS revisions
    JOIN problem_series AS problems ON problems.id=revisions.problem_id
    JOIN catalogs ON catalogs.id=problems.catalog_id
    JOIN github_repositories AS repositories
      ON repositories.github_repository_id=catalogs.github_repository_id
    WHERE (?=1 OR catalogs.organizer_user_id=?)
    ORDER BY repositories.owner_login, repositories.name, problems.slug, revisions.created_at DESC`)
    .bind(admin, session.userId).all<ProblemRevisionRow>();
  return rows.results;
}

export async function rejudgeOptions(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const rows = await revisionOptionsForActor(env, session);
  const url = new URL(request.url);
  const problemId = url.searchParams.get("problemId");
  const fromCommit = url.searchParams.get("fromCommit");
  if (!problemId && !fromCommit) return jsonResponse({ revisions: rows.map(revisionOption) });
  if (!problemId || !fromCommit) throw new ApiError(400, "rejudge-source-invalid", "problemId and fromCommit are required together.");
  const source = rows.find((row) => row.problem_id === problemId && row.commit_sha === fromCommit);
  if (!source) throw new ApiError(404, "rejudge-revision-not-found", "Problem revision was not found.");
  return jsonResponse({
    source: revisionOption(source),
    targets: rows.filter((row) => row.problem_id === problemId && row.commit_sha !== fromCommit).map(revisionOption),
  });
}

function batchProjection(row: RejudgeBatchRow): Record<string, unknown> {
  return {
    id: row.id,
    problemId: row.problem_id,
    fromCommit: row.from_commit,
    toCommit: row.to_commit,
    contestId: row.contest_id,
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

export async function getRejudgeBatch(request: Request, env: WasmOjWorkerEnv, batchId: string): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const batch = await batchForActor(env, batchId, session);
  const jobs = await env.DB.prepare(`SELECT id, origin_submission_id, old_submission_id,
      new_submission_id, from_commit, to_commit, state, result_state, created_at, updated_at
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
      WHERE state='pending' AND submission_id IN (
        SELECT new_submission_id FROM rejudge_jobs WHERE rejudge_batch_id=?
      )`).bind(now, now, reason, batch.id),
    env.DB.prepare(`UPDATE rejudge_jobs
        SET state='cancelled', result_state='cancelled', updated_at=?
      WHERE rejudge_batch_id=? AND state IN ('pending','dispatched')`).bind(now, batch.id),
  ]);
}

export async function cancelRejudgeBatch(request: Request, env: WasmOjWorkerEnv, batchId: string): Promise<Response> {
  const session = await requireBrowserOrBearerMutationSession(request, env);
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
  (id, origin_submission_id, origin_submitted_at, user_id, problem_id,
   catalog_commit, judge_digest, contest_id, source_id, language, target,
   optimization, entry_path, state, visibility, admitted_at, created_at, updated_at)
SELECT ?, origin.id, origin.origin_submitted_at, predecessor.user_id, batch.problem_id,
       batch.to_commit, target.judge_digest, predecessor.contest_id, predecessor.source_id,
       predecessor.language, predecessor.target, predecessor.optimization,
       predecessor.entry_path, 'admitting', 'private', ?, ?, ?
  FROM rejudge_batches AS batch
  JOIN problem_revisions AS target
    ON target.problem_id=batch.problem_id AND target.commit_sha=batch.to_commit
  JOIN submissions AS predecessor ON predecessor.id=?
  JOIN submissions AS origin ON origin.id=? AND origin.origin_submission_id=origin.id
  JOIN submission_sources AS source ON source.id=predecessor.source_id
  JOIN users ON users.id=predecessor.user_id
 WHERE batch.id=? AND batch.state IN ('queued','running')
   AND predecessor.origin_submission_id=origin.id
   AND predecessor.problem_id=batch.problem_id
   AND predecessor.catalog_commit=batch.from_commit
   AND predecessor.state IN (${REJUDGEABLE_STATES})
   AND origin.contest_id IS batch.contest_id
   AND source.state='ready' AND source.owner_user_id=predecessor.user_id
   AND source.admission_erasure_epoch=users.erasure_epoch AND users.status='active'
   AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=predecessor.user_id)
   AND (SELECT COUNT(*) FROM submissions WHERE state IN ('admitting','queued')) < ${MAX_QUEUED_SUBMISSIONS}
   AND (SELECT COUNT(*) FROM submissions WHERE user_id=predecessor.user_id
         AND state IN ('admitting','queued')) < ${MAX_QUEUED_SUBMISSIONS_PER_USER}
   AND EXISTS (
     SELECT 1 FROM effective_submission_results AS effective
      WHERE effective.origin_submission_id=origin.id
        AND effective.effective_submission_id=predecessor.id
        AND effective.problem_id=batch.problem_id
        AND effective.judged_commit=batch.from_commit
   )`;

export const MATERIALIZE_REJUDGE_ATTEMPT_SQL = `INSERT OR IGNORE INTO submission_attempts
  (submission_id, attempt, token_hash, state)
SELECT id, 1, ?, 'created' FROM submissions WHERE id=? AND state='admitting'`;

export const MATERIALIZE_REJUDGE_JOB_SQL = `INSERT OR IGNORE INTO rejudge_jobs
  (id, rejudge_batch_id, problem_id, origin_submission_id, old_submission_id,
   new_submission_id, from_commit, to_commit, source_id, user_id, state, created_at, updated_at)
SELECT ?, batch.id, batch.problem_id, origin.id, predecessor.id, child.id,
       batch.from_commit, batch.to_commit, child.source_id, child.user_id,
       'dispatched', ?, ?
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

async function materializationCandidates(env: WasmOjWorkerEnv, batch: RejudgeBatchRow): Promise<readonly MaterializationCandidate[]> {
  const capacity = await env.DB.prepare(`SELECT ${MAX_QUEUED_SUBMISSIONS} - COUNT(*) AS available
    FROM submissions WHERE state IN ('admitting','queued')`).first<{ readonly available: number }>();
  const available = Math.max(0, Math.min(MATERIALIZATION_PAGE_SIZE, capacity?.available ?? 0));
  if (available === 0) return [];
  const candidates = await env.DB.prepare(`SELECT effective.origin_submission_id,
      effective.effective_submission_id AS predecessor_submission_id, predecessor.user_id
    ${ELIGIBLE_ORIGINS_SQL}
      AND NOT EXISTS (SELECT 1 FROM rejudge_jobs
        WHERE rejudge_batch_id=? AND origin_submission_id=effective.origin_submission_id)
    ORDER BY origin.origin_submitted_at, origin.id LIMIT 100`)
    .bind(batch.problem_id, batch.from_commit, batch.contest_id, batch.id)
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
      childId, now, now, now, candidate.predecessor_submission_id, candidate.origin_submission_id, batch.id,
    ),
    env.DB.prepare(MATERIALIZE_REJUDGE_ATTEMPT_SQL).bind(await sha256Hex(token), childId),
    env.DB.prepare(MATERIALIZE_REJUDGE_JOB_SQL).bind(
      jobId, now, now, childId, candidate.predecessor_submission_id,
      candidate.origin_submission_id, batch.id,
    ),
    env.DB.prepare(CLAIM_REJUDGE_OUTBOX_SQL).bind(crypto.randomUUID(), now, now, childId, batch.id),
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
  for (const candidate of await materializationCandidates(env, batch)) await materializeCandidate(env, batch, candidate);
  return true;
}

export async function materializePendingRejudgeBatches(env: WasmOjWorkerEnv): Promise<number> {
  const rows = await env.DB.prepare(`SELECT id FROM rejudge_batches
    WHERE state IN ('queued','running') ORDER BY created_at, id LIMIT 20`).all<{ readonly id: string }>();
  let materialized = 0;
  for (const row of rows.results) if (await materializeRejudgeBatch(env, row.id)) materialized += 1;
  return materialized;
}

export async function settleTerminalRejudgeJobs(env: WasmOjWorkerEnv): Promise<number> {
  const rows = await env.DB.prepare(`SELECT jobs.id, jobs.new_submission_id, child.state
    FROM rejudge_jobs AS jobs JOIN submissions AS child ON child.id=jobs.new_submission_id
    WHERE jobs.state='dispatched'
      AND child.state IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')
    ORDER BY jobs.created_at LIMIT 50`).all<{
      readonly id: string;
      readonly new_submission_id: string;
      readonly state: "completed" | "compile-error" | "judge-error" | "infrastructure-error" | "cancelled";
    }>();
  let settled = 0;
  for (const row of rows.results) {
    const result = await env.DB.prepare(`UPDATE rejudge_jobs SET state=?, result_state=?, updated_at=?
      WHERE id=? AND state='dispatched'`)
      .bind(classifyRejudgeChildState(row.state), row.state, new Date().toISOString(), row.id).run();
    if (result.meta.changes === 1) settled += 1;
  }
  return settled;
}

export async function repairDispatchedRejudgeJobs(env: WasmOjWorkerEnv): Promise<number> {
  const rows = await env.DB.prepare(`SELECT jobs.id, jobs.new_submission_id, child.updated_at
    FROM rejudge_jobs AS jobs JOIN submissions AS child ON child.id=jobs.new_submission_id
    WHERE jobs.state='dispatched' AND child.state IN ('preparing','compiling','running','finalizing')
    ORDER BY jobs.updated_at LIMIT 20`).all<{
      readonly id: string;
      readonly new_submission_id: string;
      readonly updated_at: string;
    }>();
  let repaired = 0;
  const now = new Date();
  for (const row of rows.results) {
    const status = await workflowStatusOrUnknown(env.SUBMISSION_WORKFLOW, row.new_submission_id);
    if (!rejudgeWorkflowNeedsInfrastructureRepair({ status: status.status, submissionUpdatedAt: row.updated_at, now })) continue;
    const timestamp = now.toISOString();
    const [submission] = await env.DB.batch([
      env.DB.prepare(`UPDATE submissions SET state='infrastructure-error', verdict='judge-error',
          score=0, fully_passed_cases=0, updated_at=?, completed_at=?
        WHERE id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')`)
        .bind(timestamp, timestamp, row.new_submission_id),
      env.DB.prepare(`UPDATE submission_attempts SET state='failed', finished_at=?,
          failure_code='workflow-terminal-without-result'
        WHERE submission_id=? AND state IN ('created','running')`).bind(timestamp, row.new_submission_id),
      env.DB.prepare(`UPDATE rejudge_jobs SET state='failed', result_state='infrastructure-error', updated_at=?
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
      AND NOT EXISTS (SELECT 1 FROM rejudge_jobs
        WHERE rejudge_batch_id=? AND origin_submission_id=effective.origin_submission_id)`)
    .bind(batch.problem_id, batch.from_commit, batch.contest_id, batch.id).first<{ readonly count: number }>();
  return row?.count ?? 0;
}

export async function makeReadyBatchEffective(env: WasmOjWorkerEnv, batch: RejudgeBatchRow): Promise<boolean> {
  if (await remainingEligibleOrigins(env, batch) !== 0) return false;
  const now = new Date().toISOString();
  const [madeEffective] = await env.DB.batch([
    env.DB.prepare(`UPDATE rejudge_batches SET state='effective', effective_at=?, updated_at=?
      WHERE id=? AND state='ready'
        AND (SELECT COUNT(*) FROM rejudge_jobs WHERE rejudge_batch_id=rejudge_batches.id)=expected_count
        AND (SELECT COUNT(*) FROM rejudge_jobs
          WHERE rejudge_batch_id=rejudge_batches.id AND state='ready')=expected_count`)
      .bind(now, now, batch.id),
    env.DB.prepare(`INSERT INTO effective_rejudges
        (origin_submission_id, effective_submission_id, rejudge_batch_id, became_effective_at)
      SELECT origin_submission_id, new_submission_id, rejudge_batch_id, ?
        FROM rejudge_jobs
       WHERE rejudge_batch_id=? AND state='ready'
         AND EXISTS (SELECT 1 FROM rejudge_batches WHERE id=? AND state='effective')
      ON CONFLICT(origin_submission_id) DO UPDATE SET
        effective_submission_id=excluded.effective_submission_id,
        rejudge_batch_id=excluded.rejudge_batch_id,
        became_effective_at=excluded.became_effective_at`)
      .bind(now, batch.id, batch.id),
  ]);
  return madeEffective?.meta.changes === 1;
}

async function failBatch(env: WasmOjWorkerEnv, batch: RejudgeBatchRow, failureCode: string): Promise<boolean> {
  await cancelBatchChildren(env, batch, failureCode);
  const updated = await env.DB.prepare(`UPDATE rejudge_batches SET state='failed', failure_code=?, updated_at=?
    WHERE id=? AND state IN ('queued','running','ready')`)
    .bind(failureCode, new Date().toISOString(), batch.id).run();
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
    if ((aggregate?.failed ?? 0) > 0) {
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
    const complete = total === batch.expected_count && ready === batch.expected_count && remaining === 0;
    await env.DB.prepare(`UPDATE rejudge_batches SET state=?, updated_at=?
      WHERE id=? AND state IN ('running','ready')`)
      .bind(complete ? "ready" : "running", new Date().toISOString(), batch.id).run();
    if (complete && await makeReadyBatchEffective(env, { ...batch, state: "ready" })) changed += 1;
  }
  return changed;
}
