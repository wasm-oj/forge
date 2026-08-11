import type { DependencyDownloadBudget } from "./types.ts";

const MIB = 1024 * 1024;
const issuedDownloadBudgets = new WeakSet<object>();

/** Hard browser-side admission limits shared by resolution, cache, and build paths. */
export const DEPENDENCY_RESOLUTION_LIMITS = Object.freeze({
  requirements: 128,
  sourceFiles: 128,
  sourceTextBytes: 8 * MIB,
  hosts: 32,
  roots: 512,
  packages: 512,
  referencesPerPackage: 512,
  concurrency: 16,
  metadataBytes: 8 * MIB,
  packageBytes: 256 * MIB,
  totalDownloadBytes: 512 * MIB,
  archiveFiles: 16_384,
  unpackedBytes: 512 * MIB,
});

export function assertBoundedCount(
  count: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > maximum) {
    throw new RangeError(`${label} exceeds the ${maximum}-item limit.`);
  }
}

export function createDependencyDownloadBudget(
  limitBytes = DEPENDENCY_RESOLUTION_LIMITS.totalDownloadBytes,
): DependencyDownloadBudget {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > DEPENDENCY_RESOLUTION_LIMITS.totalDownloadBytes) {
    throw new RangeError(`Dependency download budget must be 1-${DEPENDENCY_RESOLUTION_LIMITS.totalDownloadBytes} bytes.`);
  }
  let usedBytes = 0;
  const add = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("Dependency download byte reservation is invalid.");
    if (usedBytes + bytes > limitBytes) {
      throw new RangeError(`Dependency downloads exceed the ${limitBytes}-byte aggregate limit.`);
    }
    usedBytes += bytes;
  };
  const budget: DependencyDownloadBudget = Object.freeze({
    get limitBytes() { return limitBytes; },
    get usedBytes() { return usedBytes; },
    reserve(bytes: number) { add(bytes); },
    consume(bytes: number) { add(bytes); },
    release(bytes: number) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > usedBytes) {
        throw new TypeError("Dependency download byte release is invalid.");
      }
      usedBytes -= bytes;
    },
  });
  issuedDownloadBudgets.add(budget);
  return budget;
}

/** Rejects caller-forged budgets whose methods could silently bypass the hard aggregate cap. */
export function assertDependencyDownloadBudget(value: unknown): asserts value is DependencyDownloadBudget {
  if (!value || typeof value !== "object" || !issuedDownloadBudgets.has(value)) {
    throw new TypeError("Dependency download budget must be issued by Forge.");
  }
  const budget = value as DependencyDownloadBudget;
  if (
    !Number.isSafeInteger(budget.limitBytes)
    || budget.limitBytes < 1
    || budget.limitBytes > DEPENDENCY_RESOLUTION_LIMITS.totalDownloadBytes
    || !Number.isSafeInteger(budget.usedBytes)
    || budget.usedBytes < 0
    || budget.usedBytes > budget.limitBytes
  ) {
    throw new TypeError("Dependency download budget state is invalid.");
  }
}
