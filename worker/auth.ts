import type { AuthenticatedSession, WasmOjWorkerEnv } from "./env";
import { base64Url, constantTimeEqual, randomToken, sha256Hex } from "./crypto";
import { ApiError, assertSameOrigin, cookieHeader, jsonResponse, parseCookies, readBoundedResponseJson, readJsonBody } from "./http";

const SESSION_COOKIE = "wasm_oj_session";
const CSRF_COOKIE = "wasm_oj_csrf";
const OAUTH_VERIFIER_COOKIE = "wasm_oj_oauth_verifier";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_STATE_SECONDS = 10 * 60;
const CLI_LOGIN_SECONDS = 10 * 60;
const CLI_ACCESS_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const CLI_LOGIN_POLL_SECONDS = 2;
const MAX_CLI_AUTH_REQUEST_BYTES = 4 * 1024;
const MAX_GITHUB_AUTH_RESPONSE_BYTES = 1024 * 1024;
const CLI_LOGIN_FLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLI_CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CLI_CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CLI_ACCESS_TOKEN = /^[A-Za-z0-9_-]{43}$/;

interface SessionRow {
  readonly user_id: string;
  readonly expires_at: string;
  readonly csrf_hash: string;
  readonly login: string;
  readonly avatar_url: string;
}

interface CliLoginFlowRow {
  readonly id: string;
  readonly code_challenge: string;
  readonly device_name: string;
  readonly approved_user_id: string | null;
  readonly expires_at: string;
  readonly exchanged_at: string | null;
}

interface ResolvedSession {
  readonly session: AuthenticatedSession;
  readonly transport: "browser" | "bearer";
  readonly token: string;
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid-request", `${label} must be a JSON object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ApiError(400, "invalid-request", `${label} has an invalid shape.`);
  }
  return record;
}

function cliDeviceName(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || new TextEncoder().encode(value).byteLength > 80
    || value !== value.normalize("NFC")
    || value !== value.trim()
    || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  ) {
    throw new ApiError(400, "invalid-device-name", "deviceName must be NFC-normalized UTF-8 with 1–80 visible bytes and no surrounding whitespace.");
  }
  return value;
}

function cliFlowId(value: unknown): string {
  if (typeof value !== "string" || !CLI_LOGIN_FLOW_ID.test(value)) {
    throw new ApiError(400, "invalid-cli-login-flow", "flowId must be a canonical UUID.");
  }
  return value;
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  return match?.[1];
}

async function sessionFromRow(row: SessionRow | null, env: WasmOjWorkerEnv): Promise<AuthenticatedSession | undefined> {
  if (!row || row.expires_at <= new Date().toISOString()) return undefined;
  const roles = await env.DB.prepare("SELECT role FROM user_roles WHERE user_id = ? ORDER BY role")
    .bind(row.user_id).all<{ role: "admin" | "organizer" }>();
  return {
    userId: row.user_id,
    login: row.login,
    avatarUrl: row.avatar_url,
    roles: roles.results.map((item) => item.role),
    expiresAt: row.expires_at,
  };
}

async function resolveSession(request: Request, env: WasmOjWorkerEnv): Promise<ResolvedSession | undefined> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const token = bearerToken(request);
    if (!token || !CLI_ACCESS_TOKEN.test(token)) return undefined;
    const row = await env.DB.prepare(
      "SELECT cli_access_tokens.user_id, cli_access_tokens.expires_at, '' AS csrf_hash, github_identities.login, github_identities.avatar_url FROM cli_access_tokens JOIN users ON users.id = cli_access_tokens.user_id JOIN github_identities ON github_identities.user_id = users.id WHERE cli_access_tokens.token_hash = ? AND users.status = 'active'",
    ).bind(await sha256Hex(token)).first<SessionRow>();
    const session = await sessionFromRow(row, env);
    return session ? { session, transport: "bearer", token } : undefined;
  }

  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return undefined;
  const row = await env.DB.prepare(
    "SELECT sessions.user_id, sessions.expires_at, sessions.csrf_hash, github_identities.login, github_identities.avatar_url FROM sessions JOIN users ON users.id = sessions.user_id JOIN github_identities ON github_identities.user_id = users.id WHERE sessions.token_hash = ? AND users.status = 'active'",
  ).bind(await sha256Hex(token)).first<SessionRow>();
  const session = await sessionFromRow(row, env);
  return session ? { session, transport: "browser", token } : undefined;
}

