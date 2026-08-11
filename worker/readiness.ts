import type { ForgeWorkerEnv } from "./env";
import { formalMutationStatus, type FormalMutationStatus } from "./formal-mutations";

export interface Readiness {
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly environment: string;
  readonly releaseId: string;
  readonly formalMutations: FormalMutationStatus | null;
  readonly checks: {
    readonly coreDatabase: boolean;
    readonly submissionsDatabase: boolean;
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
  const [coreDatabase, submissionsDatabase, formalMutations] = await Promise.all([
    databaseIsReady(env.CORE_DB),
    databaseIsReady(env.SUBMISSIONS_DB),
    formalMutationStatus(env).catch(() => null),
  ]);
  return {
    ready: coreDatabase && submissionsDatabase && formalMutations !== null,
    checkedAt: new Date().toISOString(),
    environment: env.ENVIRONMENT,
    releaseId: env.FORGE_RELEASE_ID,
    formalMutations,
    checks: { coreDatabase, submissionsDatabase, formalMutationControl: formalMutations !== null },
  };
}
