import type { AuthenticatedSession, WasmOjWorkerEnv } from "./env";
import { base64Url, constantTimeEqual, hmacSha256Hex, pemPkcs8Bytes, sha256Hex } from "./crypto";
import { ApiError, readBoundedRequestBytes, readBoundedResponseJson } from "./http";

const encoder = new TextEncoder();
const GITHUB_API_VERSION = "2022-11-28";
const MAX_GITHUB_API_JSON_BYTES = 8 * 1024 * 1024;
const MAX_GITHUB_PERMISSION_COUNT = 64;
const MAX_GITHUB_PERMISSION_JSON_BYTES = 8 * 1024;
export const MAX_GITHUB_INSTALLATION_REPOSITORY_CHANGES = 1_000;
const GITHUB_PERMISSION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const GITHUB_INSTALLATION_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{16,1024}$/;

interface GithubInstallationAuthority {
  readonly permissions_json: string;
  readonly repository_selection: string;
  readonly status: string;
  readonly authority_generation: number;
}

type GithubInstallationAuthorityCheck = () => Promise<GithubInstallationAuthority | null>;

export function githubReadOnlyPermissionsJson(permissions: unknown): string {
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    throw new ApiError(409, "github-permissions-invalid", "GitHub App permissions are missing or invalid.");
  }
  const entries = Object.entries(permissions as Record<string, unknown>);
  if (entries.length < 1 || entries.length > MAX_GITHUB_PERMISSION_COUNT) {
    throw new ApiError(409, "github-permissions-invalid", "GitHub App permissions have an invalid shape.");
  }
  const canonical: Record<string, "none" | "read"> = {};
  for (const [name, access] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!GITHUB_PERMISSION_NAME_PATTERN.test(name) || (access !== "none" && access !== "read")) {
      throw new ApiError(409, "github-permissions-excessive", "GitHub App installation permissions are not read-only.");
    }
    if (access === "read" && name !== "contents" && name !== "metadata") {
      throw new ApiError(409, "github-permissions-excessive", "GitHub App installation grants an unexpected read permission.");
    }
    canonical[name] = access;
  }
  if (canonical.contents !== "read") {
    throw new ApiError(409, "github-contents-permission", "The GitHub App installation must grant Contents: read.");
  }
  const value = JSON.stringify(canonical);
  if (encoder.encode(value).byteLength > MAX_GITHUB_PERMISSION_JSON_BYTES) {
    throw new ApiError(409, "github-permissions-invalid", "GitHub App permissions exceed the supported size.");
  }
  return value;
}

export function githubReadOnlyInstallationAuthorization(
  permissions: unknown,
  repositorySelection: unknown,
): { readonly permissionsJson: string; readonly repositorySelection: "selected" } {
  if (repositorySelection !== "selected") {
    throw new ApiError(409, "github-repository-selection", "Install the GitHub App only on selected repositories.");
  }
  return {
    permissionsJson: githubReadOnlyPermissionsJson(permissions),
    repositorySelection,
  };
}

function parseStoredGithubInstallationAuthority(value: GithubInstallationAuthority | null): GithubInstallationAuthority | null {
  if (!value || !Number.isSafeInteger(value.authority_generation) || value.authority_generation < 0) return null;
  let permissions: unknown;
  try {
    permissions = JSON.parse(value.permissions_json) as unknown;
  } catch {
    return null;
  }
  try {
    const authorization = githubReadOnlyInstallationAuthorization(permissions, value.repository_selection);
    if (authorization.permissionsJson !== value.permissions_json) return null;
    return value;
  } catch {
    return null;
  }
}

function sameGithubInstallationAuthority(
  left: GithubInstallationAuthority,
  right: GithubInstallationAuthority,
): boolean {
  return left.permissions_json === right.permissions_json
    && left.repository_selection === right.repository_selection
    && left.status === right.status
    && left.authority_generation === right.authority_generation;
}

function githubHeaders(token?: string): Headers {
  const headers = new Headers({
    accept: "application/vnd.github+json",
    "user-agent": "wasm-oj",
    "x-github-api-version": GITHUB_API_VERSION,
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

export async function githubAppJwt(env: WasmOjWorkerEnv): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: env.GITHUB_APP_ID })));
  const signingInput = `${header}.${payload}`;
  const privateKeyBytes = pemPkcs8Bytes(env.GITHUB_APP_PRIVATE_KEY);
  const privateKeyBuffer = privateKeyBytes.buffer.slice(
    privateKeyBytes.byteOffset,
    privateKeyBytes.byteOffset + privateKeyBytes.byteLength,
  ) as ArrayBuffer;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