async function requireBrowserSession(request: Request, env: WasmOjWorkerEnv): Promise<ResolvedSession> {
  if (request.headers.has("authorization")) {
    throw new ApiError(401, "browser-authentication-required", "Open the verification link in a signed-in browser.");
  }
  const resolved = await resolveSession(request, env);
  if (!resolved || resolved.transport !== "browser") {
    throw new ApiError(401, "authentication-required", "Sign in with GitHub to continue.");
  }
  return resolved;
}

export async function requireBrowserAuthenticatedSession(
  request: Request,
  env: WasmOjWorkerEnv,
): Promise<AuthenticatedSession> {
  return (await requireBrowserSession(request, env)).session;
}

export async function requireBrowserMutationSession(request: Request, env: WasmOjWorkerEnv): Promise<AuthenticatedSession> {
  assertSameOrigin(request, env.PUBLIC_ORIGIN);
  const resolved = await requireBrowserSession(request, env);
  const cookies = parseCookies(request);
  const csrfCookie = cookies.get(CSRF_COOKIE);
  const csrfHeader = request.headers.get("x-wasm-oj-csrf");
  if (!csrfCookie || !csrfHeader || !constantTimeEqual(csrfCookie, csrfHeader)) {
    throw new ApiError(403, "csrf-rejected", "CSRF verification failed.");
  }
  const row = await env.DB.prepare("SELECT csrf_hash FROM sessions WHERE token_hash = ?")
    .bind(await sha256Hex(resolved.token)).first<{ csrf_hash: string }>();
  if (!row || !constantTimeEqual(row.csrf_hash, await sha256Hex(csrfCookie))) {
    throw new ApiError(403, "csrf-rejected", "CSRF verification failed.");
  }
  return resolved.session;
}

function safeReturnPath(value: string | null): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) return "/";
  return value;
}

function oauthRedirectUri(env: WasmOjWorkerEnv): string {
  return new URL("/api/auth/github/callback", env.PUBLIC_ORIGIN).toString();
}

export async function beginGithubLogin(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const requestUrl = new URL(request.url);
  const state = randomToken();
  const verifier = randomToken(48);
  const challengeBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...challengeBytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_SECONDS * 1_000).toISOString();
  await env.DB.prepare(
    "INSERT INTO oauth_states (state_hash, verifier_hash, return_path, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(
    await sha256Hex(state),
    await sha256Hex(verifier),
    safeReturnPath(requestUrl.searchParams.get("return")),
    now.toISOString(),
    expiresAt,
  ).run();
  const authorization = new URL("https://github.com/login/oauth/authorize");
  authorization.searchParams.set("client_id", env.GITHUB_OAUTH_CLIENT_ID);
  authorization.searchParams.set("redirect_uri", oauthRedirectUri(env));
  authorization.searchParams.set("scope", "read:user");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  const headers = new Headers({ location: authorization.toString(), "cache-control": "no-store" });
  headers.append("set-cookie", cookieHeader(OAUTH_VERIFIER_COOKIE, verifier, {
    httpOnly: true,
    maxAge: OAUTH_STATE_SECONDS,
    sameSite: "Lax",
  }));
  return new Response(null, { status: 302, headers });
}

