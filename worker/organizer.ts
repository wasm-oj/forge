import { authenticatedSession, requireMutationSession, requireSession } from "./auth";
import { randomToken, sha256Hex } from "./crypto";
import type { ForgeWorkerEnv } from "./env";
import {
  githubApiJson,
  githubAppJwt,
  githubInstallationProvisioningToken,
  githubInstallationToken,
  githubReadOnlyInstallationAuthorization,
  requireOrganizer,
  verifyGithubWebhook,
} from "./github";
import {
  activateGithubInstallationClaim,
  bindGithubInstallationClaim,
  finalizeGithubInstallationClaim,
  GITHUB_INSTALLATION_PROOF_SECONDS,
  recordGithubInstallationCreatedProof,
} from "./github-installation-claims";
import { ApiError, jsonResponse, readBoundedResponseJson, readJsonBody } from "./http";
import { requireStagingFormalAccess } from "./formal-access";
import { operationalLog } from "./structured-log";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { assertActiveRelease } from "./release";
import { parseCanonicalJsonBytes } from "../src/core/canonical-json";
import {
  parseProblemCollectionIndex,
  verifyProblemBundleBytes,
  verifyProblemCollectionRevision,
} from "../src/judge/problem-catalog-loader";
import { parseManagedCollectionContract } from "../src/online-judge/managed-collection";
import {
  verifyForgeValidationSourceBytes,
  type ForgeValidationSource,
  type VerifiedValidationSource,
} from "../src/online-judge/validation-source";
import {
  githubRepositoryCoordinates,
  parseValidationReport,
  verifyManagedProjectionBindings,
  type ValidationObjectReference as ProjectionReference,
  type ValidationReport,
  type ValidationWorkflowParameters,
} from "./validation-contract";
import {
  deliverValidationWorkflowOutbox,
  validationWorkflowOutboxJson,
} from "./validation-workflow-outbox";

const INSTALL_STATE_COOKIE = "forge_install_state";
const INSTALL_STATE_SECONDS = 10 * 60;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const NORMALIZED_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000-\u001f\u007f]+$/;

interface RepositoryRow {
  readonly github_repository_id: number;
  readonly installation_id: number;
  readonly owner_login: string;
  readonly name: string;
  readonly is_private: number;
  readonly authorization_status: string;
}

interface ImportRow {
  readonly id: string;
  readonly organizer_user_id: string;
  readonly github_repository_id: number;
  readonly requested_ref: string;
  readonly commit_sha: string;
  readonly index_path: string;
  readonly forge_release_id: string;
  readonly archive_r2_key: string | null;
  readonly validation_report_r2_key: string | null;
  readonly canonical_source_r2_key: string | null;
  readonly canonical_source_sha256: string | null;
  readonly canonical_draft_delete_after: string | null;
  readonly canonical_expired_at: string | null;
  readonly retry_of_import_id: string | null;
  readonly status: string;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function setCookie(name: string, value: string, maxAge: number): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || /[;\r\n]/.test(value)) throw new TypeError("Invalid cookie.");
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function normalizedIndexPath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || !NORMALIZED_PATH_PATTERN.test(value)) {
    throw new ApiError(400, "index-path-invalid", "indexPath must be a normalized relative POSIX path.");
  }
  return value;
}

function exactObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "payload-invalid", "Request payload must be an object.");
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ApiError(400, "payload-invalid", "Request payload has an invalid shape.");
  }
  return record;
}

