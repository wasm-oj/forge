import { describe, expect, it } from "vitest";
import {
  CostBaselineRegistry,
  createExtendedCostBaselineRegistry,
  normalizeExecutionMetrics,
  resolveArtifactCostBudget,
  resolveCostBudget,
  unavailableExecutionMetrics,
} from "./cost";
import { FORGE_CONTRACT_VERSION } from "./contract";
import { costProfileId, isCostProfileFor } from "./cost-profile";
import { WEIGHTED_METER_MODEL } from "./resources";
import { GENERATED_COST_BASELINES } from "./generated/cost-baselines";
import type { WasmArtifact } from "./types";

describe("baseline-normalized instruction cost", () => {
  const registry = new CostBaselineRegistry({ profile: 100 });

  it("adds the baseline to the raw enforcement budget", () => {
    expect(resolveCostBudget("profile", 900, registry)).toEqual({
      profile: "profile",
      baselineCost: 100,
      netInstructionBudget: 900,
      rawInstructionBudget: 1_000,
    });
  });

  it("reports raw, baseline, and saturating net cost separately", () => {
    const budget = resolveCostBudget("profile", 900, registry);
    const raw = {
      cost: 140,
      costModel: WEIGHTED_METER_MODEL,
      operations: { Call: 2 },
      memoryBytes: 65_536,
      logicalTimeNs: 0,
      filesystemBytes: 0,
      filesystemEntries: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    expect(normalizeExecutionMetrics(raw, budget)).toMatchObject({
      cost: 40,
      rawCost: 140,
      baselineCost: 100,
      costProfile: "profile",
    });
    expect(normalizeExecutionMetrics({ ...raw, cost: 80 }, budget).cost).toBe(0);
  });

  it("fails closed for unknown profiles and budget overflow", () => {
    expect(() => resolveCostBudget("unknown", 1, registry)).toThrow("No calibrated cost baseline");
    expect(() => resolveCostBudget("profile", Number.MAX_SAFE_INTEGER, registry)).toThrow("overflows");
  });

  it("freezes calibration registrations on first lookup", () => {
    const mutable = new CostBaselineRegistry({ first: 1 });
    expect(mutable.baseline("first")).toBe(1);
    expect(() => mutable.register("late", 2)).toThrow("sealed");
  });

  it("requires canonical cost profile identifiers", () => {
    const mutable = new CostBaselineRegistry();
    expect(() => mutable.register(" padded", 1)).toThrow("trimmed");
    expect(() => mutable.register("", 1)).toThrow("non-empty");
  });

  it("fails closed on malformed or incompatible runtime metrics", () => {
    const budget = resolveCostBudget("profile", 900, registry);
    const valid = {
      cost: 140,
      costModel: WEIGHTED_METER_MODEL,
      operations: { Call: 2 },
      memoryBytes: 65_536,
      logicalTimeNs: 0,
      filesystemBytes: 0,
      filesystemEntries: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    const invalid = [
      { value: { ...valid, costModel: "unweighted" }, message: "unsupported cost model" },
      { value: { ...valid, operations: null }, message: "operations must be a record" },
      { value: { ...valid, operations: { " Call": 1 } }, message: "operation names" },
      { value: { ...valid, operations: { Call: -1 } }, message: "non-negative safe integer" },
      { value: { ...valid, memoryBytes: -1 }, message: "non-negative safe integer" },
      { value: { ...valid, filesystemBytes: -1 }, message: "non-negative safe integer" },
      { value: { ...valid, filesystemEntries: 0.5 }, message: "non-negative safe integer" },
      { value: { ...valid, stdoutBytes: Number.MAX_SAFE_INTEGER + 1 }, message: "non-negative safe integer" },
      { value: { ...valid, stderrBytes: 0.5 }, message: "non-negative safe integer" },
    ];

    for (const { value, message } of invalid) {
      expect(() => normalizeExecutionMetrics(value as never, budget)).toThrow(message);
    }
  });

  it("copies operation metrics into canonical key order", () => {
    const metrics = normalizeExecutionMetrics({
      cost: 100,
      costModel: WEIGHTED_METER_MODEL,
      operations: { Zeta: 1, Alpha: 2 },
      memoryBytes: 0,
      logicalTimeNs: 0,
      filesystemBytes: 0,
      filesystemEntries: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
    }, resolveCostBudget("profile", 1, registry));
    expect(Object.keys(metrics.operations ?? {})).toEqual(["Alpha", "Zeta"]);
  });

  it("retains baseline provenance when a host deadline hides raw metrics", () => {
    expect(unavailableExecutionMetrics(resolveCostBudget("profile", 1, registry), WEIGHTED_METER_MODEL)).toMatchObject({
      cost: null,
      rawCost: null,
      baselineCost: 100,
      costProfile: "profile",
    });
  });

  it("validates a seventh language artifact against its calibrated profile", () => {
    const profile = costProfileId("zig", "wasip1", "release", "zig-0.13.0-sha256-deadbeef");
    const extended = createExtendedCostBaselineRegistry({ [profile]: 42 });

    const artifact: WasmArtifact = {
      forgeContract: FORGE_CONTRACT_VERSION,
      id: "zig-artifact",
      projectId: "zig-project",
      cacheKey: "zig-cache-key",
      name: "main",
      language: "zig",
      target: "wasip1",
      optimization: "release",
      createdAt: 0,
      durationMs: 0,
      size: 8,
      toolchains: ["zig-0.13.0-sha256-deadbeef"],
      costProfile: profile,
      kind: "wasm",
      bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    };

    expect(isCostProfileFor(profile, "zig", "wasip1", "release")).toBe(true);
    expect(resolveArtifactCostBudget(artifact, 1_000, extended)).toEqual({
      profile,
      baselineCost: 42,
      netInstructionBudget: 1_000,
      rawInstructionBudget: 1_042,
    });
    expect(() => resolveArtifactCostBudget(
      { ...artifact, target: "wasix" },
      1_000,
      extended,
    )).toThrow("does not match zig/wasix/release");
    expect(() => resolveArtifactCostBudget(
      artifact,
      1_000,
      new CostBaselineRegistry(),
    )).toThrow("No calibrated cost baseline");
  });

  it("requires a content identity for downstream profiles", () => {
    expect(() => costProfileId("zig", "wasip1", "release")).toThrow(
      "requires an explicit content identity",
    );
  });

  it("does not allow downstream registrations to replace canonical baselines", () => {
    const canonicalProfile = Object.keys(GENERATED_COST_BASELINES)[0];
    expect(() => createExtendedCostBaselineRegistry({ [canonicalProfile]: 0 }))
      .toThrow("override a canonical Forge profile");
  });
});