export async function completeGithubLogin(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const verifier = parseCookies(request).get(OAUTH_VERIFIER_COOKIE);
  if (!state || !code || !verifier) throw new ApiError(400, "oauth-invalid", "GitHub login callback is incomplete.");
  const stateHash = await sha256Hex(state);
  const oauthState = await env.DB.prepare(
    "SELECT verifier_hash, return_path, expires_at FROM oauth_states WHERE state_hash = ?",
  ).bind(stateHash).first<{ verifier_hash: string; return_path: string; expires_at: string }>();
  await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash = ?").bind(stateHash).run();
  if (!oauthState || oauthState.expires_at <= new Date().toISOString() || !constantTimeEqual(oauthState.verifier_hash, await sha256Hex(verifier))) {
    throw new ApiError(400, "oauth-state-invalid", "GitHub login state is invalid or expired.");
  }
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "wasm-oj" },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: oauthRedirectUri(env),
      code_verifier: verifier,
    }),
    redirect: "manual",
  });
  if (!tokenResponse.ok) throw new ApiError(502, "github-oauth-error", `GitHub token exchange failed with HTTP ${tokenResponse.status}.`);
  let tokenBody: { access_token?: unknown; error?: unknown };
  try {
    tokenBody = await readBoundedResponseJson(tokenResponse, MAX_GITHUB_AUTH_RESPONSE_BYTES) as typeof tokenBody;
  } catch {
    throw new ApiError(502, "github-oauth-error", "GitHub returned an invalid token response.");
  }
  if (typeof tokenBody.access_token !== "string") throw new ApiError(502, "github-oauth-error", "GitHub did not issue an access token.");
  const identityResponse = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${tokenBody.access_token}`,
      "user-agent": "wasm-oj",
      "x-github-api-version": "2022-11-28",
    },
    redirect: "manual",
  });
  if (!identityResponse.ok) throw new ApiError(502, "github-identity-error", `GitHub identity request failed with HTTP ${identityResponse.status}.`);
  let github: Record<string, unknown>;
  try {
    github = await readBoundedResponseJson(identityResponse, MAX_GITHUB_AUTH_RESPONSE_BYTES) as Record<string, unknown>;
  } catch {
    throw new ApiError(502, "github-identity-error", "GitHub returned an invalid identity response.");
  }
  if (!Number.isSafeInteger(github.id) || typeof github.login !== "string" || typeof github.avatar_url !== "string" || typeof github.html_url !== "string") {
    throw new ApiError(502, "github-identity-error", "GitHub returned an invalid identity.");
  }
  const now = new Date().toISOString();
  const existing = await env.DB.prepare("SELECT user_id FROM github_identities WHERE github_user_id = ?")
    .bind(github.id).first<{ user_id: string }>();
  const userId = existing?.user_id ?? crypto.randomUUID();
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'active') ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at")
      .bind(userId, now, now),
    env.DB.prepare("INSERT INTO github_identities (github_user_id, user_id, login, avatar_url, profile_url, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(github_user_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url, profile_url = excluded.profile_url, updated_at = excluded.updated_at")
      .bind(github.id, userId, github.login, github.avatar_url, github.html_url, now),
    env.DB.prepare("INSERT INTO profiles (user_id, display_name, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING")
      .bind(userId, github.login, now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, csrf_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(await sha256Hex(sessionToken), userId, await sha256Hex(csrfToken), now, expiresAt, now),
  ]);
  const headers = new Headers({ location: oauthState.return_path, "cache-control": "no-store" });
  headers.append("set-cookie", cookieHeader(SESSION_COOKIE, sessionToken, { httpOnly: true, maxAge: SESSION_SECONDS, sameSite: "Lax" }));
  headers.append("set-cookie", cookieHeader(CSRF_COOKIE, csrfToken, { maxAge: SESSION_SECONDS, sameSite: "Strict" }));
  headers.append("set-cookie", cookieHeader(OAUTH_VERIFIER_COOKIE, "", { httpOnly: true, maxAge: 0, sameSite: "Lax" }));
  return new Response(null, { status: 302, headers });
}

export async function authenticatedSession(request: Request, env: WasmOjWorkerEnv): Promise<AuthenticatedSession | undefined> {
  return (await resolveSession(request, env))?.session;
}

export async function requireSession(request: Request, env: WasmOjWorkerEnv): Promise<AuthenticatedSession> {
  const resolved = await resolveSession(request, env);
  if (!resolved) throw new ApiError(401, "authentication-required", "Sign in with GitHub to continue.");
  return resolved.session;
}

export async function requireBrowserOrBearerMutationSession(request: Request, env: WasmOjWorkerEnv): Promise<AuthenticatedSession> {
  if (!request.headers.has("authorization")) return requireBrowserMutationSession(request, env);
  const resolved = await resolveSession(request, env);
  if (!resolved || resolved.transport !== "bearer") {
    throw new ApiError(401, "authentication-required", "The CLI access token is invalid or expired.");
  }
  return resolved.session;
}

export async function sessionResponse(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await authenticatedSession(request, env);
  return jsonResponse({ authenticated: Boolean(session), ...(session ? { user: session } : {}) });
}

export async function logout(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  await requireBrowserOrBearerMutationSession(request, env);
  const cliToken = bearerToken(request);
  if (request.headers.has("authorization")) {
    if (!cliToken) throw new ApiError(401, "authentication-required", "The CLI access token is invalid or expired.");
    await env.DB.prepare("DELETE FROM cli_access_tokens WHERE token_hash = ?").bind(await sha256Hex(cliToken)).run();
    return jsonResponse({ ok: true });
  }
  const browserToken = parseCookies(request).get(SESSION_COOKIE);
  if (browserToken) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(browserToken)).run();
  const headers = new Headers();
  headers.append("set-cookie", cookieHeader(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0, sameSite: "Lax" }));
  headers.append("set-cookie", cookieHeader(CSRF_COOKIE, "", { maxAge: 0, sameSite: "Strict" }));
  return jsonResponse({ ok: true }, 200, headers);
}

export async function startCliLogin(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const body = exactObject(await readJsonBody(request, MAX_CLI_AUTH_REQUEST_BYTES), ["codeChallenge", "deviceName"], "CLI login request");
  if (typeof body.codeChallenge !== "string" || !CLI_CODE_CHALLENGE.test(body.codeChallenge)) {
    throw new ApiError(400, "invalid-code-challenge", "codeChallenge must be an S256 base64url value.");
  }
  const deviceName = cliDeviceName(body.deviceName);
  const flowId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CLI_LOGIN_SECONDS * 1_000).toISOString();
  await env.DB.prepare(
    "INSERT INTO cli_login_flows (id, code_challenge, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(flowId, body.codeChallenge, deviceName, now.toISOString(), expiresAt).run();
  const verification = new URL("/auth/cli", env.PUBLIC_ORIGIN);
  verification.searchParams.set("flow", flowId);
  return jsonResponse({
    flowId,
    verificationUrl: verification.toString(),
    expiresAt,
    pollIntervalSeconds: CLI_LOGIN_POLL_SECONDS,
  }, 201);
}

async function cliLoginFlow(env: WasmOjWorkerEnv, flowId: string): Promise<CliLoginFlowRow | null> {
  return env.DB.prepare(
    "SELECT id, code_challenge, device_name, approved_user_id, expires_at, exchanged_at FROM cli_login_flows WHERE id = ?",
  ).bind(flowId).first<CliLoginFlowRow>();
}

function cliLoginFlowState(flow: CliLoginFlowRow, now: string): "pending" | "approved" | "complete" | "expired" {
  if (flow.expires_at <= now) return "expired";
  if (flow.exchanged_at) return "complete";
  return flow.approved_user_id ? "approved" : "pending";
}

export async function getCliLoginFlow(request: Request, env: WasmOjWorkerEnv, flowIdValue: string): Promise<Response> {
  const { session } = await requireBrowserSession(request, env);
  const flowId = cliFlowId(flowIdValue);
  const flow = await cliLoginFlow(env, flowId);
  if (!flow) throw new ApiError(404, "cli-login-not-found", "This CLI login request does not exist.");
  return jsonResponse({
    flowId: flow.id,
    deviceName: flow.device_name,
    expiresAt: flow.expires_at,
    state: cliLoginFlowState(flow, new Date().toISOString()),
    approvedByCurrentUser: flow.approved_user_id === session.userId,
  });
}

export async function approveCliLogin(request: Request, env: WasmOjWorkerEnv, flowIdValue: string): Promise<Response> {
  const session = await requireBrowserMutationSession(request, env);
  exactObject(await readJsonBody(request, MAX_CLI_AUTH_REQUEST_BYTES), [], "CLI login approval");
  const flowId = cliFlowId(flowIdValue);
  const now = new Date().toISOString();
  const flow = await cliLoginFlow(env, flowId);
  if (!flow) throw new ApiError(404, "cli-login-not-found", "This CLI login request does not exist.");
  if (flow.expires_at <= now) throw new ApiError(410, "cli-login-expired", "This CLI login request has expired.");
  if (flow.exchanged_at) throw new ApiError(409, "cli-login-complete", "This CLI login request has already issued a token.");
  if (flow.approved_user_id) {
    if (flow.approved_user_id !== session.userId) {
      throw new ApiError(409, "cli-login-already-approved", "This CLI login request was approved by another account.");
    }
    return jsonResponse({ flowId, state: "approved", expiresAt: flow.expires_at });
  }
  const result = await env.DB.prepare(
    "UPDATE cli_login_flows SET approved_user_id = ?, approved_at = ? WHERE id = ? AND approved_user_id IS NULL AND exchanged_at IS NULL AND expires_at > ?",
  ).bind(session.userId, now, flowId, now).run();
  if (result.meta.changes !== 1) {
    throw new ApiError(409, "cli-login-state-changed", "This CLI login request changed before it could be approved.");
  }
  return jsonResponse({ flowId, state: "approved", expiresAt: flow.expires_at });
}

export async function exchangeCliLoginToken(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const body = exactObject(await readJsonBody(request, MAX_CLI_AUTH_REQUEST_BYTES), ["codeVerifier", "flowId"], "CLI token request");
  const flowId = cliFlowId(body.flowId);
  if (typeof body.codeVerifier !== "string" || !CLI_CODE_VERIFIER.test(body.codeVerifier)) {
    throw new ApiError(400, "invalid-code-verifier", "codeVerifier must contain 43–128 PKCE verifier characters.");
  }
  const flow = await cliLoginFlow(env, flowId);
  if (!flow) throw new ApiError(400, "cli-login-invalid", "The CLI login request is invalid.");
  const verifierBytes = new TextEncoder().encode(body.codeVerifier);
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", verifierBytes)));
  verifierBytes.fill(0);
  if (!constantTimeEqual(challenge, flow.code_challenge)) {
    throw new ApiError(400, "cli-login-invalid", "The CLI login request is invalid.");
  }
  const now = new Date();
  const nowIso = now.toISOString();
  if (flow.expires_at <= nowIso) throw new ApiError(400, "cli-login-expired", "The CLI login request has expired.");
  if (flow.exchanged_at) throw new ApiError(409, "cli-login-complete", "The CLI login request has already issued a token.");
  if (!flow.approved_user_id) {
    throw new ApiError(428, "cli-login-pending", "Approve this CLI login request in the browser before polling again.", {
      retryAfterSeconds: CLI_LOGIN_POLL_SECONDS,
    });
  }

  const accessToken = randomToken();
  const accessTokenHash = await sha256Hex(accessToken);
  const exchangeNonce = randomToken();
  const expiresAt = new Date(now.getTime() + CLI_ACCESS_TOKEN_SECONDS * 1_000).toISOString();
  const [claim, issued] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE cli_login_flows SET exchange_nonce = ?, exchanged_at = ? WHERE id = ? AND approved_user_id = ? AND exchange_nonce IS NULL AND exchanged_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM users WHERE users.id = approved_user_id AND users.status = 'active')",
    ).bind(exchangeNonce, nowIso, flowId, flow.approved_user_id, nowIso),
    env.DB.prepare(
      "INSERT INTO cli_access_tokens (token_hash, user_id, login_flow_id, created_at, expires_at, last_seen_at) SELECT ?, approved_user_id, id, ?, ?, ? FROM cli_login_flows WHERE id = ? AND exchange_nonce = ? AND exchanged_at = ? AND approved_user_id = ? AND expires_at > ?",
    ).bind(accessTokenHash, nowIso, expiresAt, nowIso, flowId, exchangeNonce, nowIso, flow.approved_user_id, nowIso),
  ]);
  if (claim.meta.changes !== 1 || issued.meta.changes !== 1) {
    throw new ApiError(409, "cli-login-state-changed", "The CLI login request was already exchanged or is no longer active.");
  }
  return jsonResponse({ accessToken, tokenType: "Bearer", expiresAt });
}
