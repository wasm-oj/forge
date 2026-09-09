import type { DeterminismConfig } from "./types.ts";

export const DEFAULT_DETERMINISM: Readonly<DeterminismConfig> = Object.freeze({
  randomSeed: 0x5eed_1234,
  realtimeEpochMs: Date.UTC(2000, 0, 1),
  clockStepNs: 1_000_000,
});

export function resolveDeterminism(
  value: Partial<DeterminismConfig> | undefined,
): DeterminismConfig {
  const resolved = { ...DEFAULT_DETERMINISM, ...value };
  if (!Number.isInteger(resolved.randomSeed) || resolved.randomSeed < 0 || resolved.randomSeed > 0xffff_ffff) {
    throw new RangeError("randomSeed must be an unsigned 32-bit integer.");
  }
  if (!Number.isSafeInteger(resolved.realtimeEpochMs) || resolved.realtimeEpochMs < 0 || resolved.realtimeEpochMs > 18_446_744_073_000) {
    throw new RangeError("realtimeEpochMs must be a non-negative integer representable by a WASI timestamp.");
  }
  if (!Number.isSafeInteger(resolved.clockStepNs) || resolved.clockStepNs < 1 || resolved.clockStepNs > 1_000_000_000) {
    throw new RangeError("clockStepNs must be an integer from 1 through 1,000,000,000.");
  }
  return resolved;
}
