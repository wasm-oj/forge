import type { WasmOjWorkerEnv } from "./env";
import { formalMutationStatus, type FormalMutationStatus } from "./formal-mutations";

const BUILD_ID = /^[0-9a-f]{40}$/;

export interface Readiness {
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly environment: string;
  readonly buildId: string;
  readonly workerVersionId: string;
  readonly formalMutations: FormalMutationStatus | null;
  readonly checks: {
    readonly database: boolean;
    readonly workerBuild: boolean;
    readonly formalMutationControl: boolean;
  };
}

async function databaseIsReady(database: D1Database): Promise<boolean> {
  try { await database.prepare("SELECT 1").first(); return true; }
  catch { return false; }
}

export async function detailedReadiness(env: WasmOjWorkerEnv): Promise<Readiness> {
  const [database, formalMutations] = await Promise.all([
    databaseIsReady(env.DB),
    formalMutationStatus(env).catch(() => null),
  ]);
  const workerBuild = BUILD_ID.test(env.WASM_OJ_BUILD_ID)
    && env.CF_VERSION_METADATA.tag === env.WASM_OJ_BUILD_ID
    && typeof env.CF_VERSION_METADATA.id === "string"
    && env.CF_VERSION_METADATA.id.length > 0;
  return {
    ready: database && workerBuild && formalMutations !== null,
    checkedAt: new Date().toISOString(),
    environment: env.ENVIRONMENT,
    buildId: env.WASM_OJ_BUILD_ID,
    workerVersionId: env.CF_VERSION_METADATA.id,
    formalMutations,
    checks: { database, workerBuild, formalMutationControl: formalMutations !== null },
  };
}