async function suspendGithubInstallationForPermissionDrift(env: WasmOjWorkerEnv, installationId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE github_installations
        SET status='suspended', authority_generation=authority_generation+1, updated_at=?
      WHERE installation_id=? AND status!='removed'`,
  ).bind(new Date().toISOString(), installationId).run();
}

async function mintGithubInstallationToken(
  env: WasmOjWorkerEnv,
  installationId: number,
  authority: GithubInstallationAuthorityCheck,
): Promise<string> {
  const initialAuthority = parseStoredGithubInstallationAuthority(await authority());
  if (!initialAuthority) {
    throw new ApiError(403, "github-installation-inactive", "GitHub App installation is not active with the required read-only permissions.");
  }
  const requestedAt = Date.now();
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(await githubAppJwt(env)),
    redirect: "manual",
  });
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // The response is rejected regardless; cancellation is only transport cleanup.
    }
    throw new ApiError(502, "github-installation-token-error", `GitHub installation token request failed with HTTP ${response.status}.`);
  }
  let body: Record<string, unknown>;
  try {
    body = await readBoundedResponseJson(response, 64 * 1024) as Record<string, unknown>;
  } catch {
    throw new ApiError(502, "github-installation-token-error", "GitHub returned an invalid installation token response.");
  }
  const expiresAt = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
  if (
    typeof body.token !== "string"
    || !GITHUB_INSTALLATION_TOKEN_PATTERN.test(body.token)
    || !Number.isFinite(expiresAt)
    || expiresAt <= requestedAt
    || expiresAt > requestedAt + 65 * 60 * 1_000
  ) {
    throw new ApiError(502, "github-installation-token-error", "GitHub returned an invalid installation token.");
  }
  try {
    githubReadOnlyInstallationAuthorization(body.permissions, body.repository_selection);
  } catch {
    await suspendGithubInstallationForPermissionDrift(env, installationId);
    throw new ApiError(409, "github-installation-permissions-drift", "GitHub App installation permissions are no longer read-only and selected-repository scoped.");
  }
  const currentAuthority = parseStoredGithubInstallationAuthority(await authority());
  if (!currentAuthority || !sameGithubInstallationAuthority(initialAuthority, currentAuthority)) {
    throw new ApiError(403, "github-installation-inactive", "GitHub App installation authorization changed while minting its token.");
  }
  return body.token;
}

export async function githubInstallationToken(env: WasmOjWorkerEnv, installationId: number): Promise<string> {
  if (!Number.isSafeInteger(installationId) || installationId < 1) throw new TypeError("Invalid GitHub installation ID.");
  const authority = async () => env.DB.prepare(
    `SELECT permissions_json, repository_selection, status, authority_generation
       FROM github_installations
      WHERE installation_id=? AND status='active' AND installed_by_user_id IS NOT NULL`,
  ).bind(installationId).first<GithubInstallationAuthority>();
  return mintGithubInstallationToken(env, installationId, authority);
}

export async function githubInstallationProvisioningToken(
  env: WasmOjWorkerEnv,
  installationId: number,
  userId: string,
  stateHash: string,
): Promise<string> {
  if (!Number.isSafeInteger(installationId) || installationId < 1 || !/^[0-9a-f]{64}$/.test(stateHash)) {
    throw new TypeError("Invalid GitHub installation claim identity.");
  }
  const authority = async () => env.DB.prepare(
    `SELECT installations.permissions_json, installations.repository_selection,
            installations.status, installations.authority_generation
      FROM github_installations AS installations
       JOIN github_installation_claim_proofs AS proofs ON proofs.installation_id=installations.installation_id
      WHERE installations.installation_id=? AND installations.installed_by_user_id=? AND installations.status IN ('suspended', 'active')
        AND proofs.state_hash=? AND proofs.claimed_by_user_id=? AND proofs.claimed_at IS NOT NULL`,
  ).bind(installationId, userId, stateHash, userId).first<GithubInstallationAuthority>();
  if (!parseStoredGithubInstallationAuthority(await authority())) {
    throw new ApiError(403, "github-installation-claim-inactive", "GitHub App installation claim is not ready for provisioning.");
  }
  return mintGithubInstallationToken(env, installationId, authority);
}

export async function githubApiJson<T>(path: string, token: string): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new TypeError("GitHub API path is invalid.");
  const response = await fetch(`https://api.github.com${path}`, { headers: githubHeaders(token), redirect: "manual" });
  if (!response.ok) throw new ApiError(502, "github-api-error", `GitHub API request failed with HTTP ${response.status}.`, { path });
  try {
    return await readBoundedResponseJson(response, MAX_GITHUB_API_JSON_BYTES) as T;
  } catch {
    throw new ApiError(502, "github-api-error", "GitHub API returned an invalid or oversized JSON response.", { path });
  }
}

