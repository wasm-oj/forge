import type { ForgeWorkerEnv } from "./env";
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

export async function formalMutationStatus(env: ForgeWorkerEnv): Promise<FormalMutationStatus> {
  return statusFromRow(await env.CORE_DB.prepare(
    "SELECT formal_mutations_enabled, reason, updated_at FROM formal_mutation_controls WHERE environment=?",
  ).bind(env.ENVIRONMENT).first<FormalMutationRow>());
}

export async function requireFormalMutationsEnabled(env: ForgeWorkerEnv): Promise<void> {
  if (!(await formalMutationStatus(env)).enabled) {
    throw new ApiError(503, "formal-mutations-paused", "New formal operations are temporarily paused.");
  }
}

export async function setFormalMutationsEnabled(
  env: ForgeWorkerEnv,
  enabled: boolean,
  reasonInput: string,
): Promise<FormalMutationStatus> {
  const reason = reasonText(reasonInput);
  const updatedAt = new Date().toISOString();
  const result = await env.CORE_DB.prepare(
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