async function installationJson(path: string, env: ForgeWorkerEnv): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${await githubAppJwt(env)}`,
      "user-agent": "wasm-oj-forge",
      "x-github-api-version": "2022-11-28",
    },
    redirect: "manual",
  });
  if (!response.ok) throw new ApiError(502, "github-app-error", `GitHub App request failed with HTTP ${response.status}.`);
  let value: unknown;
  try {
    value = await readBoundedResponseJson(response, 1024 * 1024);
  } catch {
    throw new ApiError(502, "github-app-response-invalid", "GitHub App returned an invalid or oversized response.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(502, "github-app-response-invalid", "GitHub App returned an invalid response object.");
  }
  return value as Record<string, unknown>;
}

function configuredGithubAppId(env: ForgeWorkerEnv): number {
  const appId = Number(env.GITHUB_APP_ID);
  if (!Number.isSafeInteger(appId) || appId < 1) throw new ApiError(503, "github-app-config-invalid", "GitHub App identity is not configured.");
  return appId;
}

async function upsertRepository(
  env: ForgeWorkerEnv,
  installationId: number,
  value: unknown,
  claim?: { readonly userId: string; readonly stateHash: string },
): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(502, "github-repository-invalid", "GitHub returned invalid repository metadata.");
  }
  const repository = value as Record<string, unknown>;
  const owner = repository.owner as Record<string, unknown> | undefined;
  if (!Number.isSafeInteger(repository.id) || (repository.id as number) < 1 || typeof repository.name !== "string" || typeof owner?.login !== "string" || typeof repository.private !== "boolean") {
    throw new ApiError(502, "github-repository-invalid", "GitHub returned invalid repository metadata.");
  }
  const now = new Date().toISOString();
  const statement = claim
    ? env.DB.prepare(
      `INSERT INTO github_repositories
         (github_repository_id, installation_id, owner_login, name, is_private, authorization_status, updated_at)
       SELECT ?, installations.installation_id, ?, ?, ?, 'authorized', ?
         FROM github_installations AS installations
         JOIN github_installation_claim_proofs AS proofs ON proofs.installation_id=installations.installation_id
        WHERE installations.installation_id=? AND installations.installed_by_user_id=?
          AND installations.status IN ('suspended', 'active')
          AND proofs.state_hash=? AND proofs.claimed_by_user_id=? AND proofs.claimed_at IS NOT NULL
       ON CONFLICT(github_repository_id) DO UPDATE SET
         owner_login=excluded.owner_login,
         name=excluded.name,
         is_private=excluded.is_private,
         authorization_status='authorized',
         updated_at=excluded.updated_at
       WHERE github_repositories.installation_id=excluded.installation_id`,
    ).bind(
      repository.id,
      owner.login,
      repository.name,
      repository.private ? 1 : 0,
      now,
      installationId,
      claim.userId,
      claim.stateHash,
      claim.userId,
    )
    : env.DB.prepare(
      `INSERT INTO github_repositories
         (github_repository_id, installation_id, owner_login, name, is_private, authorization_status, updated_at)
       SELECT ?, installation_id, ?, ?, ?, 'authorized', ?
         FROM github_installations
        WHERE installation_id=? AND installed_by_user_id IS NOT NULL AND status='active'
       ON CONFLICT(github_repository_id) DO UPDATE SET
         owner_login=excluded.owner_login,
         name=excluded.name,
         is_private=excluded.is_private,
         authorization_status='authorized',
         updated_at=excluded.updated_at
       WHERE github_repositories.installation_id=excluded.installation_id`,
    ).bind(repository.id, owner.login, repository.name, repository.private ? 1 : 0, now, installationId);
  const result = await statement.run();
  if (result.meta.changes !== 1) {
    throw new ApiError(409, "github-repository-ownership-conflict", "GitHub repository ownership changed while synchronizing the installation.");
  }
}

async function associateInstallation(
  env: ForgeWorkerEnv,
  installationId: number,
  userId: string,
  stateHash: string,
): Promise<void> {
  const now = new Date().toISOString();
  const claim = await bindGithubInstallationClaim(env.DB, { stateHash, userId, installationId, now });
  if (claim.active) return;
  const installation = await installationJson(`/app/installations/${installationId}`, env);
  const account = installation.account as Record<string, unknown> | undefined;
  if (
    !Number.isSafeInteger(installation.id)
    || installation.id !== installationId
    || installation.app_id !== configuredGithubAppId(env)
    || !Number.isSafeInteger(account?.id)
    || typeof account?.login !== "string"
  ) {
    throw new ApiError(502, "github-installation-invalid", "GitHub returned an invalid installation.");
  }
  if (account.id !== claim.accountGithubId) {
    throw new ApiError(409, "github-installation-account-mismatch", "The signed GitHub installation account does not match current App metadata.");
  }
  if (installation.suspended_at !== null && installation.suspended_at !== undefined) {
    throw new ApiError(409, "github-installation-suspended", "The GitHub App installation is suspended.");
  }
  const authorization = githubReadOnlyInstallationAuthorization(installation.permissions, installation.repository_selection);
  const finalized = await finalizeGithubInstallationClaim(env.DB, {
    stateHash,
    userId,
    metadata: {
      installationId,
      accountGithubId: account.id as number,
      accountLogin: account.login,
      permissionsJson: authorization.permissionsJson,
      repositorySelection: authorization.repositorySelection,
    },
    now: new Date().toISOString(),
  });
  if (finalized.active) return;
  const token = await githubInstallationProvisioningToken(env, installationId, userId, stateHash);
  const repositories = await githubApiJson<{ readonly total_count: number; readonly repositories: readonly unknown[] }>("/installation/repositories?per_page=100", token);
  if (!Number.isSafeInteger(repositories.total_count) || repositories.total_count < 0 || !Array.isArray(repositories.repositories) || repositories.total_count !== repositories.repositories.length || repositories.total_count > 100) {
    throw new ApiError(409, "github-repository-limit", "v1 supports at most 100 repositories per installation.");
  }
  for (const repository of repositories.repositories) await upsertRepository(env, installationId, repository, { userId, stateHash });
  await activateGithubInstallationClaim(env.DB, {
    stateHash,
    userId,
    installationId,
    now: new Date().toISOString(),
  });
}

export async function beginGithubAppInstall(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const state = randomToken();
  const now = new Date();
  await env.DB.prepare("INSERT INTO github_installation_states (state_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(state), session.userId, now.toISOString(), new Date(now.getTime() + INSTALL_STATE_SECONDS * 1_000).toISOString()).run();
  const location = new URL(`https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new`);
  location.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: { location: location.toString(), "set-cookie": setCookie(INSTALL_STATE_COOKIE, state, INSTALL_STATE_SECONDS), "cache-control": "no-store" },
  });
}

export async function completeGithubAppInstall(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const redirect = (result: string) => new Response(null, {
    status: 302,
    headers: {
      location: `/organizer/repositories?github=${encodeURIComponent(result)}`,
      "set-cookie": setCookie(INSTALL_STATE_COOKIE, "", 0),
      "cache-control": "no-store",
    },
  });
  try {
    const session = await requireSession(request, env);
    await requireStagingFormalAccess(env, session.userId);
    await requireOrganizer(env, session);
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const installationId = Number(url.searchParams.get("installation_id"));
    const stateCookie = cookie(request, INSTALL_STATE_COOKIE);
    if (!state || stateCookie !== state || !Number.isSafeInteger(installationId) || installationId < 1) {
      throw new ApiError(400, "github-install-callback-invalid", "GitHub installation callback is invalid.");
    }
    const stateHash = await sha256Hex(state);
    await associateInstallation(env, installationId, session.userId, stateHash);
    return redirect("connected");
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const result = new Map<string, string>([
      ["authentication-required", "sign-in-required"],
      ["github-install-callback-invalid", "invalid-callback"],
      ["github-installation-account-mismatch", "account-mismatch"],
      ["github-installation-suspended", "installation-suspended"],
      ["github-repository-limit", "repository-limit"],
      ["github-app-error", "github-unavailable"],
      ["github-app-response-invalid", "github-unavailable"],
    ]).get(error.code);
    if (!result) throw error;
    return redirect(result);
  }
}

export async function listOrganizerRepositories(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const rows = await env.DB.prepare(
    "SELECT github_repositories.github_repository_id, github_repositories.owner_login, github_repositories.name, github_repositories.is_private, github_repositories.updated_at FROM github_repositories JOIN github_installations ON github_installations.installation_id=github_repositories.installation_id WHERE github_installations.installed_by_user_id=? AND github_installations.status='active' AND github_repositories.authorization_status='authorized' ORDER BY github_repositories.owner_login, github_repositories.name",
  ).bind(session.userId).all();
  return jsonResponse({ repositories: rows.results });
}

interface QueueCollectionImportInput {
  readonly organizerUserId: string;
  readonly githubRepositoryId: number;
  readonly requestedRef: string;
  readonly commitSha: string;
  readonly indexPath: string;
  readonly retryOfImportId?: string;
}

async function queueCollectionImport(
  env: ForgeWorkerEnv,
  input: QueueCollectionImportInput,
): Promise<{ readonly importId: string; readonly status: string; readonly replayed: boolean }> {
  await requireFormalMutationsEnabled(env);
  const activeRelease = await assertActiveRelease(env.DB, env.JUDGE_BUCKET, env.ENVIRONMENT, env.FORGE_RELEASE_ID, env.FORGE_RELEASE_MANIFEST_SHA256);
  const importId = crypto.randomUUID();
  const now = new Date().toISOString();
  const parameters: ValidationWorkflowParameters = {
    importId,
    expectedReleaseId: env.FORGE_RELEASE_ID,
    expectedManifestSha256: env.FORGE_RELEASE_MANIFEST_SHA256,
    expectedContainerIdentitySha256: activeRelease.manifest.artifacts.containerImage.identitySha256,
  };
  const workflowPayloadJson = validationWorkflowOutboxJson(parameters);
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO collection_imports
        (id, organizer_user_id, github_repository_id, requested_ref, commit_sha, index_path, forge_release_id, retry_of_import_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).bind(
        importId,
        input.organizerUserId,
        input.githubRepositoryId,
        input.requestedRef,
        input.commitSha,
        input.indexPath,
        env.FORGE_RELEASE_ID,
        input.retryOfImportId ?? null,
        now,
        now,
      ),
      env.DB.prepare("INSERT INTO outbox (id, kind, aggregate_id, payload_json, created_at) VALUES (?, 'start-validation-workflow', ?, ?, ?)")
        .bind(crypto.randomUUID(), importId, workflowPayloadJson, now),
    ]);
  } catch (error) {
    const existing = input.retryOfImportId
      ? await env.DB.prepare("SELECT id, status FROM collection_imports WHERE retry_of_import_id=?")
        .bind(input.retryOfImportId).first<{ id: string; status: string }>()
      : await env.DB.prepare(`SELECT id, status FROM collection_imports
          WHERE github_repository_id=? AND commit_sha=? AND index_path=? AND forge_release_id=? AND retry_of_import_id IS NULL`)
        .bind(input.githubRepositoryId, input.commitSha, input.indexPath, env.FORGE_RELEASE_ID).first<{ id: string; status: string }>();
    if (existing) return { importId: existing.id, status: existing.status, replayed: true };
    throw error;
  }
  try {
    await deliverValidationWorkflowOutbox(env, importId, workflowPayloadJson);
    await env.DB.prepare("UPDATE outbox SET delivered_at=?, attempts=attempts+1 WHERE kind='start-validation-workflow' AND aggregate_id=?")
      .bind(new Date().toISOString(), importId).run();
  } catch {
    operationalLog("warn", {
      event: "workflow.delivery-deferred",
      outcome: "deferred",
      environment: env.ENVIRONMENT,
      aggregateType: "import",
      aggregateId: importId,
    });
  }
  return { importId, status: "queued", replayed: false };
}

export async function createCollectionImport(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const body = exactObject(await readJsonBody(request, 32 * 1024), ["githubRepositoryId", "ref"], ["indexPath"]);
  if (!Number.isSafeInteger(body.githubRepositoryId) || (body.githubRepositoryId as number) < 1 || typeof body.ref !== "string" || body.ref.length < 1 || body.ref.length > 256 || /[\u0000-\u001f\u007f]/.test(body.ref)) {
    throw new ApiError(400, "collection-import-invalid", "Repository or ref is invalid.");
  }
  const indexPath = normalizedIndexPath(body.indexPath ?? "collection/index.json");
  const repository = await env.DB.prepare(
    "SELECT github_repositories.* FROM github_repositories JOIN github_installations ON github_installations.installation_id=github_repositories.installation_id WHERE github_repositories.github_repository_id=? AND github_installations.installed_by_user_id=? AND github_installations.status='active' AND github_repositories.authorization_status='authorized'",
  ).bind(body.githubRepositoryId, session.userId).first<RepositoryRow>();
  if (!repository) throw new ApiError(404, "github-repository-not-found", "Authorized GitHub repository was not found.");
  const token = await githubInstallationToken(env, repository.installation_id);
  const numericRepository = await githubApiJson<Record<string, unknown>>(`/repositories/${repository.github_repository_id}`, token);
  let coordinates: { readonly owner: string; readonly repository: string };
  try {
    coordinates = githubRepositoryCoordinates(
      numericRepository,
      repository.github_repository_id,
      repository.owner_login,
      repository.name,
    );
  } catch {
    throw new ApiError(409, "github-repository-rebound", "The numeric GitHub repository identity changed; reconnect the installation before importing.");
  }
  const commit = await githubApiJson<Record<string, unknown>>(`/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repository)}/commits/${encodeURIComponent(body.ref)}`, token);
  if (typeof commit.sha !== "string" || !COMMIT_PATTERN.test(commit.sha)) throw new ApiError(502, "github-commit-invalid", "GitHub did not resolve ref to an exact commit.");
  const existing = await env.DB.prepare(`SELECT id, status FROM collection_imports
      WHERE github_repository_id=? AND commit_sha=? AND index_path=? AND forge_release_id=?
      ORDER BY created_at DESC LIMIT 1`)
    .bind(repository.github_repository_id, commit.sha, indexPath, env.FORGE_RELEASE_ID).first<{ id: string; status: string }>();
  if (existing) return jsonResponse({ importId: existing.id, commitSha: commit.sha, status: existing.status, replayed: true });
  const result = await queueCollectionImport(env, {
    organizerUserId: session.userId,
    githubRepositoryId: repository.github_repository_id,
    requestedRef: body.ref,
    commitSha: commit.sha,
    indexPath,
  });
  return jsonResponse({ ...result, commitSha: commit.sha }, result.replayed ? 200 : 202);
}

export async function retryCollectionImport(request: Request, env: ForgeWorkerEnv, importId: string): Promise<Response> {
  const session = await requireMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  exactObject(await readJsonBody(request, 1_024), []);
  const source = await env.DB.prepare(`SELECT collection_imports.* FROM collection_imports
      JOIN github_repositories ON github_repositories.github_repository_id=collection_imports.github_repository_id
      JOIN github_installations ON github_installations.installation_id=github_repositories.installation_id
      WHERE collection_imports.id=? AND collection_imports.organizer_user_id=?
        AND github_installations.installed_by_user_id=? AND github_installations.status='active'
        AND github_repositories.authorization_status='authorized'`)
    .bind(importId, session.userId, session.userId).first<ImportRow>();
  if (!source) throw new ApiError(404, "collection-import-not-found", "Collection import was not found.");
  if (source.status !== "infrastructure-error") throw new ApiError(409, "collection-import-not-retryable", "Only infrastructure errors can be retried.");
  const existing = await env.DB.prepare("SELECT id, status FROM collection_imports WHERE retry_of_import_id=?")
    .bind(source.id).first<{ id: string; status: string }>();
  if (existing) return jsonResponse({ importId: existing.id, commitSha: source.commit_sha, status: existing.status, replayed: true, retryOfImportId: source.id });
  const result = await queueCollectionImport(env, {
    organizerUserId: session.userId,
    githubRepositoryId: source.github_repository_id,
    requestedRef: source.requested_ref,
    commitSha: source.commit_sha,
    indexPath: source.index_path,
    retryOfImportId: source.id,
  });
  return jsonResponse({ ...result, commitSha: source.commit_sha, retryOfImportId: source.id }, result.replayed ? 200 : 202);
}

export async function getCollectionImport(request: Request, env: ForgeWorkerEnv, importId: string): Promise<Response> {
  const session = await requireSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const row = await env.DB.prepare("SELECT * FROM collection_imports WHERE id=? AND organizer_user_id=?")
    .bind(importId, session.userId).first<ImportRow>();
  if (!row) throw new ApiError(404, "collection-import-not-found", "Collection import was not found.");
  return jsonResponse({ import: row, review: await collectionImportReview(env, row) });
}

export async function listCollectionImports(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const rows = await env.DB.prepare("SELECT id, github_repository_id, commit_sha, index_path, forge_release_id, retry_of_import_id, status, error_code, validation_report_r2_key, canonical_draft_delete_after, canonical_expired_at, created_at, updated_at FROM collection_imports WHERE organizer_user_id=? ORDER BY created_at DESC LIMIT 50")
    .bind(session.userId).all();
  return jsonResponse({ imports: rows.results });
}

async function verifiedProjection(
  env: ForgeWorkerEnv,
  reference: ProjectionReference,
): Promise<Uint8Array> {
  if (reference.bytes > 32 * 1024 * 1024) throw new ApiError(500, "projection-integrity", "A managed projection exceeds 32 MiB.");
  const object = await env.JUDGE_BUCKET.get(reference.key);
  if (
    !object
    || object.size !== reference.bytes
    || object.customMetadata?.sha256 !== reference.digest
  ) throw new ApiError(500, "projection-integrity", "A managed projection has invalid metadata.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== reference.bytes || await sha256Hex(bytes) !== reference.digest) {
    throw new ApiError(500, "projection-integrity", "A managed projection failed read-back hashing.");
  }
  return bytes;
}

async function verifiedContentAddress(env: ForgeWorkerEnv, key: string): Promise<Uint8Array> {
  const match = /^snapshots\/objects\/([0-9a-f]{64})$/.exec(key);
  if (!match) throw new ApiError(500, "projection-integrity", "A managed object key is not content addressed.");
  const primary = await env.JUDGE_BUCKET.head(key);
  if (!primary || primary.size < 1 || primary.size > 32 * 1024 * 1024) throw new ApiError(500, "projection-integrity", "A managed object has an invalid size.");
  return verifiedProjection(env, { key, digest: match[1]!, bytes: primary.size });
}

async function collectionImportReview(env: ForgeWorkerEnv, imported: ImportRow): Promise<null | Record<string, unknown>> {
  if (imported.status !== "valid" || !imported.validation_report_r2_key) return null;
  const reportBytes = await verifiedContentAddress(env, imported.validation_report_r2_key);
  let report: ValidationReport;
  try {
    report = parseValidationReport(canonicalValue(reportBytes, "validation report"), {
      importId: imported.id,
      forgeReleaseId: imported.forge_release_id,
    });
  } catch {
    throw new ApiError(500, "validation-report-invalid", "Validation report failed its review contract.");
  }
  const superseded = await env.DB.prepare(`SELECT managed_snapshots.id, managed_snapshots.collection_revision, managed_snapshots.published_at
      FROM managed_snapshots
      JOIN collection_imports ON collection_imports.id=managed_snapshots.import_id
      WHERE managed_snapshots.mode='official-practice' AND managed_snapshots.status='published'
        AND collection_imports.github_repository_id=?
      ORDER BY managed_snapshots.published_at DESC`)
    .bind(imported.github_repository_id).all<{ id: string; collection_revision: string; published_at: string | null }>();
  return {
    collectionRevision: report.collectionRevision,
    problemCount: report.problemCount,
    checks: report.checks,
    problems: report.outputs.map((output) => ({
      slug: output.id,
      number: output.number,
      title: output.title,
      difficulty: output.difficulty,
      tags: output.tags,
      bundleDigest: output.bundleDigest,
      allowedLanguages: Object.keys(output.allowedProfiles).sort(),
    })),
    officialPracticeSupersedes: superseded.results.map((snapshot) => ({
      snapshotId: snapshot.id,
      collectionRevision: snapshot.collection_revision,
      publishedAt: snapshot.published_at,
    })),
  };
}

function canonicalValue(bytes: Uint8Array, label: string): unknown {
  try {
    return parseCanonicalJsonBytes(bytes, label);
  } catch {
    throw new ApiError(500, "projection-integrity", `${label} is not valid canonical JSON.`);
  }
}

async function publicationSource(
  env: ForgeWorkerEnv,
  imported: ImportRow,
  report: ValidationReport,
  manifestBytes: Uint8Array,
): Promise<{ readonly source: ForgeValidationSource; readonly verified: VerifiedValidationSource }> {
  let source: ForgeValidationSource;
  try {
    source = await verifyForgeValidationSourceBytes(manifestBytes, imported.canonical_source_sha256!);
  } catch {
    throw new ApiError(500, "canonical-source-integrity", "Canonical validation source is invalid.");
  }
  if (
    source.provenance.githubRepositoryId !== imported.github_repository_id
    || source.provenance.commitSha !== imported.commit_sha
    || source.provenance.indexPath !== imported.index_path
    || source.collectionRevision !== report.collectionRevision
    || report.canonicalSource.manifest.key !== imported.canonical_source_r2_key
    || report.canonicalSource.manifest.digest !== imported.canonical_source_sha256
    || report.canonicalSource.manifest.bytes !== manifestBytes.byteLength
  ) throw new ApiError(500, "canonical-source-integrity", "Canonical source provenance or report binding is inconsistent.");
  if (
    report.canonicalSource.objects.length !== source.objects.length
    || source.objects.some((item, index) => {
      const reported = report.canonicalSource.objects[index];
      return !reported || reported.key !== `snapshots/objects/${item.sha256}` || reported.digest !== item.sha256 || reported.bytes !== item.bytes;
    })
  ) throw new ApiError(500, "canonical-source-integrity", "Validation report does not bind the exact canonical object inventory.");

  const load = (reference: { readonly sha256: string; readonly bytes: number }) => verifiedProjection(env, {
    key: `snapshots/objects/${reference.sha256}`,
    digest: reference.sha256,
    bytes: reference.bytes,
  });
  const [indexBytes, managedBytes] = await Promise.all([load(source.index), load(source.managed)]);
  let index;
  let managed;
  try {
    index = parseProblemCollectionIndex(canonicalValue(indexBytes, "canonical collection index"));
    await verifyProblemCollectionRevision(index);
    managed = parseManagedCollectionContract(canonicalValue(managedBytes, "canonical managed collection"));
  } catch {
    throw new ApiError(500, "canonical-source-integrity", "Canonical collection contracts failed publication verification.");
  }
  if (index.revision !== source.collectionRevision || managed.collectionRevision !== source.collectionRevision || index.problems.length !== source.problems.length || managed.problems.length !== source.problems.length) {
    throw new ApiError(500, "canonical-source-integrity", "Canonical collection inventories disagree.");
  }
  const bundleBytes = await Promise.all(source.problems.map((problem) => load(problem.bundle)));
  const problems = [];
  try {
    for (const [problemIndex, declared] of source.problems.entries()) {
      const entry = index.problems[problemIndex];
      const managedProblem = managed.problems[problemIndex];
      const bytes = bundleBytes[problemIndex];
      if (!entry || !managedProblem || !bytes || declared.id !== entry.id || declared.id !== managedProblem.id || declared.bundle.sha256 !== entry.bundle.sha256 || declared.bundle.bytes !== entry.bundle.bytes) {
        throw new TypeError("Canonical problem inventory is inconsistent.");
      }
      problems.push({ problem: await verifyProblemBundleBytes(bytes, entry), managed: managedProblem });
    }
  } catch {
    throw new ApiError(500, "canonical-source-integrity", "Canonical problem bundles failed publication verification.");
  }
  return {
    source,
    verified: { index, managed, problems, repositoryFiles: new Map() },
  };
}

export async function publishCollectionImport(request: Request, env: ForgeWorkerEnv, importId: string): Promise<Response> {
  const session = await requireMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const body = exactObject(await readJsonBody(request, 8 * 1024), ["mode"]);
  if (body.mode !== "official-practice" && body.mode !== "contest") throw new ApiError(400, "snapshot-mode-invalid", "mode must be official-practice or contest.");
  const result = await publishValidatedCollectionImport(env, {
    importId,
    organizerUserId: session.userId,
    mode: body.mode,
  });
  return jsonResponse(result, result.replayed ? 200 : 201);
}

export interface ManagedCollectionPublication {
  readonly snapshotId: string;
  readonly collectionRevision?: string;
  readonly mode?: "official-practice" | "contest";
  readonly status: string;
  readonly supersededSnapshotIds?: readonly string[];
  readonly problems?: readonly {
    readonly id: string;
    readonly slug: string;
    readonly number: number;
    readonly title: { readonly "zh-TW": string; readonly en: string };
    readonly allowedProfiles: Readonly<Record<string, { readonly target: "wasip1" | "wasix"; readonly optimization: "debug" | "release" }>>;
  }[];
  readonly replayed: boolean;
}

/**
 * Publish one already-validated immutable import. Organizer HTTP routes and the
 * staging fixture control use this single verifier and transaction.
 */
export async function publishValidatedCollectionImport(env: ForgeWorkerEnv, input: {
  readonly importId: string;
  readonly organizerUserId: string;
  readonly mode: "official-practice" | "contest";
}): Promise<ManagedCollectionPublication> {
  const { importId } = input;
  const imported = await env.DB.prepare("SELECT * FROM collection_imports WHERE id=? AND organizer_user_id=?")
    .bind(importId, input.organizerUserId).first<ImportRow>();
  if (!imported || imported.status !== "valid" || !imported.validation_report_r2_key) throw new ApiError(409, "collection-not-publishable", "Collection import has not passed validation.");
  const existing = await env.DB.prepare("SELECT id, status FROM managed_snapshots WHERE import_id=? AND mode=?")
    .bind(importId, input.mode).first<{ id: string; status: string }>();
  if (existing) return { snapshotId: existing.id, status: existing.status, replayed: true };
  if (imported.canonical_expired_at || !imported.canonical_draft_delete_after || imported.canonical_draft_delete_after <= new Date().toISOString()) {
    throw new ApiError(409, "collection-import-expired", "The unpublished canonical validation draft has expired.");
  }
  if (!imported.canonical_source_r2_key || !imported.canonical_source_sha256) throw new ApiError(500, "canonical-source-missing", "Canonical validation source is missing.");
  if (imported.canonical_source_r2_key !== `snapshots/objects/${imported.canonical_source_sha256}`) throw new ApiError(500, "canonical-source-integrity", "Canonical validation source identity is inconsistent.");
  const manifestBytes = await verifiedContentAddress(env, imported.canonical_source_r2_key);
  const reportBytes = await verifiedContentAddress(env, imported.validation_report_r2_key);
  let report: ValidationReport;
  try {
    report = parseValidationReport(canonicalValue(reportBytes, "validation report"), {
      importId,
      forgeReleaseId: imported.forge_release_id,
    });
  } catch {
    throw new ApiError(500, "validation-report-invalid", "Validation report failed its exact publication contract.");
  }
  const { source, verified } = await publicationSource(env, imported, report, manifestBytes);
  const projectionReferences = [
    report.projections.practice,
    report.projections.contestPublic,
    report.projections.judge,
    ...report.outputs.flatMap((output) => [output.practice, output.contestPublic, output.judge]),
  ];
  const projectionValues = new Map<string, unknown>();
  for (const reference of projectionReferences) {
    if (projectionValues.has(reference.key)) continue;
    projectionValues.set(reference.key, canonicalValue(await verifiedProjection(env, reference), "managed projection"));
  }
  try {
    verifyManagedProjectionBindings(report, source, verified, projectionValues);
  } catch {
    throw new ApiError(500, "projection-role-integrity", "Managed projections failed role, release, revision, or canonical bundle binding.");
  }
  const snapshotId = crypto.randomUUID();
  const now = new Date().toISOString();
  const problemVersions = report.outputs.map((output) => ({ id: crypto.randomUUID(), output }));
  const previousSnapshots = input.mode === "official-practice"
    ? (await env.DB.prepare(`SELECT managed_snapshots.id FROM managed_snapshots
        JOIN collection_imports ON collection_imports.id=managed_snapshots.import_id
        WHERE managed_snapshots.mode='official-practice' AND managed_snapshots.status='published'
          AND collection_imports.github_repository_id=?`)
      .bind(imported.github_repository_id).all<{ id: string }>()).results
    : [];
  await requireFormalMutationsEnabled(env);
  await assertActiveRelease(env.DB, env.JUDGE_BUCKET, env.ENVIRONMENT, env.FORGE_RELEASE_ID, env.FORGE_RELEASE_MANIFEST_SHA256);
  const requiredStatements = [
      env.DB.prepare("UPDATE collection_imports SET canonical_draft_delete_after=NULL, canonical_expired_at=NULL, updated_at=? WHERE id=? AND status='valid' AND canonical_expired_at IS NULL AND canonical_draft_delete_after>? AND canonical_source_r2_key=? AND canonical_source_sha256=?")
        .bind(now, importId, now, imported.canonical_source_r2_key, imported.canonical_source_sha256),
      env.DB.prepare("INSERT INTO managed_snapshots (id, import_id, mode, collection_revision, practice_projection_digest, contest_public_projection_digest, judge_projection_digest, status, published_at, published_by, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ? FROM collection_imports WHERE id=? AND status='valid' AND canonical_draft_delete_after IS NULL AND canonical_source_r2_key=? AND canonical_source_sha256=?")
        .bind(snapshotId, importId, input.mode, report.collectionRevision, report.projections.practice.digest, report.projections.contestPublic.digest, report.projections.judge.digest, now, input.organizerUserId, now, importId, imported.canonical_source_r2_key, imported.canonical_source_sha256),
      ...problemVersions.map(({ id, output }) => env.DB.prepare("INSERT INTO managed_problem_versions (id, snapshot_id, problem_slug, problem_number, title_json, difficulty, tags_json, track_id, track_json, bundle_digest, allowed_languages_json, compile_profiles_json, public_projection_r2_key, judge_projection_r2_key, maximum_score, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100, ? WHERE EXISTS (SELECT 1 FROM managed_snapshots WHERE id=? AND import_id=? AND status='published')")
        .bind(id, snapshotId, output.id, output.number, JSON.stringify(output.title), output.difficulty, JSON.stringify(output.tags), output.trackId, JSON.stringify(output.track), output.bundleDigest, JSON.stringify(Object.keys(output.allowedProfiles).sort()), JSON.stringify(output.allowedProfiles), input.mode === "official-practice" ? output.practice.key : output.contestPublic.key, output.judge.key, now, snapshotId, importId)),
  ];
  const optionalStatements = input.mode === "official-practice" ? [
      env.DB.prepare(`UPDATE managed_snapshots SET status='superseded'
        WHERE id<>? AND mode='official-practice' AND status='published'
          AND import_id IN (SELECT id FROM collection_imports WHERE github_repository_id=?)
          AND EXISTS (SELECT 1 FROM managed_snapshots successor WHERE successor.id=? AND successor.status='published')`)
        .bind(snapshotId, imported.github_repository_id, snapshotId),
  ] : [];
  const results = await env.DB.batch([...requiredStatements, ...optionalStatements]);
  if (results.slice(0, requiredStatements.length).some((result) => result.meta.changes !== 1)) throw new Error("Collection publication lost its canonical-source fence.");
  return {
    snapshotId,
    collectionRevision: report.collectionRevision,
    mode: input.mode,
    status: "published",
    ...(previousSnapshots.length > 0 ? { supersededSnapshotIds: previousSnapshots.map((snapshot) => snapshot.id) } : {}),
    problems: problemVersions.map(({ id, output }) => ({ id, slug: output.id, number: output.number, title: output.title, allowedProfiles: output.allowedProfiles })),
    replayed: false,
  };
}

export async function githubWebhook(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const delivery = await verifyGithubWebhook(request, env);
  const now = new Date().toISOString();
  const bodySha256 = await sha256Hex(delivery.body);
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO github_webhook_deliveries (delivery_id, event_name, body_sha256, received_at, updated_at, outcome) VALUES (?, ?, ?, ?, ?, 'processing')")
    .bind(delivery.deliveryId, delivery.eventName, bodySha256, now, now).run();
  if (inserted.meta.changes === 0) {
    const existing = await env.DB.prepare("SELECT event_name, body_sha256, updated_at, outcome FROM github_webhook_deliveries WHERE delivery_id=?")
      .bind(delivery.deliveryId).first<{ readonly event_name: string; readonly body_sha256: string; readonly updated_at: string; readonly outcome: string }>();
    if (!existing || existing.event_name !== delivery.eventName || existing.body_sha256 !== bodySha256) {
      throw new ApiError(409, "github-webhook-delivery-conflict", "GitHub reused a delivery identity for different bytes.");
    }
    if (existing.outcome === "accepted") return jsonResponse({ accepted: true, replayed: true });
    const staleProcessing = existing.outcome === "processing" && Date.parse(existing.updated_at) <= Date.now() - 5 * 60 * 1_000;
    if (existing.outcome !== "failed" && !staleProcessing) {
      throw new ApiError(503, "github-webhook-processing", "This GitHub delivery is still being processed.");
    }
    const reclaimed = await env.DB.prepare("UPDATE github_webhook_deliveries SET outcome='processing', attempts=attempts+1, updated_at=? WHERE delivery_id=? AND event_name=? AND body_sha256=? AND (outcome='failed' OR (outcome='processing' AND updated_at<=?))")
      .bind(now, delivery.deliveryId, delivery.eventName, bodySha256, new Date(Date.now() - 5 * 60 * 1_000).toISOString()).run();
    if (reclaimed.meta.changes !== 1) throw new ApiError(503, "github-webhook-processing", "This GitHub delivery is still being processed.");
  }
  const payload = delivery.payload;
  const installation = payload.installation as Record<string, unknown> | undefined;
  const installationId = Number(installation?.id);
  try {
    if (delivery.eventName === "installation") {
      if (!Number.isSafeInteger(installationId) || installationId < 1) {
        throw new ApiError(400, "github-installation-event-invalid", "GitHub installation event is missing a valid installation ID.");
      }
      const action = payload.action;
      if (action === "created") {
        const sender = payload.sender as Record<string, unknown> | undefined;
        const account = installation?.account as Record<string, unknown> | undefined;
        const senderId = sender?.id;
        const accountId = account?.id;
        if (
          installation?.app_id !== configuredGithubAppId(env)
          || !Number.isSafeInteger(senderId)
          || (senderId as number) < 1
          || !Number.isSafeInteger(accountId)
          || (accountId as number) < 1
        ) {
          throw new ApiError(400, "github-installation-proof-invalid", "GitHub installation ownership payload is invalid.");
        }
        await recordGithubInstallationCreatedProof(env.DB, {
          installationId,
          installerGithubUserId: senderId as number,
          accountGithubId: accountId as number,
          deliveryId: delivery.deliveryId,
          receivedAt: now,
          expiresAt: new Date(Date.parse(now) + GITHUB_INSTALLATION_PROOF_SECONDS * 1_000).toISOString(),
        });
      } else {
        if (installation?.app_id !== configuredGithubAppId(env)) {
          throw new ApiError(400, "github-installation-event-invalid", "GitHub installation event targets another App.");
        }
      }
      if (action === "deleted" || action === "suspend") {
        await env.DB.prepare("UPDATE github_installations SET status=?, authority_generation=authority_generation+1, updated_at=? WHERE installation_id=?")
          .bind(action === "deleted" ? "removed" : "suspended", now, installationId).run();
      } else if (action === "new_permissions_accepted" || action === "unsuspend") {
        let authorization: ReturnType<typeof githubReadOnlyInstallationAuthorization> | null = null;
        try {
          authorization = githubReadOnlyInstallationAuthorization(installation?.permissions, installation?.repository_selection);
        } catch {
          await env.DB.prepare("UPDATE github_installations SET status='suspended', authority_generation=authority_generation+1, updated_at=? WHERE installation_id=? AND status!='removed'")
            .bind(now, installationId).run();
        }
        if (authorization && action === "new_permissions_accepted") {
          await env.DB.prepare(
            "UPDATE github_installations SET permissions_json=?, repository_selection=?, authority_generation=authority_generation+1, updated_at=? WHERE installation_id=? AND status!='removed'",
          ).bind(authorization.permissionsJson, authorization.repositorySelection, now, installationId).run();
        } else if (authorization) {
          await env.DB.prepare(
            `UPDATE github_installations
                SET status='active', permissions_json=?, repository_selection=?,
                    authority_generation=authority_generation+1, updated_at=?
              WHERE installation_id=? AND installed_by_user_id IS NOT NULL AND status='suspended'
                AND EXISTS (
                  SELECT 1 FROM github_installation_claim_proofs
                   WHERE installation_id=? AND claimed_at IS NOT NULL AND activated_at IS NOT NULL
                )`,
          ).bind(authorization.permissionsJson, authorization.repositorySelection, now, installationId, installationId).run();
        }
      }
    } else if (delivery.eventName === "installation_repositories" && Number.isSafeInteger(installationId) && installationId > 0) {
      for (const repository of Array.isArray(payload.repositories_added) ? payload.repositories_added : []) await upsertRepository(env, installationId, repository);
      for (const value of Array.isArray(payload.repositories_removed) ? payload.repositories_removed : []) {
        const repository = value as Record<string, unknown>;
        if (Number.isSafeInteger(repository.id)) await env.DB.prepare("UPDATE github_repositories SET authorization_status='removed', updated_at=? WHERE github_repository_id=? AND installation_id=?")
          .bind(now, repository.id, installationId).run();
      }
    } else if (delivery.eventName === "push") {
      const repository = payload.repository as Record<string, unknown> | undefined;
      if (Number.isSafeInteger(repository?.id) && typeof payload.after === "string" && COMMIT_PATTERN.test(payload.after) && typeof payload.ref === "string") {
        const repositoryId = repository!.id as number;
        await env.DB.prepare("INSERT INTO repository_push_notices (id, github_repository_id, commit_sha, ref, received_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM github_repositories WHERE github_repository_id=? AND authorization_status='authorized')")
          .bind(crypto.randomUUID(), repositoryId, payload.after, payload.ref, now, repositoryId).run();
      }
    }
    await env.DB.prepare("UPDATE github_webhook_deliveries SET outcome='accepted', updated_at=? WHERE delivery_id=? AND event_name=? AND body_sha256=? AND outcome='processing'")
      .bind(new Date().toISOString(), delivery.deliveryId, delivery.eventName, bodySha256).run();
    return jsonResponse({ accepted: true, replayed: false });
  } catch (error) {
    await env.DB.prepare("UPDATE github_webhook_deliveries SET outcome='failed', updated_at=? WHERE delivery_id=? AND event_name=? AND body_sha256=? AND outcome='processing'")
      .bind(new Date().toISOString(), delivery.deliveryId, delivery.eventName, bodySha256).run();
    throw error;
  }
}

export async function organizerStatus(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const organizer = Boolean(session?.roles.includes("organizer") || session?.roles.includes("admin"));
  const application = session && !organizer
    ? await env.DB.prepare("SELECT id, status, created_at, reviewed_at, review_note FROM organizer_applications WHERE user_id=? ORDER BY created_at DESC LIMIT 1").bind(session.userId).first<{
      id: string;
      status: "pending" | "approved" | "rejected";
      created_at: string;
      reviewed_at: string | null;
      review_note: string | null;
    }>()
    : undefined;
  const access = !session
    ? "signed-out"
    : organizer
      ? "active"
      : application?.status === "pending"
        ? "pending"
        : application?.status === "rejected"
          ? "rejected"
          : application?.status === "approved"
            ? "revoked"
            : "eligible";
  return jsonResponse({ authenticated: Boolean(session), organizer, access, application: application ?? null });
}
