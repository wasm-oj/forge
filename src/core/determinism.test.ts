import { describe, expect, it } from "vitest";
import { DEFAULT_DETERMINISM, resolveDeterminism } from "./determinism";

describe("deterministic execution configuration", () => {
  it("resolves a complete immutable default contract", () => {
    expect(resolveDeterminism(undefined)).toEqual(DEFAULT_DETERMINISM);
    expect(resolveDeterminism({ randomSeed: 42 })).toEqual({
      ...DEFAULT_DETERMINISM,
      randomSeed: 42,
    });
  });

  it("rejects values that cannot be represented consistently by all runtimes", () => {
    expect(() => resolveDeterminism({ randomSeed: -1 })).toThrow("unsigned 32-bit");
    expect(() => resolveDeterminism({ randomSeed: 2 ** 32 })).toThrow("unsigned 32-bit");
    expect(() => resolveDeterminism({ realtimeEpochMs: -1 })).toThrow("WASI timestamp");
    expect(() => resolveDeterminism({ clockStepNs: 0 })).toThrow("1 through 1,000,000,000");
  });
});
