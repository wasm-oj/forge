import { describe, expect, it } from "vitest";
import { DEFAULT_RESOURCE_POLICY, resolveResourcePolicy } from "./resources";

describe("resource policy", () => {
  it("resolves a complete immutable-by-value run contract", () => {
    expect(resolveResourcePolicy({ instructionBudget: 10 })).toEqual({
      ...DEFAULT_RESOURCE_POLICY,
      instructionBudget: 10,
    });
  });

  it("requires WebAssembly-page-aligned memory limits", () => {
    expect(() => resolveResourcePolicy({ memoryLimitBytes: 65_537 })).toThrow("64 KiB");
  });

  it.each([
    ["instructionBudget", 0],
    ["logicalTimeLimitMs", 0],
    ["logicalTimeLimitMs", 9_007_199_255],
    ["outputLimitBytes", -1],
    ["filesystemWriteLimitBytes", 512 * 1024 * 1024 + 1],
    ["filesystemEntryLimit", 65_537],
    ["wallTimeLimitMs", Number.NaN],
  ] as const)("rejects invalid %s", (field, value) => {
    expect(() => resolveResourcePolicy({ [field]: value })).toThrow(RangeError);
  });
});
