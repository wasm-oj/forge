export const MOUNTED_OUTPUT_STABILITY_MS = 75;

/**
 * Accept a mounted output only after byte-identical snapshots have persisted for
 * the complete stability interval. This prevents a valid WebAssembly prefix
 * from being mistaken for the command's final output.
 */
export class MountedOutputStabilityObserver {
  readonly #stabilityMs: number;
  #candidate: Uint8Array | undefined;
  #candidateSince = 0;

  constructor(stabilityMs = MOUNTED_OUTPUT_STABILITY_MS) {
    if (!Number.isFinite(stabilityMs) || stabilityMs <= 0) {
      throw new RangeError("Mounted-output stability interval must be positive and finite.");
    }
    this.#stabilityMs = stabilityMs;
  }

  observe(snapshot: Uint8Array | undefined, monotonicMs: number): Uint8Array | undefined {
    if (!Number.isFinite(monotonicMs)) {
      throw new RangeError("Mounted-output observation time must be finite.");
    }
    if (!snapshot) {
      this.#candidate = undefined;
      this.#candidateSince = 0;
      return undefined;
    }
    if (!this.#candidate || !bytesEqual(this.#candidate, snapshot)) {
      this.#candidate = snapshot.slice();
      this.#candidateSince = monotonicMs;
      return undefined;
    }
    if (monotonicMs - this.#candidateSince < this.#stabilityMs) return undefined;
    return snapshot.slice();
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
