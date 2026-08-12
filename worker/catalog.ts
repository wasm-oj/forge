import capacity from "../config/capacity.json";
import { canonicalJsonBytes } from "../src/core/canonical-json";
import { authenticatedSession, requireMutationSession, requireSession } from "./auth";
import {
  authorizedCatalogRepository,
  catalogRepositoryById,
  readVerifiedBlob,
  resolveExactCommit,
  type ExactGitBlob,
} from "./catalog-github";
import { dispatchCatalogJobs } from "./catalog-dispatcher";
import { sha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";
import { requireStagingFormalAccess } from "./formal-access";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { requireOrganizer } from "./github";
import { ApiError, jsonResponse, readJsonBody } from "./http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NORMALIZED_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000-\u001f\u007f]+$/;

interface CollectionRow {
  readonly id: string;
  readonly organizer_user_id: string;
  readonly github_repository_id: number;
  readonly index_path: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ValidationRow {
  readonly id: string;
  readonly collection_id: string;
  readonly requested_ref: string;
  readonly commit_sha: string;
  readonly state: string;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly revision_id: string | null;
  readonly validation_summary_json: string | null;
}

interface PublicationRow {
  readonly id: string;
  readonly state: string;
  readonly mode: "official-practice" | "contest";
  readonly error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly publication_id: string | null;
}

interface PublicationOptionRow {
  readonly publication_id: string;
  readonly mode: "official-practice" | "contest";
  readonly published_at: string;
  readonly github_repository_id: number;
  readonly owner_login: string;
  readonly repository_name: string;
  readonly problem_version_id: string;
  readonly problem_series_id: string;
  readonly problem_slug: string;
  readonly problem_number: number;
  readonly title_json: string;
  readonly execution_semantic_sha256: string;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "payload-invalid", `${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) {
    throw new ApiError(400, "payload-invalid", `${label} has an invalid shape.`);
  }
  return record;
}

function normalizedPath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || !NORMALIZED_PATH.test(value)) {
    throw new ApiError(400, "index-path-invalid", "indexPath must be a normalized relative POSIX path.");
  }
  return value;
}

function numericRepositoryId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ApiError(400, "repository-id-invalid", "githubRepositoryId must be a positive numeric repository identity.");
  }
  return value as number;
}

function requestedRef(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApiError(400, "ref-invalid", "ref must be a bounded printable Git ref.");
  }
  return value;
}

function publicationMode(value: unknown): "official-practice" | "contest" {
  if (value !== "official-practice" && value !== "contest") {
    throw new ApiError(400, "publication-mode-invalid", "mode must be official-practice or contest.");
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
  const session = await requireMutationSession(request, env);
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

async function ownedCollection(env: WasmOjWorkerEnv, userId: string, collectionId: string): Promise<CollectionRow> {
  if (!UUID.test(collectionId)) throw new ApiError(404, "collection-not-found", "Collection was not found.");
  const row = await env.DB.prepare(`SELECT id, organizer_user_id, github_repository_id, index_path, created_at, updated_at
      FROM problem_collections WHERE id=? AND organizer_user_id=?`)
    .bind(collectionId, userId).first<CollectionRow>();
  if (!row) throw new ApiError(404, "collection-not-found", "Collection was not found.");
  return row;
}

async function assertCatalogAdmission(env: WasmOjWorkerEnv, organizerUserId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM catalog_validation_jobs WHERE state='queued')
        + (SELECT COUNT(*) FROM catalog_publish_jobs WHERE state='queued') AS global_queued,
      (SELECT COUNT(*) FROM catalog_validation_jobs AS jobs
         JOIN problem_collections AS collections ON collections.id=jobs.collection_id
        WHERE jobs.state='queued' AND collections.organizer_user_id=?)
        + (SELECT COUNT(*) FROM catalog_publish_jobs AS jobs
          JOIN collection_revisions AS revisions ON revisions.id=jobs.collection_revision_id
          JOIN problem_collections AS collections ON collections.id=revisions.collection_id
         WHERE jobs.state='queued' AND collections.organizer_user_id=?) AS organizer_queued`)
    .bind(organizerUserId, organizerUserId)
    .first<{ readonly global_queued: number; readonly organizer_queued: number }>();
  if (!row || row.global_queued >= capacity.catalog.globalQueued || row.organizer_queued >= capacity.catalog.perOrganizerQueued) {
    throw new ApiError(429, "catalog-capacity-exhausted", "Catalog validation and publication capacity is full.");
  }
}

export async function createProblemCollection(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await organizerMutation(request, env);
  const body = exactRecord(await readJsonBody(request, 8 * 1024), ["githubRepositoryId", "indexPath"], "Collection request");
  const repositoryId = numericRepositoryId(body.githubRepositoryId);
  const indexPath = normalizedPath(body.indexPath);
  await authorizedCatalogRepository(env, session, repositoryId);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO problem_collections
      (id, organizer_user_id, github_repository_id, index_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(github_repository_id, index_path) DO NOTHING`)
    .bind(id, session.userId, repositoryId, indexPath, now, now).run();
  const collection = await env.DB.prepare(`SELECT id, organizer_user_id, github_repository_id, index_path, created_at, updated_at
      FROM problem_collections WHERE github_repository_id=? AND index_path=? AND organizer_user_id=?`)
    .bind(repositoryId, indexPath, session.userId).first<CollectionRow>();
  if (!collection) throw new ApiError(409, "collection-owner-conflict", "This repository collection is already managed by another Organizer.");
  return jsonResponse({ collection }, collection.id === id ? 201 : 200);
}

export async function listProblemCollections(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await organizerRead(request, env);
  const rows = await env.DB.prepare(`SELECT collections.id, collections.github_repository_id, collections.index_path,
      collections.created_at, collections.updated_at, repositories.owner_login, repositories.name
    FROM problem_collections AS collections
    JOIN github_repositories AS repositories ON repositories.github_repository_id=collections.github_repository_id
    WHERE collections.organizer_user_id=? ORDER BY collections.created_at DESC, collections.id DESC LIMIT 200`)
    .bind(session.userId).all();
  return jsonResponse({ collections: rows.results });
}

export async function createCatalogValidation(
  request: Request,
  env: WasmOjWorkerEnv,
  collectionId: string,
): Promise<Response> {
  const session = await organizerMutation(request, env);
  const collection = await ownedCollection(env, session.userId, collectionId);
  const body = exactRecord(await readJsonBody(request, 8 * 1024), ["ref"], "Validation request");
  const ref = requestedRef(body.ref);
  // This admission preflight intentionally precedes the first GitHub request.
  await assertCatalogAdmission(env, session.userId);
  const repository = await authorizedCatalogRepository(env, session, collection.github_repository_id);
  const commitSha = await resolveExactCommit(repository, ref);
  if (!COMMIT.test(commitSha)) throw new ApiError(502, "github-commit-invalid", "GitHub returned an invalid exact commit.");
  const existingRevision = await env.DB.prepare(
    "SELECT id FROM collection_revisions WHERE collection_id=? AND commit_sha=?",
  ).bind(collection.id, commitSha).first<{ readonly id: string }>();
  if (existingRevision) {
    throw new ApiError(409, "revision-already-valid", "This exact commit is already a valid revision.", { revisionId: existingRevision.id });
  }
  const jobId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const now = new Date().toISOString();
  const [job] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO catalog_validation_jobs
        (id, collection_id, requested_ref, commit_sha, state, created_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, 'queued', ?, ?, ?
      WHERE (SELECT COUNT(*) FROM catalog_validation_jobs WHERE state='queued')
          + (SELECT COUNT(*) FROM catalog_publish_jobs WHERE state='queued') < ?
        AND (SELECT COUNT(*) FROM catalog_validation_jobs AS jobs
          JOIN problem_collections AS collections ON collections.id=jobs.collection_id
          WHERE jobs.state='queued' AND collections.organizer_user_id=?)
          + (SELECT COUNT(*) FROM catalog_publish_jobs AS jobs
            JOIN collection_revisions AS revisions ON revisions.id=jobs.collection_revision_id
            JOIN problem_collections AS collections ON collections.id=revisions.collection_id
            WHERE jobs.state='queued' AND collections.organizer_user_id=?) < ?`)
      .bind(jobId, collection.id, ref, commitSha, session.userId, now, now,
        capacity.catalog.globalQueued, session.userId, session.userId, capacity.catalog.perOrganizerQueued),
    env.DB.prepare(`INSERT INTO workflow_outbox
        (id, state, catalog_validation_job_id, attempts, created_at, updated_at)
      SELECT ?, 'pending', id, 0, ?, ?
        FROM catalog_validation_jobs WHERE id=?`)
      .bind(outboxId, now, now, jobId),
  ]);
  if (job?.meta.changes !== 1) throw new ApiError(429, "catalog-capacity-exhausted", "Catalog validation capacity is full.");
  await dispatchCatalogJobs(env);
  return jsonResponse({ validation: { id: jobId, collectionId: collection.id, commitSha, state: "queued" } }, 202);
}

