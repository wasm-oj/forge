import type { ResourcePolicy } from "./types.ts";

/** The weighted meter defined by the active Forge contract. */
export const WEIGHTED_METER_MODEL = "weighted";
export const MAX_LOGICAL_TIME_LIMIT_MS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000);
export const WASM_MEMORY_PAGE_BYTES = 65_536;
export const MAX_MEMORY_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_WALL_TIME_LIMIT_MS = 10 * 60 * 1_000;

export const DEFAULT_RESOURCE_POLICY: Readonly<ResourcePolicy> = Object.freeze({
  instructionBudget: 10_000_000_000,
  logicalTimeLimitMs: 60_000,
  memoryLimitBytes: 256 * 1024 * 1024,
  outputLimitBytes: 4 * 1024 * 1024,
  filesystemWriteLimitBytes: 64 * 1024 * 1024,
  filesystemEntryLimit: 4_096,
  // Wall time is an emergency host-safety boundary, not a deterministic judging metric.
  wallTimeLimitMs: 60_000,
});

export function resolveResourcePolicy(value: Partial<ResourcePolicy> | undefined): ResourcePolicy {
  const policy = { ...DEFAULT_RESOURCE_POLICY, ...value };
  assertSafePositive("instructionBudget", policy.instructionBudget, Number.MAX_SAFE_INTEGER);
  assertSafePositive("logicalTimeLimitMs", policy.logicalTimeLimitMs, MAX_LOGICAL_TIME_LIMIT_MS);
  assertSafePositive("memoryLimitBytes", policy.memoryLimitBytes, MAX_MEMORY_LIMIT_BYTES);
  assertSafePositive("outputLimitBytes", policy.outputLimitBytes, 64 * 1024 * 1024);
  assertSafePositive("filesystemWriteLimitBytes", policy.filesystemWriteLimitBytes, 512 * 1024 * 1024);
  assertSafePositive("filesystemEntryLimit", policy.filesystemEntryLimit, 65_536);
  assertSafePositive("wallTimeLimitMs", policy.wallTimeLimitMs, MAX_WALL_TIME_LIMIT_MS);
  if (policy.memoryLimitBytes % WASM_MEMORY_PAGE_BYTES !== 0) {
    throw new RangeError("memoryLimitBytes must be a multiple of the 64 KiB WebAssembly page size.");
  }
  return policy;
}

function assertSafePositive(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}.`);
  }
}
