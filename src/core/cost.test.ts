import { describe, expect, it } from "vitest";
import { costProfileId } from "./cost-profile";
import { toolchainContentIdentity } from "./toolchains";
import {
  createDefaultCostBaselineRegistry,
  createExtendedCostBaselineRegistry,
  normalizeExecutionMetrics,
  resolveArtifactCostBudget,
} from "./cost";
import { JAVA_EMPTY_PROGRAM_BASELINE_COST } from "./cost-baselines";

const javaContent = toolchainContentIdentity("java");
const javaReleaseProfile = costProfileId("java", "wasip1", "release", javaContent);
const javaDebugProfile = costProfileId("java", "wasip1", "debug", javaContent);
const uncalibratedJavaProfile = costProfileId("java", "wasip1", "release", "new-java-profile");

const raw = {
  cost: JAVA_EMPTY_PROGRAM_BASELINE_COST,
  costModel: "weighted",
  operations: {},
  memoryBytes: 0,
  logicalTimeNs: 0,
  filesystemBytes: 0,
  filesystemEntries: 0,
  stdoutBytes: 0,
  stderrBytes: 0,
};

describe("cost baselines", () => {
  it("ships the measured Java empty-program baseline for both optimization profiles", () => {
    const registry = createDefaultCostBaselineRegistry();

    expect(registry.baseline(javaReleaseProfile)).toBe(JAVA_EMPTY_PROGRAM_BASELINE_COST);
    expect(registry.baseline(javaDebugProfile)).toBe(JAVA_EMPTY_PROGRAM_BASELINE_COST);
  });

  it("lets a host override a pinned baseline without losing the defaults", () => {
    const registry = createExtendedCostBaselineRegistry({ [javaReleaseProfile]: 3000 });

    expect(registry.baseline(javaReleaseProfile)).toBe(3000);
    expect(registry.baseline(javaDebugProfile)).toBe(JAVA_EMPTY_PROGRAM_BASELINE_COST);
  });

  it("fails closed when a Java artifact has an uncalibrated profile", () => {
    expect(() => resolveArtifactCostBudget({
      language: "java",
      target: "wasip1",
      optimization: "release",
      costProfile: uncalibratedJavaProfile,
    } as Parameters<typeof resolveArtifactCostBudget>[0], 100)).toThrow("has no calibrated empty-program baseline");
  });

  it("normalizes the measured empty Java program to zero net cost", () => {
    const metrics = normalizeExecutionMetrics(raw, {
      profile: javaReleaseProfile,
      baselineCost: JAVA_EMPTY_PROGRAM_BASELINE_COST,
      netInstructionBudget: 10000,
      rawInstructionBudget: JAVA_EMPTY_PROGRAM_BASELINE_COST + 10000,
    });

    expect(metrics).toMatchObject({
      cost: 0,
      rawCost: JAVA_EMPTY_PROGRAM_BASELINE_COST,
      baselineCost: JAVA_EMPTY_PROGRAM_BASELINE_COST,
    });
  });
});
