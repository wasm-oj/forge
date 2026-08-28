import capacity from "../config/capacity.json";
import { canonicalJsonBytes } from "../src/core/canonical-json";
import { MAX_PUBLIC_BUNDLE_BYTES } from "../src/online-judge/repository-contract";
import { authenticatedSession, requireBrowserOrBearerMutationSession, requireSession } from "./auth";
import {
  authorizedCatalogRepository,
  catalogRepositoryById,
  readExactCommitContents,
  resolveExactCommit,
} from "./catalog-github";
import { dispatchCatalogJobs } from "./catalog-dispatcher";
import { sha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";
import { requireStagingFormalAccess } from "./formal-access";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { requireOrganizer } from "./github";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { loadContestRuntimeSnapshot } from "./contest-runtime";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

interface CatalogRow {
  readonly id: string;
  readonly organizer_user_id: string;
  readonly github_repository_id: number;
  readonly active_commit_sha: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface PublicContentPointer {
  readonly github_repository_id: number;
  readonly commit_sha: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "payload-invalid", `${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new ApiError(400, "payload-invalid", `${label} has an invalid shape.`);
  }
  return record;
}

function numericRepositoryId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new ApiError(400, "repository-id-invalid", "githubRepositoryId must be a positive integer.");
  return value as number;
}

function requestedRef(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApiError(400, "ref-invalid", "ref must be a bounded printable Git ref.");
  }
  return value;
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApiError(400, "idempotency-key-invalid", "idempotencyKey must be a bounded printable string.");
  }
  return value;
}

async function organizerMutation(request: Request, env: WasmOjWorkerEnv) {
  const session = await requireBrowserOrBearerMutationSession(request, env);
  await requireOrganizer(env, session);
  await requireStagingFormalAccess(env, session.userId);
  await requireFormalMutationsEnabled(env, request);
  return session;
}

async function organizerRead(request: Request, env: WasmOjWorkerEnv) {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  await requireStagingFormalAccess(env, session.userId);
  return session;
}

async function ownedCatalog(env: WasmOjWorkerEnv, userId: string, catalogId: string): Promise<CatalogRow> {
  if (!UUID.test(catalogId)) throw new ApiError(404, "catalog-not-found", "Catalog was not found.");
  const row = await env.DB.prepare(`SELECT id, organizer_user_id, github_repository_id, active_commit_sha, created_at, updated_at
    FROM catalogs WHERE id=? AND organizer_user_id=?`).bind(catalogId, userId).first<CatalogRow>();
  if (!row) throw new ApiError(404, "catalog-not-found", "Catalog was not found.");
  return row;
}

async function assertSyncCapacity(env: WasmOjWorkerEnv, organizerUserId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM catalog_sync_jobs WHERE state='queued') AS global_queued,
      (SELECT COUNT(*) FROM catalog_sync_jobs AS jobs JOIN catalogs ON catalogs.id=jobs.catalog_id
        WHERE jobs.state='queued' AND catalogs.organizer_user_id=?) AS organizer_queued`)
    .bind(organizerUserId).first<{ readonly global_queued: number; readonly organizer_queued: number }>();
  if (!row || row.global_queued >= capacity.catalog.globalQueued || row.organizer_queued >= capacity.catalog.perOrganizerQueued) {
    throw new ApiError(429, "catalog-capacity-exhausted", "Catalog sync capacity is full.");
  }
}

export async function createCatalog(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await organizerMutation(request, env);
  const body = exactRecord(await readJsonBody(request, 8 * 1024), ["githubRepositoryId"], "Catalog request");
  const repositoryId = numericRepositoryId(body.githubRepositoryId);
  await authorizedCatalogRepository(env, session, repositoryId);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO catalogs
      (id, organizer_user_id, github_repository_id, active_commit_sha, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?) ON CONFLICT(github_repository_id) DO NOTHING`)
    .bind(id, session.userId, repositoryId, now, now).run();
  const catalog = await env.DB.prepare(`SELECT id, organizer_user_id, github_repository_id, active_commit_sha, created_at, updated_at
    FROM catalogs WHERE github_repository_id=? AND organizer_user_id=?`)
    .bind(repositoryId, session.userId).first<CatalogRow>();
  if (!catalog) throw new ApiError(409, "catalog-owner-conflict", "This repository is already connected by another Organizer.");
  return jsonResponse({ catalog }, catalog.id === id ? 201 : 200);
}

export async function listCatalogs(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await organizerRead(request, env);
  const rows = await env.DB.prepare(`SELECT catalogs.id, catalogs.github_repository_id, catalogs.active_commit_sha,
      catalogs.created_at, catalogs.updated_at, repositories.owner_login, repositories.name
    FROM catalogs JOIN github_repositories AS repositories
      ON repositories.github_repository_id=catalogs.github_repository_id
    WHERE catalogs.organizer_user_id=? ORDER BY catalogs.created_at DESC, catalogs.id DESC LIMIT 200`)
    .bind(session.userId).all();
  return jsonResponse({ catalogs: rows.results });
}

export async function getCatalog(request: Request, env: WasmOjWorkerEnv, catalogId: string): Promise<Response> {
  const session = await organizerRead(request, env);
  const row = await env.DB.prepare(`SELECT catalogs.id, catalogs.github_repository_id, catalogs.active_commit_sha,
      catalogs.created_at, catalogs.updated_at, repositories.owner_login, repositories.name,
      deployments.synced_at AS active_synced_at, deployments.problem_count, deployments.contest_count
    FROM catalogs JOIN github_repositories AS repositories
      ON repositories.github_repository_id=catalogs.github_repository_id
    LEFT JOIN catalog_deployments AS deployments
      ON deployments.catalog_id=catalogs.id AND deployments.commit_sha=catalogs.active_commit_sha
    WHERE catalogs.id=? AND catalogs.organizer_user_id=?`)
    .bind(catalogId, session.userId).first<Record<string, unknown>>();
  if (!row) throw new ApiError(404, "catalog-not-found", "Catalog was not found.");
  return jsonResponse({ catalog: row }, 200, { "cache-control": "private, no-store" });
}

export async function createCatalogSync(request: Request, env: WasmOjWorkerEnv, catalogId: string): Promise<Response> {
  const session = await organizerMutation(request, env);
  const catalog = await ownedCatalog(env, session.userId, catalogId);
  const body = exactRecord(await readJsonBody(request, 8 * 1024), ["idempotencyKey", "ref"], "Catalog sync request");
  const ref = requestedRef(body.ref);
  const key = idempotencyKey(body.idempotencyKey);
  await assertSyncCapacity(env, session.userId);
  const repository = await authorizedCatalogRepository(env, session, catalog.github_repository_id);
  const commitSha = await resolveExactCommit(repository, ref);
  if (!COMMIT.test(commitSha)) throw new ApiError(502, "github-commit-invalid", "GitHub returned an invalid exact commit.");
  const requestDigest = await sha256Hex(canonicalJsonBytes({ catalogId, commitSha }));
  const existing = await env.DB.prepare(`SELECT id, request_digest FROM catalog_sync_jobs
    WHERE requested_by=? AND idempotency_key=?`).bind(session.userId, key)
    .first<{ readonly id: string; readonly request_digest: string }>();
  if (existing) {
    if (existing.request_digest !== requestDigest) throw new ApiError(409, "idempotency-conflict", "Idempotency key was used for a different exact commit.");
    return jsonResponse({ sync: { id: existing.id } });
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const [job] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO catalog_sync_jobs
        (id, catalog_id, requested_ref, commit_sha, state, requested_by, idempotency_key, request_digest, created_at, updated_at)
      SELECT ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM catalog_sync_jobs WHERE state='queued') < ?
        AND (SELECT COUNT(*) FROM catalog_sync_jobs AS queued JOIN catalogs ON catalogs.id=queued.catalog_id
          WHERE queued.state='queued' AND catalogs.organizer_user_id=?) < ?`)
      .bind(id, catalog.id, ref, commitSha, session.userId, key, requestDigest, now, now,
        capacity.catalog.globalQueued, session.userId, capacity.catalog.perOrganizerQueued),
    env.DB.prepare(`INSERT INTO workflow_outbox
        (id, catalog_sync_job_id, state, attempts, created_at, updated_at)
      SELECT ?, id, 'pending', 0, ?, ? FROM catalog_sync_jobs WHERE id=?`)
      .bind(crypto.randomUUID(), now, now, id),
  ]);
  if (job?.meta.changes !== 1) {
    const winner = await env.DB.prepare(`SELECT id, request_digest FROM catalog_sync_jobs
      WHERE requested_by=? AND idempotency_key=?`).bind(session.userId, key)
      .first<{ readonly id: string; readonly request_digest: string }>();
    if (winner?.request_digest === requestDigest) return jsonResponse({ sync: { id: winner.id } });
    throw new ApiError(429, "catalog-capacity-exhausted", "Catalog sync capacity is full.");
  }
  await dispatchCatalogJobs(env);
  return jsonResponse({ sync: { id, catalogId, requestedRef: ref, commitSha, state: "queued" } }, 202);
}

