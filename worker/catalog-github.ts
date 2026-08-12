import type { AuthenticatedSession, WasmOjWorkerEnv } from "./env";
import { githubApiJson, githubApiRaw, githubInstallationToken, githubRepositoryCoordinates } from "./github";
import { ApiError, readBoundedResponseBytes } from "./http";
import { sha256Hex } from "./crypto";

const COMMIT = /^[0-9a-f]{40}$/;
const GIT_OBJECT = /^[0-9a-f]{40}$/;
const NORMALIZED_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000-\u001f\u007f]+$/;

export interface AuthorizedCatalogRepository {
  readonly githubRepositoryId: number;
  readonly installationId: number;
  readonly owner: string;
  readonly repository: string;
  readonly isPrivate: boolean;
  readonly token: string;
}

export interface ExactGitBlob {
  readonly path: string;
  readonly gitSha: string;
  readonly bytes: number;
}

interface RepositoryRow {
  readonly github_repository_id: number;
  readonly installation_id: number;
  readonly owner_login: string;
  readonly name: string;
  readonly is_private: number;
}

interface GitTreeEntry {
  readonly path?: unknown;
  readonly mode?: unknown;
  readonly type?: unknown;
  readonly sha?: unknown;
  readonly size?: unknown;
}

interface GitCommitObject {
  readonly tree?: unknown;
}

export function normalizeRepositoryPath(value: unknown, label = "repository path"): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || !NORMALIZED_PATH.test(value)) {
    throw new TypeError(`${label} must be a normalized relative POSIX path.`);
  }
  return value;
}

export function relativeRepositoryPath(indexPath: string, relativePath: string): string {
  normalizeRepositoryPath(indexPath, "index path");
  normalizeRepositoryPath(relativePath, "declared path");
  const slash = indexPath.lastIndexOf("/");
  return normalizeRepositoryPath(`${slash < 0 ? "" : indexPath.slice(0, slash + 1)}${relativePath}`, "resolved declared path");
}

export async function authorizedCatalogRepository(
  env: WasmOjWorkerEnv,
  session: AuthenticatedSession,
  githubRepositoryId: number,
): Promise<AuthorizedCatalogRepository> {
  const row = await env.DB.prepare(`SELECT repositories.github_repository_id, repositories.installation_id,
      repositories.owner_login, repositories.name, repositories.is_private
    FROM github_repositories AS repositories
    JOIN github_installations AS installations ON installations.installation_id=repositories.installation_id
    WHERE repositories.github_repository_id=? AND installations.installed_by_user_id=?
      AND installations.status='active' AND repositories.authorization_status='authorized'`)
    .bind(githubRepositoryId, session.userId).first<RepositoryRow>();
  if (!row) throw new ApiError(404, "github-repository-not-found", "Authorized GitHub repository was not found.");
  return catalogRepositoryFromRow(env, row);
}

async function catalogRepositoryFromRow(env: WasmOjWorkerEnv, row: RepositoryRow): Promise<AuthorizedCatalogRepository> {
  const token = await githubInstallationToken(env, row.installation_id);
  const numeric = await githubApiJson<Record<string, unknown>>(`/repositories/${row.github_repository_id}`, token);
  let coordinates: { readonly owner: string; readonly repository: string };
  try {
    coordinates = githubRepositoryCoordinates(numeric, row.github_repository_id, row.owner_login, row.name);
  } catch {
    throw new ApiError(409, "github-repository-rebound", "The numeric GitHub repository identity changed; reconnect the installation.");
  }
  return {
    githubRepositoryId: row.github_repository_id,
    installationId: row.installation_id,
    owner: coordinates.owner,
    repository: coordinates.repository,
    isPrivate: row.is_private === 1,
    token,
  };
}

export async function catalogRepositoryById(
  env: WasmOjWorkerEnv,
  githubRepositoryId: number,
): Promise<AuthorizedCatalogRepository> {
  const row = await env.DB.prepare(`SELECT repositories.github_repository_id, repositories.installation_id,
      repositories.owner_login, repositories.name, repositories.is_private
    FROM github_repositories AS repositories
    JOIN github_installations AS installations ON installations.installation_id=repositories.installation_id
    WHERE repositories.github_repository_id=? AND installations.status='active'
      AND installations.installed_by_user_id IS NOT NULL
      AND repositories.authorization_status='authorized'`)
    .bind(githubRepositoryId).first<RepositoryRow>();
  if (!row) throw new ApiError(404, "github-repository-not-found", "Authorized GitHub repository was not found.");
  return catalogRepositoryFromRow(env, row);
}

