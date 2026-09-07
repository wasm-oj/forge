import type { AuthenticatedSession, WasmOjWorkerEnv } from "./env";
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

/** Only catalog sync and Official Submit may supply their authenticated actor for cutover validation. */
export async function requireFormalMutationsEnabled(env: WasmOjWorkerEnv, maintenanceAdmin?: AuthenticatedSession): Promise<void> {
  const status = await formalMutationStatus(env);
  if (status.enabled) return;
  if (env.ENVIRONMENT === "production"
    && status.reason === "repository-source-truth-cutover"
    && maintenanceAdmin?.roles.includes("admin")) return;
  throw new ApiError(503, "formal-mutations-paused", "New formal operations are temporarily paused.");
}

export async function setFormalMutationsEnabled(
  env: WasmOjWorkerEnv,
  enabled: boolean,
  reasonInput: string,
): Promise<FormalMutationStatus> {
  const reason = reasonText(reasonInput);
  const updatedAt = new Date().toISOString();
  const previous = enabled ? await formalMutationStatus(env) : null;
  const cutoverResume = enabled && env.ENVIRONMENT === "production";
  if (cutoverResume && (reason !== "repository-source-truth-production-smoke-passed"
    || previous?.enabled !== false || previous.reason !== "repository-source-truth-cutover")) {
    throw new ApiError(409, "formal-mutation-resume-blocked", "Production resume requires the repository cutover pause and confirmed production smoke.");
  }
  const resumeFence = previous
    ? " AND formal_mutations_enabled=? AND reason=? AND updated_at=?"
      + (cutoverResume ? " AND NOT EXISTS (SELECT 1 FROM contest_v2_preflight_blockers)" : "")
    : "";
  const result = await env.DB.prepare(
    `UPDATE formal_mutation_controls SET formal_mutations_enabled=?, reason=?, updated_at=? WHERE environment=?${resumeFence}`,
  ).bind(enabled ? 1 : 0, reason, updatedAt, env.ENVIRONMENT,
    ...(previous ? [previous.enabled ? 1 : 0, previous.reason, previous.updatedAt] : [])).run();
  if (result.meta.changes !== 1) {
    if (previous) {
      throw new ApiError(409, "formal-mutation-resume-blocked", "Formal mutations remain paused: cutover blockers or maintenance state changed.");
    }
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