export async function getCatalogSync(request: Request, env: WasmOjWorkerEnv, syncId: string): Promise<Response> {
  const session = await organizerRead(request, env);
  const row = await env.DB.prepare(`SELECT jobs.id, jobs.catalog_id, jobs.requested_ref, jobs.commit_sha,
      jobs.state, jobs.error_code, jobs.summary_json, jobs.created_at, jobs.updated_at, jobs.started_at, jobs.finished_at
    FROM catalog_sync_jobs AS jobs JOIN catalogs ON catalogs.id=jobs.catalog_id
    WHERE jobs.id=? AND catalogs.organizer_user_id=?`).bind(syncId, session.userId).first<Record<string, unknown> & { readonly summary_json?: string | null }>();
  if (!row) throw new ApiError(404, "catalog-sync-not-found", "Catalog sync was not found.");
  const { summary_json: summaryJson, ...sync } = row;
  return jsonResponse({ sync: { ...sync, summary: summaryJson ? JSON.parse(summaryJson) : null } });
}

function digestBytes(digest: string): Uint8Array {
  return Uint8Array.from(digest.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function contentClientResponse(bytes: Uint8Array, digest: string, role: "practice" | "contest"): Response {
  return new Response(bytes.slice().buffer, { headers: {
    "cache-control": role === "contest" ? "private, no-store" : "public, max-age=300",
    "content-type": "application/json; charset=utf-8",
    etag: `"${digest}"`,
    "x-content-type-options": "nosniff",
    ...(role === "contest" ? { vary: "Cookie" } : {}),
  } });
}

async function contentPointer(
  request: Request,
  env: WasmOjWorkerEnv,
  problemId: string,
): Promise<{ readonly role: "practice" | "contest"; readonly pointer: PublicContentPointer }> {
  const url = new URL(request.url);
  const commit = url.searchParams.get("commit");
  const role = url.searchParams.get("role");
  if (!commit || !COMMIT.test(commit)) throw new ApiError(400, "catalog-commit-invalid", "commit must be an exact Git commit.");
  if (role !== "practice" && role !== "contest") throw new ApiError(400, "content-role-invalid", "role must be practice or contest.");
  if (role === "practice") {
    const row = await env.DB.prepare(`SELECT catalogs.github_repository_id, revisions.commit_sha,
        revisions.practice_bundle_path AS path, revisions.practice_bundle_bytes AS bytes,
        revisions.practice_bundle_sha256 AS sha256
      FROM problem_revisions AS revisions
      JOIN problem_series AS problems ON problems.id=revisions.problem_id
      JOIN catalogs ON catalogs.id=problems.catalog_id AND catalogs.active_commit_sha=revisions.commit_sha
      WHERE revisions.problem_id=? AND revisions.commit_sha=? AND revisions.practice_enabled=1`)
      .bind(problemId, commit).first<PublicContentPointer>();
    if (!row) throw new ApiError(404, "problem-not-found", "Active practice problem was not found.");
    return { role, pointer: row };
  }
  const contestId = url.searchParams.get("contestId");
  if (!contestId || !UUID.test(contestId)) throw new ApiError(400, "contest-id-invalid", "contestId is required for contest content.");
  const session = await authenticatedSession(request, env);
  const snapshot = await loadContestRuntimeSnapshot(env, contestId, session ?? null);
  const organizerRow = await env.DB.prepare(`SELECT catalogs.organizer_user_id
    FROM contest_series JOIN catalogs ON catalogs.id=contest_series.catalog_id
    WHERE contest_series.id=?`).bind(contestId).first<{ readonly organizer_user_id: string }>();
  const organizer = organizerRow?.organizer_user_id === session?.userId;
  const epoch = snapshot.problems.find((problem) => problem.problemId === problemId && problem.contentCommit === commit);
  const projected = epoch && snapshot.projection.problems.find((problem) => problem.slug === epoch.problemSlug);
  let granted = false;
  if (snapshot.entrant && epoch) {
    granted = Boolean(await env.DB.prepare(`SELECT 1 FROM contest_reveal_grants
      WHERE contest_id=? AND entrant_id=? AND problem_id=? AND timeline_generation=?
        AND eligibility='eligible'`)
      .bind(contestId, snapshot.entrant.entrantId, problemId, snapshot.epochs.timelineGeneration).first());
  }
  if (!epoch || (!organizer && (!snapshot.entrant
    || (!granted && (snapshot.state === "paused" || projected?.availability === "locked"))))) {
    throw new ApiError(404, "contest-problem-not-found", "Authorized contest problem was not found.");
  }
  if (!organizer && !granted && snapshot.entrant && snapshot.projection.logicalSeconds !== null) {
    await env.DB.prepare(`INSERT INTO contest_reveal_grants
      (contest_id, entrant_id, problem_id, timeline_generation, rules_epoch,
       content_epoch, granted_logical_seconds, granted_at, eligibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'eligible')
      ON CONFLICT(contest_id, entrant_id, problem_id, timeline_generation) DO NOTHING`)
      .bind(
        contestId, snapshot.entrant.entrantId, problemId, snapshot.epochs.timelineGeneration,
        snapshot.epochs.ruleEpoch, epoch.contentEpoch, snapshot.projection.logicalSeconds,
        new Date().toISOString(),
      ).run();
  }
  const row = await env.DB.prepare(`SELECT catalogs.github_repository_id, revisions.commit_sha,
      revisions.contest_bundle_path AS path, revisions.contest_bundle_bytes AS bytes,
      revisions.contest_bundle_sha256 AS sha256
    FROM problem_revisions AS revisions
    JOIN problem_series AS problems ON problems.id=revisions.problem_id
    JOIN catalogs ON catalogs.id=problems.catalog_id
    JOIN contest_series ON contest_series.catalog_id=catalogs.id
    WHERE contest_series.id=? AND revisions.problem_id=? AND revisions.commit_sha=?`)
    .bind(contestId, problemId, commit).first<PublicContentPointer>();
  if (!row) throw new ApiError(404, "contest-problem-not-found", "Authorized contest problem was not found.");
  return { role, pointer: row };
}

export async function publicProblemContent(request: Request, env: WasmOjWorkerEnv, problemId: string): Promise<Response> {
  const { role, pointer } = await contentPointer(request, env, problemId);
  if (!COMMIT.test(pointer.commit_sha) || !SHA256.test(pointer.sha256)) throw new ApiError(503, "content-pointer-invalid", "Content pointer is invalid.");
  const key = `public-content/v1/${pointer.sha256}`;
  const cached = await env.JUDGE_BUCKET.get(key);
  if (cached) {
    if (
      cached.size !== pointer.bytes
      || cached.checksums.toJSON().sha256 !== pointer.sha256
    ) throw new ApiError(503, "content-cache-invalid", "Cached content failed its immutable identity check.");
    return contentClientResponse(new Uint8Array(await cached.arrayBuffer()), pointer.sha256, role);
  }
  const repository = await catalogRepositoryById(env, pointer.github_repository_id);
  let bytes: Uint8Array;
  try {
    bytes = await readExactCommitContents(repository, pointer.commit_sha, pointer.path, pointer.bytes, MAX_PUBLIC_BUNDLE_BYTES);
  } catch {
    throw new ApiError(503, "github-content-unavailable", "Exact-commit problem content is temporarily unavailable.");
  }
  if (await sha256Hex(bytes) !== pointer.sha256) {
    bytes.fill(0);
    throw new ApiError(503, "github-content-invalid", "Exact-commit problem content failed SHA-256 verification.");
  }
  const created = await env.JUDGE_BUCKET.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: digestBytes(pointer.sha256),
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  if (!created) {
    const winner = await env.JUDGE_BUCKET.head(key);
    if (!winner || winner.size !== pointer.bytes || winner.checksums.toJSON().sha256 !== pointer.sha256) {
      throw new ApiError(503, "content-cache-conflict", "Content cache key is bound to different bytes.");
    }
  }
  return contentClientResponse(bytes, pointer.sha256, role);
}