export async function resolveExactCommit(repository: AuthorizedCatalogRepository, ref: string): Promise<string> {
  if (!ref || ref.length > 256 || /[\u0000-\u001f\u007f]/.test(ref)) throw new TypeError("Git ref is invalid.");
  const commit = await githubApiJson<Record<string, unknown>>(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/commits/${encodeURIComponent(ref)}`,
    repository.token,
  );
  if (typeof commit.sha !== "string" || !COMMIT.test(commit.sha)) throw new ApiError(502, "github-commit-invalid", "GitHub did not resolve ref to an exact commit.");
  return commit.sha;
}

export async function exactCommitTree(
  repository: AuthorizedCatalogRepository,
  commitSha: string,
): Promise<ReadonlyMap<string, ExactGitBlob>> {
  if (!COMMIT.test(commitSha)) throw new TypeError("Exact commit SHA is invalid.");
  const commit = await githubApiJson<GitCommitObject>(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/git/commits/${commitSha}`,
    repository.token,
  );
  const commitTree = commit.tree;
  if (
    !commitTree
    || typeof commitTree !== "object"
    || Array.isArray(commitTree)
    || typeof (commitTree as { readonly sha?: unknown }).sha !== "string"
    || !GIT_OBJECT.test((commitTree as { readonly sha: string }).sha)
  ) {
    throw new ApiError(502, "github-commit-invalid", "GitHub commit object did not identify an exact tree.");
  }
  const treeSha = (commitTree as { readonly sha: string }).sha;
  const response = await githubApiJson<{ readonly truncated?: unknown; readonly tree?: unknown }>(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/git/trees/${treeSha}?recursive=1`,
    repository.token,
  );
  if (response.truncated === true || !Array.isArray(response.tree)) {
    throw new ApiError(422, "github-tree-truncated", "Repository tree is too large for deterministic validation.");
  }
  const blobs = new Map<string, ExactGitBlob>();
  for (const candidate of response.tree as GitTreeEntry[]) {
    if (candidate.type !== "blob" || (candidate.mode !== "100644" && candidate.mode !== "100755")) continue;
    if (
      typeof candidate.path !== "string" || !NORMALIZED_PATH.test(candidate.path) || candidate.path.length > 512
      || typeof candidate.sha !== "string" || !GIT_OBJECT.test(candidate.sha)
      || !Number.isSafeInteger(candidate.size) || (candidate.size as number) < 0
    ) continue;
    if (blobs.has(candidate.path)) throw new ApiError(422, "github-tree-duplicate", "Repository tree contains a duplicate path.");
    blobs.set(candidate.path, { path: candidate.path, gitSha: candidate.sha, bytes: candidate.size as number });
  }
  return blobs;
}

export function declaredBlob(
  tree: ReadonlyMap<string, ExactGitBlob>,
  path: string,
  expectedBytes: number,
  maximumBytes: number,
): ExactGitBlob {
  const normalized = normalizeRepositoryPath(path);
  const blob = tree.get(normalized);
  if (!blob || blob.bytes !== expectedBytes || blob.bytes < 1 || blob.bytes > maximumBytes) {
    throw new ApiError(422, "declared-blob-invalid", `Declared repository object '${normalized}' is missing or has the wrong size.`);
  }
  return blob;
}

export function boundedDeclaredBlob(
  tree: ReadonlyMap<string, ExactGitBlob>,
  path: string,
  maximumBytes: number,
): ExactGitBlob {
  const normalized = normalizeRepositoryPath(path);
  const blob = tree.get(normalized);
  if (!blob || blob.bytes < 1 || blob.bytes > maximumBytes) {
    throw new ApiError(422, "declared-blob-invalid", `Repository object '${normalized}' is missing or exceeds its size limit.`);
  }
  return blob;
}

export async function readBoundedBlob(
  repository: AuthorizedCatalogRepository,
  blob: ExactGitBlob,
  maximumBytes: number,
): Promise<Uint8Array> {
  const response = await rawBlobResponse(repository, blob, maximumBytes);
  const bytes = await readBoundedResponseBytes(response, maximumBytes);
  if (bytes.byteLength !== blob.bytes) {
    bytes.fill(0);
    throw new ApiError(422, "declared-blob-size", `Repository object '${blob.path}' changed size during validation.`);
  }
  return bytes;
}

export function rawBlobResponse(
  repository: AuthorizedCatalogRepository,
  blob: ExactGitBlob,
  maximumBytes: number,
): Promise<Response> {
  return githubApiRaw(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/git/blobs/${blob.gitSha}`,
    repository.token,
    maximumBytes,
    blob.bytes,
  );
}

export async function readVerifiedBlob(
  repository: AuthorizedCatalogRepository,
  blob: ExactGitBlob,
  expectedSha256: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new TypeError("Expected GitHub blob digest is invalid.");
  const response = await rawBlobResponse(repository, blob, maximumBytes);
  const bytes = await readBoundedResponseBytes(response, maximumBytes);
  if (bytes.byteLength !== blob.bytes || await sha256Hex(bytes) !== expectedSha256) {
    bytes.fill(0);
    throw new ApiError(422, "declared-blob-digest", `Declared repository object '${blob.path}' failed SHA-256 verification.`);
  }
  return bytes;
}
