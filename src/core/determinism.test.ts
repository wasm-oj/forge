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

  it("requires explicit host-clock opt-in without changing the default transcript", () => {
    expect(resolveDeterminism(undefined)).not.toHaveProperty("clockMode");
    expect(resolveDeterminism({ clockMode: "host" })).toEqual({ ...DEFAULT_DETERMINISM, clockMode: "host" });
    expect(() => resolveDeterminism({ clockMode: "invalid" } as never)).toThrow("clockMode");
  });

  it("rejects values that cannot be represented consistently by all runtimes", () => {
    expect(() => resolveDeterminism({ randomSeed: -1 })).toThrow("unsigned 32-bit");
    expect(() => resolveDeterminism({ randomSeed: 2 ** 32 })).toThrow("unsigned 32-bit");
    expect(() => resolveDeterminism({ realtimeEpochMs: -1 })).toThrow("WASI timestamp");
    expect(() => resolveDeterminism({ clockStepNs: 0 })).toThrow("1 through 1,000,000,000");
  });
});