export async function githubApiRaw(
  path: string,
  token: string,
  maximumBytes: number,
  expectedBytes?: number,
): Promise<Response> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new TypeError("GitHub API path is invalid.");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError("GitHub response limit is invalid.");
  if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maximumBytes)) {
    throw new TypeError("GitHub expected response length is invalid.");
  }
  const headers = githubHeaders(token);
  headers.set("accept", "application/vnd.github.raw+json");
  const response = await fetch(`https://api.github.com${path}`, { headers, redirect: "manual" });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Transport cleanup only. */ }
    throw new ApiError(502, "github-api-error", `GitHub API request failed with HTTP ${response.status}.`, { path });
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes || (expectedBytes !== undefined && length !== expectedBytes)) {
      try { await response.body?.cancel(); } catch { /* The response is rejected regardless. */ }
      throw new ApiError(502, "github-blob-length", "GitHub returned an unexpected blob length.", { path });
    }
  }
  if (!response.body) throw new ApiError(502, "github-blob-empty", "GitHub returned an empty blob response.", { path });
  let received = 0;
  const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array)) throw new ApiError(502, "github-blob-invalid", "GitHub returned a non-binary blob chunk.", { path });
      received += chunk.byteLength;
      if (received > maximumBytes || (expectedBytes !== undefined && received > expectedBytes)) {
        throw new ApiError(502, "github-blob-length", "GitHub streamed an oversized blob.", { path });
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (expectedBytes !== undefined && received !== expectedBytes) {
        throw new ApiError(502, "github-blob-length", "GitHub streamed an incomplete blob.", { path });
      }
    },
  }));
  return new Response(bounded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function githubRepositoryCoordinates(
  value: unknown,
  repositoryId: number,
  expectedOwner: string,
  expectedRepository: string,
): { readonly owner: string; readonly repository: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("GitHub repository response must be an object.");
  const repository = value as Record<string, unknown>;
  if (!repository.owner || typeof repository.owner !== "object" || Array.isArray(repository.owner)) {
    throw new TypeError("GitHub repository owner must be an object.");
  }
  const owner = repository.owner as Record<string, unknown>;
  if (
    repository.id !== repositoryId
    || typeof owner.login !== "string"
    || typeof repository.name !== "string"
    || owner.login.length > 100
    || repository.name.length > 100
    || /[\u0000-\u001f\u007f]/.test(owner.login)
    || /[\u0000-\u001f\u007f]/.test(repository.name)
  ) throw new TypeError("GitHub repository numeric identity is inconsistent.");
  if (owner.login.toLowerCase() !== expectedOwner.toLowerCase() || repository.name.toLowerCase() !== expectedRepository.toLowerCase()) {
    throw new TypeError("GitHub repository coordinates changed.");
  }
  return { owner: owner.login, repository: repository.name };
}

interface GithubAppInstallationSuspensionState {
  readonly id?: unknown;
  readonly suspended_at?: unknown;
}

function remoteSuspensionTimestamp(value: GithubAppInstallationSuspensionState, installationId: number): string | null {
  if (value.id !== installationId) throw new ApiError(502, "github-installation-suspension-error", "GitHub returned a different installation identity during suspension read-back.");
  if (value.suspended_at === null) return null;
  if (typeof value.suspended_at !== "string" || !Number.isFinite(Date.parse(value.suspended_at))) {
    throw new ApiError(502, "github-installation-suspension-error", "GitHub returned an invalid installation suspension state.");
  }
  return value.suspended_at;
}

/**
 * Converge a GitHub App installation to an exact remote suspension state.
 * Authenticated-app read-back is authoritative, so a lost mutation response
 * cannot leave the caller guessing whether repository access remains.
 */
export async function setGithubAppInstallationSuspension(
  env: WasmOjWorkerEnv,
  installationId: number,
  suspended: boolean,
): Promise<string | null> {
  if (!Number.isSafeInteger(installationId) || installationId < 1) throw new TypeError("Invalid GitHub installation ID.");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const token = await githubAppJwt(env);
      const path = `/app/installations/${installationId}`;
      const before = remoteSuspensionTimestamp(await githubApiJson<GithubAppInstallationSuspensionState>(path, token), installationId);
      if ((before !== null) === suspended) return before;
      const response = await fetch(`https://api.github.com${path}/suspended`, {
        method: suspended ? "PUT" : "DELETE",
        headers: githubHeaders(token),
        redirect: "manual",
      });
      if (response.status !== 204) {
        try { await response.body?.cancel(); } catch { /* Exact read-back below still controls success. */ }
      }
      const after = remoteSuspensionTimestamp(await githubApiJson<GithubAppInstallationSuspensionState>(path, await githubAppJwt(env)), installationId);
      if ((after !== null) === suspended) return after;
    } catch { /* A fresh authenticated read-back determines whether a lost mutation committed. */ }
  }
  throw new ApiError(502, "github-installation-suspension-error", "GitHub installation suspension did not converge after exact remote read-back.");
}