export async function getCatalogValidation(request: Request, env: WasmOjWorkerEnv, validationId: string): Promise<Response> {
  const session = await organizerRead(request, env);
  const row = await env.DB.prepare(`SELECT jobs.id, jobs.collection_id, jobs.requested_ref, jobs.commit_sha,
      jobs.state, jobs.error_code, jobs.created_at, jobs.updated_at, jobs.started_at, jobs.finished_at,
      revisions.id AS revision_id, revisions.validation_summary_json
    FROM catalog_validation_jobs AS jobs
    JOIN problem_collections AS collections ON collections.id=jobs.collection_id
    LEFT JOIN collection_revisions AS revisions ON revisions.validation_job_id=jobs.id
    WHERE jobs.id=? AND collections.organizer_user_id=?`)
    .bind(validationId, session.userId).first<ValidationRow>();
  if (!row) throw new ApiError(404, "validation-not-found", "Catalog validation was not found.");
  return jsonResponse({ validation: {
    id: row.id,
    collectionId: row.collection_id,
    requestedRef: row.requested_ref,
    commitSha: row.commit_sha,
    state: row.state,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    revisionId: row.revision_id,
    summary: row.validation_summary_json ? JSON.parse(row.validation_summary_json) : null,
  } });
}

export async function createCatalogPublication(
  request: Request,
  env: WasmOjWorkerEnv,
  revisionId: string,
): Promise<Response> {
  const session = await organizerMutation(request, env);
  const body = exactRecord(await readJsonBody(request, 8 * 1024), ["idempotencyKey", "mode"], "Publication request");
  const mode = publicationMode(body.mode);
  const key = idempotencyKey(body.idempotencyKey);
  const revision = await env.DB.prepare(`SELECT revisions.id, collections.organizer_user_id
    FROM collection_revisions AS revisions
    JOIN problem_collections AS collections ON collections.id=revisions.collection_id
    WHERE revisions.id=? AND collections.organizer_user_id=?`)
    .bind(revisionId, session.userId).first<{ readonly id: string; readonly organizer_user_id: string }>();
  if (!revision) throw new ApiError(404, "revision-not-found", "Valid collection revision was not found.");
  const requestDigest = await sha256Hex(canonicalJsonBytes({ mode, revisionId }));
  const existing = await env.DB.prepare(`SELECT id, request_digest FROM catalog_publish_jobs
      WHERE requested_by=? AND idempotency_key=?`)
    .bind(session.userId, key).first<{ readonly id: string; readonly request_digest: string }>();
  if (existing) {
    if (existing.request_digest !== requestDigest) throw new ApiError(409, "idempotency-conflict", "Idempotency key was used for a different publication.");
    return jsonResponse({ publicationJob: { id: existing.id } }, 200);
  }
  await assertCatalogAdmission(env, session.userId);
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const [job] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO catalog_publish_jobs
        (id, collection_revision_id, mode, state, requested_by, idempotency_key, request_digest, created_at, updated_at)
      SELECT ?, ?, ?, 'queued', ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM catalog_validation_jobs WHERE state='queued')
          + (SELECT COUNT(*) FROM catalog_publish_jobs WHERE state='queued') < ?
        AND (SELECT COUNT(*) FROM catalog_validation_jobs AS jobs
          JOIN problem_collections AS collections ON collections.id=jobs.collection_id
          WHERE jobs.state='queued' AND collections.organizer_user_id=?)
          + (SELECT COUNT(*) FROM catalog_publish_jobs AS jobs
            JOIN collection_revisions AS revisions ON revisions.id=jobs.collection_revision_id
            JOIN problem_collections AS collections ON collections.id=revisions.collection_id
            WHERE jobs.state='queued' AND collections.organizer_user_id=?) < ?`)
      .bind(jobId, revisionId, mode, session.userId, key, requestDigest, now, now,
        capacity.catalog.globalQueued, session.userId, session.userId, capacity.catalog.perOrganizerQueued),
    env.DB.prepare(`INSERT INTO workflow_outbox
        (id, state, catalog_publish_job_id, attempts, created_at, updated_at)
      SELECT ?, 'pending', id, 0, ?, ? FROM catalog_publish_jobs WHERE id=?`)
      .bind(crypto.randomUUID(), now, now, jobId),
  ]);
  if (job?.meta.changes !== 1) {
    const winner = await env.DB.prepare(`SELECT id, request_digest FROM catalog_publish_jobs
      WHERE requested_by=? AND idempotency_key=?`).bind(session.userId, key)
      .first<{ readonly id: string; readonly request_digest: string }>();
    if (winner?.request_digest === requestDigest) return jsonResponse({ publicationJob: { id: winner.id } }, 200);
    throw new ApiError(429, "catalog-capacity-exhausted", "Catalog publication capacity is full.");
  }
  await dispatchCatalogJobs(env);
  return jsonResponse({ publicationJob: { id: jobId, revisionId, mode, state: "queued" } }, 202);
}

export async function getCatalogPublication(request: Request, env: WasmOjWorkerEnv, publishJobId: string): Promise<Response> {
  const session = await organizerRead(request, env);
  const row = await env.DB.prepare(`SELECT jobs.id, jobs.state, jobs.mode, jobs.error_code, jobs.created_at,
      jobs.updated_at, jobs.started_at, jobs.finished_at, publications.id AS publication_id
    FROM catalog_publish_jobs AS jobs
    JOIN collection_revisions AS revisions ON revisions.id=jobs.collection_revision_id
    JOIN problem_collections AS collections ON collections.id=revisions.collection_id
    LEFT JOIN catalog_publications AS publications ON publications.publish_job_id=jobs.id
    WHERE jobs.id=? AND collections.organizer_user_id=?`)
    .bind(publishJobId, session.userId).first<PublicationRow>();
  if (!row) throw new ApiError(404, "publication-not-found", "Catalog publication job was not found.");
  return jsonResponse({ publication: {
    id: row.publication_id,
    jobId: row.id,
    state: row.state,
    mode: row.mode,
    status: row.publication_id === null ? null : "published",
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  } });
}

export async function listCatalogPublications(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await organizerRead(request, env);
  const mode = publicationMode(new URL(request.url).searchParams.get("mode"));
  const rows = await env.DB.prepare(`WITH recent_publications AS (
      SELECT publications.id, publications.mode, publications.published_at,
             revisions.collection_id
        FROM catalog_publications AS publications
        JOIN collection_revisions AS revisions ON revisions.id=publications.collection_revision_id
        JOIN problem_collections AS collections ON collections.id=revisions.collection_id
       WHERE collections.organizer_user_id=? AND publications.mode=?
       ORDER BY publications.published_at DESC, publications.id DESC
       LIMIT 25
    )
    SELECT recent.id AS publication_id, recent.mode, recent.published_at,
           collections.github_repository_id, repositories.owner_login,
           repositories.name AS repository_name, versions.id AS problem_version_id,
           versions.problem_series_id, versions.problem_slug, versions.problem_number,
           versions.title_json, versions.execution_semantic_sha256
      FROM recent_publications AS recent
      JOIN problem_collections AS collections ON collections.id=recent.collection_id
      JOIN github_repositories AS repositories
        ON repositories.github_repository_id=collections.github_repository_id
      JOIN problem_version_details AS versions ON versions.catalog_publication_id=recent.id
     ORDER BY recent.published_at DESC, recent.id DESC, versions.problem_number, versions.id
     LIMIT 5001`)
    .bind(session.userId, mode).all<PublicationOptionRow>();
  if (rows.results.length > 5_000) {
    throw new ApiError(409, "publication-options-too-large", "Published problem options exceed the Organizer response limit.");
  }
  const publications = new Map<string, {
    id: string;
    mode: "official-practice" | "contest";
    publishedAt: string;
    repository: { id: number; owner: string; name: string };
    problems: Array<{
      problemVersionId: string;
      problemSeriesId: string;
      slug: string;
      number: number;
      title: unknown;
      executionSemanticSha256: string;
    }>;
  }>();
  for (const row of rows.results) {
    let publication = publications.get(row.publication_id);
    if (!publication) {
      publication = {
        id: row.publication_id,
        mode: row.mode,
        publishedAt: row.published_at,
        repository: {
          id: row.github_repository_id,
          owner: row.owner_login,
          name: row.repository_name,
        },
        problems: [],
      };
      publications.set(row.publication_id, publication);
    }
    publication.problems.push({
      problemVersionId: row.problem_version_id,
      problemSeriesId: row.problem_series_id,
      slug: row.problem_slug,
      number: row.problem_number,
      title: JSON.parse(row.title_json) as unknown,
      executionSemanticSha256: row.execution_semantic_sha256,
    });
  }
  return jsonResponse({ publications: [...publications.values()] });
}

export async function activateCatalogPublication(
  request: Request,
  env: WasmOjWorkerEnv,
  publicationId: string,
): Promise<Response> {
  const session = await organizerMutation(request, env);
  const publication = await env.DB.prepare(`SELECT publications.id, publications.mode
    FROM catalog_publications AS publications
    JOIN collection_revisions AS revisions ON revisions.id=publications.collection_revision_id
    JOIN problem_collections AS collections ON collections.id=revisions.collection_id
    WHERE publications.id=? AND collections.organizer_user_id=?`)
    .bind(publicationId, session.userId).first<{
      readonly id: string;
      readonly mode: string;
    }>();
  if (!publication || publication.mode !== "official-practice") {
    throw new ApiError(409, "publication-not-activatable", "Only a published official-practice publication can be activated.");
  }
  const versions = await env.DB.prepare(`SELECT successor.id, successor.problem_series_id,
      successor.execution_semantic_sha256,
      heads.problem_version_id AS predecessor_problem_version_id,
      predecessor.execution_semantic_sha256 AS predecessor_semantic_sha256
    FROM problem_version_details AS successor
    LEFT JOIN official_practice_heads AS heads
      ON heads.problem_series_id=successor.problem_series_id
    LEFT JOIN problem_version_details AS predecessor ON predecessor.id=heads.problem_version_id
    WHERE successor.catalog_publication_id=? ORDER BY successor.problem_number`).bind(publicationId)
    .all<{
      readonly id: string;
      readonly problem_series_id: string;
      readonly execution_semantic_sha256: string;
      readonly predecessor_problem_version_id: string | null;
      readonly predecessor_semantic_sha256: string | null;
    }>();
  if (versions.results.length < 1) throw new ApiError(409, "publication-empty", "Publication has no problem versions.");
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const version of versions.results) {
    if (
      version.predecessor_problem_version_id
      && version.predecessor_problem_version_id !== version.id
      && version.predecessor_semantic_sha256 === version.execution_semantic_sha256
    ) {
      statements.push(env.DB.prepare(`INSERT INTO problem_version_lineages
        (problem_series_id, predecessor_problem_version_id, successor_problem_version_id,
         reason, rejudge_batch_id, created_at)
        VALUES (?, ?, ?, 'publication', NULL, ?)`)
        .bind(
          version.problem_series_id,
          version.predecessor_problem_version_id,
          version.id,
          now,
        ));
    }
    statements.push(env.DB.prepare(`INSERT INTO official_practice_heads
        (problem_series_id, problem_version_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(problem_series_id) DO UPDATE SET
        problem_version_id=excluded.problem_version_id,
        updated_at=excluded.updated_at`)
      .bind(version.problem_series_id, version.id, now));
  }
  await env.DB.batch(statements);
  return jsonResponse({ activation: { publicationId, activatedProblems: versions.results.length, activatedAt: now } });
}

interface PublicContentPointer {
  readonly github_repository_id: number;
  readonly commit_sha: string;
  readonly path: string;
  readonly git_sha: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface ContestContentPointer extends PublicContentPointer {
  readonly organizer_user_id: string;
  readonly access_mode: "public" | "invite";
  readonly contest_status: "draft" | "published" | "archived";
  readonly starts_at: string;
  readonly participant_user_id: string | null;
}

function contentCacheKey(pointer: PublicContentPointer, role: "practice" | "contest-public"): Request {
  const url = new URL("https://catalog-cache.invalid/v2/content");
  url.searchParams.set("repository", String(pointer.github_repository_id));
  url.searchParams.set("commit", pointer.commit_sha);
  url.searchParams.set("blob", pointer.git_sha);
  url.searchParams.set("path", pointer.path);
  url.searchParams.set("sha256", pointer.sha256);
  url.searchParams.set("role", role);
  return new Request(url.toString(), { method: "GET" });
}

export function contentClientResponse(
  response: Response,
  role: "practice" | "contest-public",
): Response {
  const headers = new Headers(response.headers);
  if (role === "contest-public") {
    headers.set("cache-control", "private, no-store");
    headers.set("vary", "Cookie");
  } else {
    headers.set("cache-control", "public, max-age=300");
    headers.delete("vary");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function contentPointer(
  request: Request,
  env: WasmOjWorkerEnv,
  problemVersionId: string,
): Promise<{ readonly role: "practice" | "contest-public"; readonly pointer: PublicContentPointer }> {
  const url = new URL(request.url);
  const role = url.searchParams.get("role");
  if (role !== "practice" && role !== "contest-public") {
    throw new ApiError(400, "content-role-invalid", "role must be practice or contest-public.");
  }
  if (role === "practice") {
    const row = await env.DB.prepare(`SELECT collections.github_repository_id, revisions.commit_sha,
        versions.practice_bundle_path AS path, versions.practice_bundle_git_sha AS git_sha,
        versions.practice_bundle_bytes AS bytes, versions.practice_bundle_sha256 AS sha256
      FROM official_practice_heads AS heads
      JOIN problem_version_details AS versions ON versions.id=heads.problem_version_id
      JOIN collection_revisions AS revisions ON revisions.id=versions.collection_revision_id
      JOIN problem_collections AS collections ON collections.id=versions.collection_id
      JOIN github_repositories AS repositories
        ON repositories.github_repository_id=collections.github_repository_id
       AND repositories.authorization_status='authorized'
      JOIN github_installations AS installations
        ON installations.installation_id=repositories.installation_id
       AND installations.status='active'
       AND installations.installed_by_user_id IS NOT NULL
      WHERE versions.id=?`).bind(problemVersionId).first<PublicContentPointer>();
    if (!row) throw new ApiError(404, "problem-not-found", "Active practice problem was not found.");
    return { role, pointer: row };
  }
  const contestId = url.searchParams.get("contestId");
  if (!contestId || !UUID.test(contestId)) throw new ApiError(400, "contest-id-invalid", "contestId is required for contest-public content.");
  const session = await authenticatedSession(request, env);
  const row = await env.DB.prepare(`SELECT collections.github_repository_id, revisions.commit_sha,
      versions.contest_public_path AS path, versions.contest_public_git_sha AS git_sha,
      versions.contest_public_bytes AS bytes, versions.contest_public_sha256 AS sha256,
      contests.organizer_user_id, contests.access_mode, contests.status AS contest_status,
      contests.starts_at, contest_participants.user_id AS participant_user_id
    FROM contest_problems
    JOIN contests ON contests.id=contest_problems.contest_id
    LEFT JOIN contest_participants
      ON contest_participants.contest_id=contests.id AND contest_participants.user_id=?
    JOIN problem_version_details AS versions ON versions.id=contest_problems.problem_version_id
    JOIN collection_revisions AS revisions ON revisions.id=versions.collection_revision_id
    JOIN problem_collections AS collections ON collections.id=versions.collection_id
    JOIN github_repositories AS repositories
      ON repositories.github_repository_id=collections.github_repository_id
     AND repositories.authorization_status='authorized'
    JOIN github_installations AS installations
      ON installations.installation_id=repositories.installation_id
     AND installations.status='active'
     AND installations.installed_by_user_id IS NOT NULL
    WHERE contest_problems.contest_id=? AND versions.id=?`)
    .bind(session?.userId ?? "", contestId, problemVersionId).first<ContestContentPointer>();
  const organizer = row?.organizer_user_id === session?.userId;
  const visible = row && (organizer || (
    row.contest_status === "published"
    && row.starts_at <= new Date().toISOString()
    && (row.access_mode === "public" || row.participant_user_id === session?.userId)
  ));
  if (!visible) throw new ApiError(404, "contest-problem-not-found", "Authorized contest problem was not found.");
  return { role, pointer: row };
}

export async function publicProblemContent(
  request: Request,
  env: WasmOjWorkerEnv,
  problemVersionId: string,
): Promise<Response> {
  const { role, pointer } = await contentPointer(request, env, problemVersionId);
  if (!COMMIT.test(pointer.commit_sha) || !COMMIT.test(pointer.git_sha) || !SHA256.test(pointer.sha256)) {
    throw new ApiError(503, "content-pointer-invalid", "Published content pointer is invalid.");
  }
  const key = contentCacheKey(pointer, role);
  const cache = (caches as CacheStorage & { readonly default: Cache }).default;
  const hit = await cache.match(key);
  if (hit) return contentClientResponse(hit, role);
  const repository = await catalogRepositoryById(env, pointer.github_repository_id);
  const blob: ExactGitBlob = { path: pointer.path, gitSha: pointer.git_sha, bytes: pointer.bytes };
  let bytes: Uint8Array;
  try {
    bytes = await readVerifiedBlob(repository, blob, pointer.sha256, 8 * 1024 * 1024);
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) throw error;
    throw new ApiError(503, "github-content-unavailable", "Exact-commit problem content is temporarily unavailable.");
  }
  const headers = new Headers({
    "cache-control": "public, max-age=300",
    "content-type": "application/json; charset=utf-8",
    etag: `"${pointer.sha256}"`,
    "x-content-type-options": "nosniff",
  });
  const response = new Response(bytes.slice().buffer, { headers });
  await cache.put(key, response.clone());
  return contentClientResponse(response, role);
}
