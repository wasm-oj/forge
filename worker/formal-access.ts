import type { WasmOjWorkerEnv } from "./env";
import { ApiError, readBoundedResponseJson } from "./http";
import {
  FORMAL_RISK_ALLOWANCE_MS,
  FORMAL_RISK_COST_THRESHOLD,
  FORMAL_RISK_FAILURE_THRESHOLD,
  FORMAL_RISK_VELOCITY_THRESHOLD,
  formalRiskRequiresTurnstile,
} from "../src/online-judge/formal-risk";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function parseGithubUserAllowlist(source: string): ReadonlySet<number> {
  if (!source) return new Set();
  const values = source.split(",").map((value) => value.trim());
  if (values.some((value) => !/^[1-9]\d{0,15}$/.test(value))) {
    throw new TypeError("STAGING_ALLOWED_GITHUB_USER_IDS must contain comma-separated positive decimal IDs.");
  }
  const parsed = values.map(Number);
  if (parsed.some((value) => !Number.isSafeInteger(value))) throw new TypeError("Staging GitHub user allowlist contains an unsafe integer.");
  return new Set(parsed);
}

export async function requireStagingFormalAccess(env: WasmOjWorkerEnv, userId: string): Promise<void> {
  if (env.ENVIRONMENT !== "staging") return;
  const allowlist = parseGithubUserAllowlist(env.STAGING_ALLOWED_GITHUB_USER_IDS);
  if (allowlist.size === 0) throw new ApiError(503, "staging-allowlist-empty", "Formal staging access has not been enabled.");
  const identity = await env.DB.prepare("SELECT github_user_id FROM github_identities WHERE user_id=?")
    .bind(userId).first<{ github_user_id: number }>();
  if (!identity || !allowlist.has(identity.github_user_id)) {
    throw new ApiError(403, "staging-formal-access-required", "This GitHub account is not admitted to staging formal operations.");
  }
}

type TurnstileAction = "official-submit" | "organizer-application";

interface TurnstileResponse {
  readonly success?: unknown;
  readonly hostname?: unknown;
  readonly action?: unknown;
  readonly "error-codes"?: unknown;
}

async function verifyTurnstile(request: Request, env: WasmOjWorkerEnv, action: TurnstileAction): Promise<void> {
  const token = request.headers.get("x-wasm-oj-turnstile-token");
  if (!token || token.length > 2_048 || /[\u0000-\u0020\u007f]/.test(token)) {
    throw new ApiError(403, "turnstile-required", "A fresh Turnstile verification is required.");
  }
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  form.set("idempotency_key", crypto.randomUUID());
  const remoteIp = request.headers.get("cf-connecting-ip");
  if (remoteIp) form.set("remoteip", remoteIp);
  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method: "POST",
    body: form,
    redirect: "manual",
  });
  if (!response.ok) throw new ApiError(503, "turnstile-unavailable", "Turnstile verification is temporarily unavailable.");
  let result: TurnstileResponse;
  try {
    result = await readBoundedResponseJson(response, 64 * 1024) as TurnstileResponse;
  } catch {
    throw new ApiError(503, "turnstile-invalid-response", "Turnstile returned an invalid verification response.");
  }
  const hostname = new URL(env.PUBLIC_ORIGIN).hostname;
  if (result.success !== true || result.hostname !== hostname || result.action !== action) {
    throw new ApiError(403, "turnstile-rejected", "Turnstile verification was rejected.");
  }
}

interface SubmissionRiskRow {
  readonly prior_submission_count: number;
  readonly recent_submission_count: number;
  readonly recent_failure_count: number;
  readonly recent_deterministic_cost: number;
}

function safeRiskCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ApiError(503, "formal-risk-state-invalid", `${label} is unavailable.`);
  return value as number;
}

export async function requireOfficialSubmissionRiskTurnstile(
  request: Request,
  env: WasmOjWorkerEnv,
  userId: string,
  requestKey: string,
): Promise<void> {
  if (env.ENVIRONMENT === "development") return;
  const windowStart = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
  const row = await env.DB.prepare(
    "SELECT CASE WHEN COUNT(*)=0 THEN 0 ELSE 1 END AS prior_submission_count, MIN(COALESCE(SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END),0),?) AS recent_submission_count, MIN(COALESCE(SUM(CASE WHEN completed_at>=? AND state IN ('compile-error','judge-error','infrastructure-error') THEN 1 ELSE 0 END),0),?) AS recent_failure_count, MIN(COALESCE(SUM(CASE WHEN completed_at>=? THEN COALESCE(deterministic_cost,0) ELSE 0 END),0),?) AS recent_deterministic_cost FROM submissions WHERE user_id=? AND origin_submission_id=id",
  ).bind(windowStart, FORMAL_RISK_VELOCITY_THRESHOLD, windowStart, FORMAL_RISK_FAILURE_THRESHOLD, windowStart, FORMAL_RISK_COST_THRESHOLD, userId).first<SubmissionRiskRow>();
  if (!row) throw new ApiError(503, "formal-risk-state-unavailable", "Formal admission risk state is unavailable.");
  const now = new Date();
  const allowance = await env.DB.prepare(
    "SELECT 1 AS allowed FROM formal_risk_allowances WHERE user_id=? AND request_key=? AND expires_at>?",
  ).bind(userId, requestKey, now.toISOString()).first<{ readonly allowed: number }>();
  if (allowance) return;
  const signals = {
    priorSubmissionCount: safeRiskCount(row.prior_submission_count, "Prior submission count"),
    recentSubmissionCount: safeRiskCount(row.recent_submission_count, "Recent submission count"),
    recentFailureCount: safeRiskCount(row.recent_failure_count, "Recent failure count"),
    recentDeterministicCost: safeRiskCount(row.recent_deterministic_cost, "Recent deterministic cost"),
  };
  const token = request.headers.get("x-wasm-oj-turnstile-token");
  if (!formalRiskRequiresTurnstile(signals) && token === null) return;
  await verifyTurnstile(request, env, "official-submit");
  const expiresAt = new Date(now.getTime() + FORMAL_RISK_ALLOWANCE_MS).toISOString();
  await env.DB.prepare(
    "INSERT INTO formal_risk_allowances (user_id, request_key, expires_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, request_key) DO UPDATE SET expires_at=excluded.expires_at",
  ).bind(userId, requestKey, expiresAt, now.toISOString()).run();
}

export async function cleanupExpiredFormalRiskAllowances(env: WasmOjWorkerEnv): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM formal_risk_allowances WHERE expires_at<=?")
    .bind(new Date().toISOString()).run();
  return result.meta.changes;
}

export async function requireFirstOrganizerApplicationTurnstile(
  request: Request,
  env: WasmOjWorkerEnv,
  userId: string,
): Promise<void> {
  if (env.ENVIRONMENT === "development") return;
  const prior = await env.DB.prepare("SELECT 1 AS present FROM organizer_applications WHERE user_id=? LIMIT 1")
    .bind(userId).first<{ present: number }>();
  if (!prior) await verifyTurnstile(request, env, "organizer-application");
}