export async function requireOrganizer(env: WasmOjWorkerEnv, session: AuthenticatedSession): Promise<void> {
  if (!session.roles.includes("organizer") && !session.roles.includes("admin")) {
    throw new ApiError(403, "organizer-required", "An approved Organizer role is required.");
  }
}

export async function verifyGithubWebhook(request: Request, env: WasmOjWorkerEnv): Promise<{
  readonly deliveryId: string;
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly body: Uint8Array;
}> {
  const deliveryId = request.headers.get("x-github-delivery");
  const eventName = request.headers.get("x-github-event");
  const signature = request.headers.get("x-hub-signature-256");
  if (!deliveryId || !/^[A-Za-z0-9-]{1,128}$/.test(deliveryId) || !eventName || !/^[a-z_]{1,80}$/.test(eventName) || !signature?.startsWith("sha256=")) {
    throw new ApiError(400, "github-webhook-invalid", "GitHub webhook headers are invalid.");
  }
  let body: Uint8Array;
  try {
    body = await readBoundedRequestBytes(request, 2 * 1024 * 1024);
  } catch (error) {
    if (error instanceof ApiError && error.status === 413) throw new ApiError(413, "github-webhook-too-large", "GitHub webhook exceeds 2 MiB.");
    throw new ApiError(400, "github-webhook-invalid", "GitHub webhook body is incomplete or malformed.");
  }
  const expected = await hmacSha256Hex(env.GITHUB_WEBHOOK_SECRET, body);
  if (!constantTimeEqual(signature.slice(7), expected)) throw new ApiError(401, "github-webhook-signature", "GitHub webhook signature is invalid.");
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new ApiError(400, "github-webhook-json", "GitHub webhook body is not valid JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ApiError(400, "github-webhook-json", "GitHub webhook payload must be an object.");
  const record = payload as Record<string, unknown>;
  if (eventName === "installation_repositories") {
    const added = record.repositories_added;
    const removed = record.repositories_removed;
    if (!Array.isArray(added) || !Array.isArray(removed)) {
      throw new ApiError(400, "github-installation-repositories-invalid", "GitHub installation repository changes must be arrays.");
    }
    if (added.length + removed.length > MAX_GITHUB_INSTALLATION_REPOSITORY_CHANGES) {
      throw new ApiError(413, "github-webhook-too-many-repositories", "GitHub webhook exceeds the installation repository change limit.");
    }
  }
  return { deliveryId, eventName, payload: record, body };
}

export async function archiveAuthorizationDigest(
  repositoryId: number,
  commitSha: string,
  indexPath: string,
  wasmOjReleaseId: string,
): Promise<string> {
  return sha256Hex(`${repositoryId}\0${commitSha}\0${indexPath}\0${wasmOjReleaseId}\n`);
}
