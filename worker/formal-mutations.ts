import type { WasmOjWorkerEnv } from "./env";
import { ApiError } from "./http";
import { operationalLog } from "./structured-log";

export interface FormalMutationStatus {
  readonly enabled: boolean;
  readonly reason: string;
  readonly updatedAt: string;
}

interface FormalMutationRow {
  readonly formal_mutations_enabled: number;
  readonly reason: string;
  readonly updated_at: string;
}

export const MAINTENANCE_SMOKE_HEADER = "x-wasm-oj-maintenance-smoke-token";
const MAINTENANCE_SMOKE_REASONS = new Set(["repository-source-truth-cutover"]);
const MAINTENANCE_SMOKE_TOKEN_PATTERN = /^[\x21-\x7e]{32,256}$/;
const encoder = new TextEncoder();

async function constantTimeTokenEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = left.length ^ right.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

async function maintenanceSmokeAuthorized(
  request: Request,
  env: WasmOjWorkerEnv,
  status: FormalMutationStatus,
): Promise<boolean> {
  if (env.ENVIRONMENT !== "production" || !MAINTENANCE_SMOKE_REASONS.has(status.reason)) return false;
  const secret = env.MAINTENANCE_SMOKE_TOKEN;
  const presented = request.headers.get(MAINTENANCE_SMOKE_HEADER);
  if (
    typeof secret !== "string"
    || !MAINTENANCE_SMOKE_TOKEN_PATTERN.test(secret)
    || typeof presented !== "string"
    || !MAINTENANCE_SMOKE_TOKEN_PATTERN.test(presented)
  ) return false;
  return constantTimeTokenEqual(presented, secret);
}

function reasonText(value: string): string {
  const reason = value.trim();
  if (reason.length < 4 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new TypeError("Formal mutation reason must contain 4–500 printable characters.");
  }
  return reason;
}

function statusFromRow(row: FormalMutationRow | null): FormalMutationStatus {
  if (!row || ![0, 1].includes(row.formal_mutations_enabled) || !row.reason || !Number.isFinite(Date.parse(row.updated_at))) {
    throw new ApiError(503, "formal-mutation-control-unavailable", "Formal mutations are unavailable.");
  }
  return {
    enabled: row.formal_mutations_enabled === 1,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
}

export async function formalMutationStatus(env: WasmOjWorkerEnv): Promise<FormalMutationStatus> {
  return statusFromRow(await env.DB.prepare(
    "SELECT formal_mutations_enabled, reason, updated_at FROM formal_mutation_controls WHERE environment=?",
  ).bind(env.ENVIRONMENT).first<FormalMutationRow>());
}

export async function requireFormalMutationsEnabled(env: WasmOjWorkerEnv, request?: Request): Promise<void> {
  const status = await formalMutationStatus(env);
  if (status.enabled) return;
  if (request && await maintenanceSmokeAuthorized(request, env, status)) return;
  throw new ApiError(503, "formal-mutations-paused", "New formal operations are temporarily paused.");
}

export async function setFormalMutationsEnabled(
  env: WasmOjWorkerEnv,
  enabled: boolean,
  reasonInput: string,
): Promise<FormalMutationStatus> {
  const reason = reasonText(reasonInput);
  const updatedAt = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE formal_mutation_controls SET formal_mutations_enabled=?, reason=?, updated_at=? WHERE environment=?",
  ).bind(enabled ? 1 : 0, reason, updatedAt, env.ENVIRONMENT).run();
  if (result.meta.changes !== 1) {
    throw new ApiError(503, "formal-mutation-control-unavailable", "Formal mutation control is unavailable.");
  }
  operationalLog("info", {
    event: "control.formal-mutations-changed",
    outcome: "success",
    code: enabled ? "enabled" : "paused",
    environment: env.ENVIRONMENT,
  });
  return { enabled, reason, updatedAt };
}
