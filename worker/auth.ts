import type { AuthenticatedSession, ForgeWorkerEnv } from "./env";
import { constantTimeEqual, randomToken, sha256Hex } from "./crypto";
import { ApiError, assertSameOrigin, cookieHeader, jsonResponse, parseCookies, readBoundedResponseJson } from "./http";

const SESSION_COOKIE = "forge_session";
const CSRF_COOKIE = "forge_csrf";
const OAUTH_VERIFIER_COOKIE = "forge_oauth_verifier";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_STATE_SECONDS = 10 * 60;
const MAX_GITHUB_AUTH_RESPONSE_BYTES = 1024 * 1024;

interface SessionRow {
  readonly user_id: string;
  readonly expires_at: string;
  readonly csrf_hash: string;
  readonly login: string;
  readonly avatar_url: string;
}

function safeReturnPath(value: string | null): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) return "/";
  return value;
}

function oauthRedirectUri(env: ForgeWorkerEnv): string {
  return new URL("/api/auth/github/callback", env.PUBLIC_ORIGIN).toString();
}

export async function beginGithubLogin(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const requestUrl = new URL(request.url);
  const state = randomToken();
  const verifier = randomToken(48);
  const challengeBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...challengeBytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_SECONDS * 1_000).toISOString();
  await env.CORE_DB.prepare(
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

export async function completeGithubLogin(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const verifier = parseCookies(request).get(OAUTH_VERIFIER_COOKIE);
  if (!state || !code || !verifier) throw new ApiError(400, "oauth-invalid", "GitHub login callback is incomplete.");
  const stateHash = await sha256Hex(state);
  const oauthState = await env.CORE_DB.prepare(
    "SELECT verifier_hash, return_path, expires_at FROM oauth_states WHERE state_hash = ?",
  ).bind(stateHash).first<{ verifier_hash: string; return_path: string; expires_at: string }>();
  await env.CORE_DB.prepare("DELETE FROM oauth_states WHERE state_hash = ?").bind(stateHash).run();
  if (!oauthState || oauthState.expires_at <= new Date().toISOString() || !constantTimeEqual(oauthState.verifier_hash, await sha256Hex(verifier))) {
    throw new ApiError(400, "oauth-state-invalid", "GitHub login state is invalid or expired.");
  }
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "wasm-oj-forge" },
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
      "user-agent": "wasm-oj-forge",
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
  const existing = await env.CORE_DB.prepare("SELECT user_id FROM github_identities WHERE github_user_id = ?")
    .bind(github.id).first<{ user_id: string }>();
  const userId = existing?.user_id ?? crypto.randomUUID();
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1_000).toISOString();
  await env.CORE_DB.batch([
    env.CORE_DB.prepare("INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'active') ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at")
      .bind(userId, now, now),
    env.CORE_DB.prepare("INSERT INTO github_identities (github_user_id, user_id, login, avatar_url, profile_url, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(github_user_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url, profile_url = excluded.profile_url, updated_at = excluded.updated_at")
      .bind(github.id, userId, github.login, github.avatar_url, github.html_url, now),
    env.CORE_DB.prepare("INSERT INTO profiles (user_id, display_name, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING")
      .bind(userId, github.login, now),
    env.CORE_DB.prepare("INSERT INTO sessions (token_hash, user_id, csrf_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(await sha256Hex(sessionToken), userId, await sha256Hex(csrfToken), now, expiresAt, now),
  ]);
  const headers = new Headers({ location: oauthState.return_path, "cache-control": "no-store" });
  headers.append("set-cookie", cookieHeader(SESSION_COOKIE, sessionToken, { httpOnly: true, maxAge: SESSION_SECONDS, sameSite: "Lax" }));
  headers.append("set-cookie", cookieHeader(CSRF_COOKIE, csrfToken, { maxAge: SESSION_SECONDS, sameSite: "Strict" }));
  headers.append("set-cookie", cookieHeader(OAUTH_VERIFIER_COOKIE, "", { httpOnly: true, maxAge: 0, sameSite: "Lax" }));
  return new Response(null, { status: 302, headers });
}

export async function authenticatedSession(request: Request, env: ForgeWorkerEnv): Promise<AuthenticatedSession | undefined> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return undefined;
  const row = await env.CORE_DB.prepare(
    "SELECT sessions.user_id, sessions.expires_at, sessions.csrf_hash, github_identities.login, github_identities.avatar_url FROM sessions JOIN users ON users.id = sessions.user_id JOIN github_identities ON github_identities.user_id = users.id WHERE sessions.token_hash = ? AND users.status = 'active'",
  ).bind(await sha256Hex(token)).first<SessionRow>();
  if (!row || row.expires_at <= new Date().toISOString()) return undefined;
  const roles = await env.CORE_DB.prepare("SELECT role FROM user_roles WHERE user_id = ? ORDER BY role")
    .bind(row.user_id).all<{ role: "admin" | "organizer" }>();
  return {
    userId: row.user_id,
    login: row.login,
    avatarUrl: row.avatar_url,
    roles: roles.results.map((item) => item.role),
    expiresAt: row.expires_at,
  };
}

export async function requireSession(request: Request, env: ForgeWorkerEnv): Promise<AuthenticatedSession> {
  const session = await authenticatedSession(request, env);
  if (!session) throw new ApiError(401, "authentication-required", "Sign in with GitHub to continue.");
  return session;
}

export async function requireMutationSession(request: Request, env: ForgeWorkerEnv): Promise<AuthenticatedSession> {
  assertSameOrigin(request, env.PUBLIC_ORIGIN);
  const session = await requireSession(request, env);
  const cookies = parseCookies(request);
  const csrfCookie = cookies.get(CSRF_COOKIE);
  const csrfHeader = request.headers.get("x-forge-csrf");
  const sessionToken = cookies.get(SESSION_COOKIE);
  if (!csrfCookie || !csrfHeader || !sessionToken || !constantTimeEqual(csrfCookie, csrfHeader)) {
    throw new ApiError(403, "csrf-rejected", "CSRF verification failed.");
  }
  const row = await env.CORE_DB.prepare("SELECT csrf_hash FROM sessions WHERE token_hash = ?")
    .bind(await sha256Hex(sessionToken)).first<{ csrf_hash: string }>();
  if (!row || !constantTimeEqual(row.csrf_hash, await sha256Hex(csrfCookie))) {
    throw new ApiError(403, "csrf-rejected", "CSRF verification failed.");
  }
  return session;
}

export async function sessionResponse(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await authenticatedSession(request, env);
  return jsonResponse({ authenticated: Boolean(session), ...(session ? { user: session } : {}) });
}

export async function logout(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  await requireMutationSession(request, env);
  const sessionToken = parseCookies(request).get(SESSION_COOKIE);
  if (sessionToken) await env.CORE_DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(sessionToken)).run();
  const headers = new Headers();
  headers.append("set-cookie", cookieHeader(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0, sameSite: "Lax" }));
  headers.append("set-cookie", cookieHeader(CSRF_COOKIE, "", { maxAge: 0, sameSite: "Strict" }));
  return jsonResponse({ ok: true }, 200, headers);
}
