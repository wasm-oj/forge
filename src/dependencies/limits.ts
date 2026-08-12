import type { DependencyDownloadBudget } from "./types.ts";
import {
  DEPENDENCY_RESOLUTION_LIMITS,
} from "../core/dependencies.ts";
export { DEPENDENCY_RESOLUTION_LIMITS, assertBoundedCount } from "../core/dependencies.ts";
const issuedDownloadBudgets = new WeakSet<object>();

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
    throw new TypeError("Dependency download budget must be issued by WASM-OJ.");
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
