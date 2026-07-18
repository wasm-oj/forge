import { GENERATED_COST_BASELINES } from "./generated/cost-baselines";
import { costProfileId, isCostProfileFor } from "./cost-profile";
import { WEIGHTED_METER_MODEL } from "./resources";
import { isBuiltinLanguage, type BuildArtifact, type ExecutionMetrics } from "./types";

export interface RawExecutionMetrics {
  cost: number;
  costModel: string;
  operations: Readonly<Record<string, number>>;
  memoryBytes: number;
  logicalTimeNs: number;
  filesystemBytes: number;
  filesystemEntries: number;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface CostBudget {
  profile: string;
  baselineCost: number;
  netInstructionBudget: number;
  rawInstructionBudget: number;
}

export class CostBaselineRegistry {
  private readonly baselines = new Map<string, number>();
  private sealed = false;

  constructor(entries: Readonly<Record<string, number>> = {}) {
    for (const [profile, baseline] of Object.entries(entries)) this.register(profile, baseline);
  }

  register(profile: string, baseline: number): void {
    if (this.sealed) throw new Error("CostBaselineRegistry is sealed after its first lookup.");
    if (typeof profile !== "string" || !profile || profile !== profile.trim() || profile.length > 16_384) {
      throw new Error("Cost profile IDs must be non-empty, trimmed strings of at most 16384 characters.");
    }
    if (!Number.isSafeInteger(baseline) || baseline < 0) {
      throw new RangeError(`Cost baseline '${profile}' must be a non-negative safe integer.`);
    }
    if (this.baselines.has(profile)) throw new Error(`Cost profile '${profile}' is already registered.`);
    this.baselines.set(profile, baseline);
  }

  baseline(profile: string): number {
    this.sealed = true;
    const baseline = this.baselines.get(profile);
    if (baseline === undefined) throw new Error(`No calibrated cost baseline is registered for '${profile}'.`);
    return baseline;
  }
}

export function createDefaultCostBaselineRegistry(): CostBaselineRegistry {
  return new CostBaselineRegistry(GENERATED_COST_BASELINES);
}

/** Creates the built-in registry plus downstream profiles without permitting canonical overrides. */
export function createExtendedCostBaselineRegistry(
  additional: Readonly<Record<string, number>> = {},
): CostBaselineRegistry {
  const registry = createDefaultCostBaselineRegistry();
  for (const [profile, baseline] of Object.entries(additional)) {
    if (Object.hasOwn(GENERATED_COST_BASELINES, profile)) {
      throw new Error(`Additional cost baseline '${profile}' would override a canonical Forge profile.`);
    }
    registry.register(profile, baseline);
  }
  return registry;
}

export function resolveCostBudget(
  profile: string,
  netInstructionBudget: number,
  registry = createDefaultCostBaselineRegistry(),
): CostBudget {
  if (!Number.isSafeInteger(netInstructionBudget) || netInstructionBudget < 1) {
    throw new RangeError("Net instruction budget must be a positive safe integer.");
  }
  const baselineCost = registry.baseline(profile);
  const rawInstructionBudget = baselineCost + netInstructionBudget;
  if (!Number.isSafeInteger(rawInstructionBudget)) {
    throw new RangeError(`Raw instruction budget overflows for cost profile '${profile}'.`);
  }
  return { profile, baselineCost, netInstructionBudget, rawInstructionBudget };
}

export function resolveArtifactCostBudget(
  artifact: BuildArtifact,
  netInstructionBudget: number,
  registry = createDefaultCostBaselineRegistry(),
): CostBudget {
  const matches = isBuiltinLanguage(artifact.language)
    ? artifact.costProfile === costProfileId(artifact.language, artifact.target, artifact.optimization)
    : isCostProfileFor(
      artifact.costProfile,
      artifact.language,
      artifact.target,
      artifact.optimization,
    );
  if (!matches) {
    throw new Error(
      `Artifact cost profile '${artifact.costProfile}' does not match `
      + `${artifact.language}/${artifact.target}/${artifact.optimization}.`,
    );
  }
  return resolveCostBudget(artifact.costProfile, netInstructionBudget, registry);
}

export function normalizeExecutionMetrics(
  raw: RawExecutionMetrics,
  budget: CostBudget,
): ExecutionMetrics {
  if (!raw || typeof raw !== "object") throw new TypeError("Runtime metrics must be an object.");
  if (!Number.isSafeInteger(raw.cost) || raw.cost < 0) {
    throw new RangeError("Runtime returned an invalid raw instruction cost.");
  }
  if (raw.costModel !== WEIGHTED_METER_MODEL) {
    throw new Error(`Runtime returned unsupported cost model '${String(raw.costModel)}'.`);
  }
  if (!raw.operations || typeof raw.operations !== "object" || Array.isArray(raw.operations)) {
    throw new TypeError("Runtime operations must be a record of weighted operation counts.");
  }
  const operations = Object.fromEntries(
    Object.entries(raw.operations)
      .map(([opcode, count]) => {
        if (!opcode || opcode !== opcode.trim() || opcode.length > 128) {
          throw new Error("Runtime operation names must be non-empty, trimmed strings of at most 128 characters.");
        }
        assertNonNegativeMetric(count, `Runtime operation '${opcode}' count`);
        return [opcode, count] as const;
      })
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  );
  assertNonNegativeMetric(raw.memoryBytes, "Runtime memoryBytes");
  assertNonNegativeMetric(raw.logicalTimeNs, "Runtime logicalTimeNs");
  assertNonNegativeMetric(raw.filesystemBytes, "Runtime filesystemBytes");
  assertNonNegativeMetric(raw.filesystemEntries, "Runtime filesystemEntries");
  assertNonNegativeMetric(raw.stdoutBytes, "Runtime stdoutBytes");
  assertNonNegativeMetric(raw.stderrBytes, "Runtime stderrBytes");
  return {
    cost: Math.max(0, raw.cost - budget.baselineCost),
    rawCost: raw.cost,
    baselineCost: budget.baselineCost,
    costProfile: budget.profile,
    costModel: raw.costModel,
    operations,
    memoryBytes: raw.memoryBytes,
    logicalTimeNs: raw.logicalTimeNs,
    filesystemBytes: raw.filesystemBytes,
    filesystemEntries: raw.filesystemEntries,
    stdoutBytes: raw.stdoutBytes,
    stderrBytes: raw.stderrBytes,
  };
}

export function unavailableExecutionMetrics(budget: CostBudget, costModel: string): ExecutionMetrics {
  if (costModel !== WEIGHTED_METER_MODEL) {
    throw new Error(`Unsupported cost model '${String(costModel)}'.`);
  }
  return {
    cost: null,
    rawCost: null,
    baselineCost: budget.baselineCost,
    costProfile: budget.profile,
    costModel,
    operations: null,
    memoryBytes: null,
    logicalTimeNs: null,
    filesystemBytes: null,
    filesystemEntries: null,
    stdoutBytes: null,
    stderrBytes: null,
  };
}

function assertNonNegativeMetric(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}
