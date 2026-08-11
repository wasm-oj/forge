import type { ForgeWorkerEnv } from "./env";
import { formalMutationStatus, type FormalMutationStatus } from "./formal-mutations";
import { assertActiveRelease } from "./release";

export interface Readiness {
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly environment: string;
  readonly releaseId: string;
  readonly formalMutations: FormalMutationStatus | null;
  readonly checks: {
    readonly database: boolean;
    readonly release: boolean;
    readonly formalMutationControl: boolean;
  };
}

async function databaseIsReady(database: D1Database): Promise<boolean> {
  try {
    await database.prepare("SELECT 1").first();
    return true;
  } catch {
    return false;
  }
}

export async function detailedReadiness(env: ForgeWorkerEnv): Promise<Readiness> {
  const [database, release, formalMutations] = await Promise.all([
    databaseIsReady(env.DB),
    assertActiveRelease(
      env.DB,
      env.JUDGE_BUCKET,
      env.ENVIRONMENT,
      env.FORGE_RELEASE_ID,
      env.FORGE_RELEASE_MANIFEST_SHA256,
    ).then(() => true, () => false),
    formalMutationStatus(env).catch(() => null),
  ]);
  return {
    ready: database && release && formalMutations !== null,
    checkedAt: new Date().toISOString(),
    environment: env.ENVIRONMENT,
    releaseId: env.FORGE_RELEASE_ID,
    formalMutations,
    checks: { database, release, formalMutationControl: formalMutations !== null },
  };
}
