import type { WasmOjWorkerEnv } from "./env";
import { formalMutationStatus, type FormalMutationStatus } from "./formal-mutations";
import { constantTimeEqual } from "./crypto";
import { ApiError, jsonResponse } from "./http";
import { readBoundedProbedContainerIdentity } from "./container-identity-fence";

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

export async function probeDeploymentContainer(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const configured = env.MAINTENANCE_SMOKE_TOKEN;
  const authorization = request.headers.get("authorization");
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!configured || !supplied || !constantTimeEqual(configured, supplied)) {
    throw new ApiError(404, "route-not-found", "Route not found.");
  }
  if (!BUILD_ID.test(env.WASM_OJ_BUILD_ID) || env.CF_VERSION_METADATA.tag !== env.WASM_OJ_BUILD_ID) {
    throw new ApiError(503, "worker-build-mismatch", "Worker build metadata is inconsistent.");
  }
  const container = env.SUBMISSION_CONTAINER.getByName(`deployment-smoke-${env.WASM_OJ_BUILD_ID}`);
  const identity = await readBoundedProbedContainerIdentity(await container.fetch("https://judge.container/identity"));
  if (identity.buildId !== env.WASM_OJ_BUILD_ID) {
    throw new ApiError(503, "container-build-mismatch", "Container build does not match the Worker build.");
  }
  return jsonResponse({
    ready: true,
    buildId: identity.buildId,
    contract: identity.contract,
    protocol: identity.protocol,
    workerVersionId: env.CF_VERSION_METADATA.id,
  });
}
