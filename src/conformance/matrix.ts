import { FORGE_SCHEMAS } from "../core/contract.ts";
import { sha256Hex } from "../core/hash.ts";
import type { BuildArtifact, BuildResult, RunResult, TargetAbi } from "../core/types.ts";
import { canonicalFileEntries } from "../core/project-files.ts";
import type { CompileOptions } from "../sdk/types.ts";
import type { CompileInput } from "../sdk/project.ts";
import type { RunOptions } from "../sdk/types.ts";

export interface ConformanceHost {
  readonly id: string;
  compile(input: CompileInput, options?: CompileOptions): Promise<BuildResult>;
  run(artifact: BuildArtifact, options?: RunOptions): Promise<RunResult>;
}

export interface ConformanceCase {
  id: string;
  label: string;
  input: CompileInput & { target: TargetAbi };
  run?: RunOptions;
  expect: ConformanceRunExpectation;
}

export interface ConformanceRunExpectation {
  code: number;
  stdout: string;
  stderr?: string;
  termination: RunResult["termination"];
  logicalTimeNs?: number;
  trapMessageIncludes?: string;
  files?: Readonly<Record<string, string>>;
}

export interface ConformanceSample {
  host: string;
  caseId: string;
  caseLabel: string;
  success: boolean;
  artifactDigest?: string;
  artifactBytes?: number;
  firstUncachedCompileMs: number;
  repeatUncachedCompileMs?: number;
  runMedianMs?: number;
  transcript?: DeterministicTranscript;
  diagnostics: BuildResult["diagnostics"];
  error?: string;
}

export interface DeterministicTranscript {
  code: number;
  stdout: string;
  stderr: string;
  /** Collected guest output files encoded as lowercase hexadecimal bytes. */
  files: Readonly<Record<string, string>>;
  termination: RunResult["termination"];
  trapMessage?: string;
  determinism: RunResult["determinism"];
  resources: RunResult["resources"];
  metrics: RunResult["metrics"];
}

export interface ConformanceMismatch {
  caseId: string;
  baselineHost: string;
  comparedHost: string;
  fields: string[];
}

export interface ConformanceReport {
  compatible: boolean;
  repetitions: number;
  samples: ConformanceSample[];
  mismatches: ConformanceMismatch[];
  efficiency: Array<{
    caseId: string;
    host: string;
    firstUncachedCompileMs: number;
    repeatUncachedCompileMs?: number;
    runMedianMs?: number;
    artifactBytes?: number;
    netWeightedCost?: number | null;
    rawWeightedCost?: number | null;
    baselineWeightedCost?: number;
    logicalTimeNs?: number | null;
  }>;
}

export interface ConformanceSnapshot {
  schema: typeof FORGE_SCHEMAS.conformance;
  host: string;
  repetitions: number;
  caseIds: string[];
  samples: ConformanceSample[];
}

export interface ConformanceOptions {
  repetitions?: number;
  repeatCompile?: boolean;
  onSample?(sample: ConformanceSample, completed: number, total: number): void | Promise<void>;
}

export async function runConformanceMatrix(
  hosts: readonly ConformanceHost[],
  cases: readonly ConformanceCase[],
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  if (hosts.length === 0) throw new Error("A conformance matrix requires at least one host.");
  if (cases.length === 0) throw new Error("A conformance matrix requires at least one case.");
  const repetitions = options.repetitions ?? 3;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) {
    throw new RangeError("Conformance repetitions must be an integer from 1 through 100.");
  }
  const snapshots: ConformanceSnapshot[] = [];
  for (const host of hosts) snapshots.push(await runConformanceHost(host, cases, { ...options, repetitions }));
  return compareConformanceSnapshots(snapshots);
}

/** Run one host independently so browser and server snapshots can be produced in different processes. */
export async function runConformanceHost(
  host: ConformanceHost,
  cases: readonly ConformanceCase[],
  options: ConformanceOptions = {},
): Promise<ConformanceSnapshot> {
  if (cases.length === 0) throw new Error("A conformance snapshot requires at least one case.");
  const repetitions = options.repetitions ?? 3;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) {
    throw new RangeError("Conformance repetitions must be an integer from 1 through 100.");
  }
  const samples: ConformanceSample[] = [];
  for (const item of cases) {
    const sample = await sampleHost(host, item, repetitions, options.repeatCompile ?? true);
    samples.push(sample);
    await options.onSample?.(sample, samples.length, cases.length);
  }
  return {
    schema: FORGE_SCHEMAS.conformance,
    host: host.id,
    repetitions,
    caseIds: cases.map((item) => item.id),
    samples,
  };
}

/** Compare independently serialized snapshots and produce the efficiency matrix. */
export function compareConformanceSnapshots(
  snapshots: readonly ConformanceSnapshot[],
): ConformanceReport {
  if (snapshots.length === 0) throw new Error("At least one conformance snapshot is required.");
  const baseline = snapshots[0];
  if (!baseline) throw new Error("The conformance baseline is missing.");
  const hostIds = new Set<string>();
  for (const snapshot of snapshots) {
    validateConformanceSnapshot(snapshot);
    if (hostIds.has(snapshot.host)) throw new Error(`Duplicate conformance host '${snapshot.host}'.`);
    hostIds.add(snapshot.host);
    if (snapshot.repetitions !== baseline.repetitions) throw new Error("Conformance snapshots use different repetition counts.");
    if (JSON.stringify(snapshot.caseIds) !== JSON.stringify(baseline.caseIds)) {
      throw new Error(`Conformance host '${snapshot.host}' ran a different ordered case set.`);
    }
  }
  const samples = snapshots.flatMap((snapshot) => snapshot.samples);
  const mismatches = compareSnapshotSamples(snapshots);
  return {
    compatible: mismatches.length === 0 && samples.every((sample) => sample.success),
    repetitions: baseline.repetitions,
    samples,
    mismatches,
    efficiency: samples.map((sample) => ({
      caseId: sample.caseId,
      host: sample.host,
      firstUncachedCompileMs: sample.firstUncachedCompileMs,
      repeatUncachedCompileMs: sample.repeatUncachedCompileMs,
      runMedianMs: sample.runMedianMs,
      artifactBytes: sample.artifactBytes,
      netWeightedCost: sample.transcript?.metrics.cost,
      rawWeightedCost: sample.transcript?.metrics.rawCost,
      baselineWeightedCost: sample.transcript?.metrics.baselineCost,
      logicalTimeNs: sample.transcript?.metrics.logicalTimeNs,
    })),
  };
}

function validateConformanceSnapshot(snapshot: ConformanceSnapshot): void {
  if (!snapshot || typeof snapshot !== "object") throw new TypeError("Conformance snapshot must be an object.");
  if (snapshot.schema !== FORGE_SCHEMAS.conformance) {
    throw new Error(`Unsupported conformance schema '${String(snapshot.schema)}'.`);
  }
  if (!isIdentifier(snapshot.host)) throw new Error("Conformance snapshot host must be a non-empty trimmed identifier.");
  if (!Number.isInteger(snapshot.repetitions) || snapshot.repetitions < 1 || snapshot.repetitions > 100) {
    throw new RangeError("Conformance snapshot repetitions must be an integer from 1 through 100.");
  }
  if (!Array.isArray(snapshot.caseIds) || snapshot.caseIds.length === 0) {
    throw new Error(`Conformance host '${snapshot.host}' has no case IDs.`);
  }
  const caseIds = new Set<string>();
  for (const caseId of snapshot.caseIds) {
    if (!isIdentifier(caseId)) throw new Error(`Conformance host '${snapshot.host}' has an invalid case ID.`);
    if (caseIds.has(caseId)) throw new Error(`Conformance host '${snapshot.host}' repeats case '${caseId}'.`);
    caseIds.add(caseId);
  }
  if (!Array.isArray(snapshot.samples) || snapshot.samples.length !== caseIds.size) {
    throw new Error(
      `Conformance host '${snapshot.host}' must contain exactly one sample for each declared case.`,
    );
  }
  const sampledCases = new Set<string>();
  for (const sample of snapshot.samples) {
    if (!sample || typeof sample !== "object") throw new Error(`Conformance host '${snapshot.host}' has an invalid sample.`);
    if (sample.host !== snapshot.host) {
      throw new Error(`Conformance sample host '${String(sample.host)}' does not match '${snapshot.host}'.`);
    }
    if (!caseIds.has(sample.caseId)) {
      throw new Error(`Conformance host '${snapshot.host}' has an undeclared sample '${String(sample.caseId)}'.`);
    }
    if (!isIdentifier(sample.caseLabel)) {
      throw new Error(`Conformance sample '${sample.caseId}' has an invalid case label.`);
    }
    if (sampledCases.has(sample.caseId)) {
      throw new Error(`Conformance host '${snapshot.host}' repeats sample '${sample.caseId}'.`);
    }
    sampledCases.add(sample.caseId);
    if (typeof sample.success !== "boolean") {
      throw new Error(`Conformance sample '${sample.caseId}' has no boolean success state.`);
    }
    requireDuration(sample.firstUncachedCompileMs, `${sample.caseId}.firstUncachedCompileMs`);
    if (sample.repeatUncachedCompileMs !== undefined) {
      requireDuration(sample.repeatUncachedCompileMs, `${sample.caseId}.repeatUncachedCompileMs`);
    }
    if (!Array.isArray(sample.diagnostics)) {
      throw new Error(`Conformance sample '${sample.caseId}' has invalid diagnostics.`);
    }
    if (sample.success) {
      if (typeof sample.artifactDigest !== "string" || !/^[0-9a-f]{64}$/.test(sample.artifactDigest)) {
        throw new Error(`Successful conformance sample '${sample.caseId}' has no canonical artifact digest.`);
      }
      if (!Number.isSafeInteger(sample.artifactBytes) || (sample.artifactBytes ?? 0) < 1) {
        throw new Error(`Successful conformance sample '${sample.caseId}' has invalid artifact bytes.`);
      }
      requireDuration(sample.runMedianMs, `${sample.caseId}.runMedianMs`);
      if (!sample.transcript || typeof sample.transcript !== "object") {
        throw new Error(`Successful conformance sample '${sample.caseId}' has no deterministic transcript.`);
      }
    } else if (typeof sample.error !== "string" || !sample.error.trim()) {
      throw new Error(`Failed conformance sample '${sample.caseId}' has no error.`);
    }
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && value.length <= 256;
}

function requireDuration(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Conformance duration '${field}' must be a non-negative finite number.`);
  }
}

async function sampleHost(
  host: ConformanceHost,
  item: ConformanceCase,
  repetitions: number,
  repeatCompile: boolean,
): Promise<ConformanceSample> {
  const started = performance.now();
  try {
    const build = await host.compile(item.input, { cache: false });
    const firstUncachedCompileMs = performance.now() - started;
    if (!build.success || !build.artifact) {
      return {
        host: host.id,
        caseId: item.id,
        caseLabel: item.label,
        success: false,
        firstUncachedCompileMs,
        diagnostics: build.diagnostics,
        error: build.stderr || "Compilation failed without an artifact.",
      };
    }
    let repeatUncachedCompileMs: number | undefined;
    if (repeatCompile) {
      const repeatStarted = performance.now();
      const repeat = await host.compile(item.input, { cache: false });
      repeatUncachedCompileMs = performance.now() - repeatStarted;
      if (!repeat.success || !repeat.artifact) throw new Error("Repeated uncached compiler run failed.");
      const [firstDigest, repeatDigest] = await Promise.all([
        artifactDigest(build.artifact),
        artifactDigest(repeat.artifact),
      ]);
      if (firstDigest !== repeatDigest) throw new Error("Repeated uncached builds produced different artifacts.");
    }
    const durations: number[] = [];
    let transcript: DeterministicTranscript | undefined;
    for (let index = 0; index < repetitions; index += 1) {
      const run = await host.run(build.artifact, item.run);
      assertExpectedRun(item, run);
      durations.push(run.durationMs);
      const next = deterministicTranscript(run);
      if (transcript && diffPaths(transcript, next).length > 0) {
        throw new Error(`Host '${host.id}' produced a non-deterministic transcript for '${item.id}'.`);
      }
      transcript = next;
    }
    return {
      host: host.id,
      caseId: item.id,
      caseLabel: item.label,
      success: true,
      artifactDigest: await artifactDigest(build.artifact),
      artifactBytes: build.artifact.size,
      firstUncachedCompileMs,
      repeatUncachedCompileMs,
      runMedianMs: median(durations),
      transcript,
      diagnostics: build.diagnostics,
    };
  } catch (error) {
    return {
      host: host.id,
      caseId: item.id,
      caseLabel: item.label,
      success: false,
      firstUncachedCompileMs: performance.now() - started,
      diagnostics: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function assertExpectedRun(item: ConformanceCase, run: RunResult): void {
  const expected = item.expect;
  const mismatches: string[] = [];
  if (run.code !== expected.code) mismatches.push(`code ${run.code} (expected ${expected.code})`);
  if (run.stdout !== expected.stdout) {
    mismatches.push(`stdout ${JSON.stringify(run.stdout)} (expected ${JSON.stringify(expected.stdout)})`);
  }
  if (expected.stderr !== undefined && run.stderr !== expected.stderr) {
    mismatches.push(`stderr ${JSON.stringify(run.stderr)} (expected ${JSON.stringify(expected.stderr)})`);
  }
  if (run.termination !== expected.termination) {
    mismatches.push(`termination ${run.termination} (expected ${expected.termination})`);
  }
  if (expected.logicalTimeNs !== undefined && run.metrics.logicalTimeNs !== expected.logicalTimeNs) {
    mismatches.push(
      `logicalTimeNs ${String(run.metrics.logicalTimeNs)} (expected ${expected.logicalTimeNs})`,
    );
  }
  if (expected.trapMessageIncludes !== undefined && !run.trapMessage?.includes(expected.trapMessageIncludes)) {
    mismatches.push(
      `trapMessage ${JSON.stringify(run.trapMessage)} `
      + `(expected to include ${JSON.stringify(expected.trapMessageIncludes)})`,
    );
  }
  if (expected.files !== undefined) {
    const expectedPaths = Object.keys(expected.files).sort();
    const actualPaths = Object.keys(run.files).sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      mismatches.push(`files ${JSON.stringify(actualPaths)} (expected ${JSON.stringify(expectedPaths)})`);
    } else {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for (const path of expectedPaths) {
        const actual = decoder.decode(run.files[path]);
        if (actual !== expected.files[path]) {
          mismatches.push(`file ${path} ${JSON.stringify(actual)} (expected ${JSON.stringify(expected.files[path])})`);
        }
      }
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Conformance case '${item.id}' returned an unexpected result: ${mismatches.join(", ")}.`);
  }
}

function compareSnapshotSamples(snapshots: readonly ConformanceSnapshot[]): ConformanceMismatch[] {
  const mismatches: ConformanceMismatch[] = [];
  const baselineSnapshot = snapshots[0];
  if (!baselineSnapshot) return mismatches;
  for (const caseId of baselineSnapshot.caseIds) {
    const baseline = baselineSnapshot.samples.find((sample) => sample.caseId === caseId);
    if (!baseline?.success || !baseline.transcript) continue;
    for (const snapshot of snapshots.slice(1)) {
      const sample = snapshot.samples.find((candidate) => candidate.caseId === caseId);
      if (!sample?.success || !sample.transcript) {
        mismatches.push({ caseId, baselineHost: baseline.host, comparedHost: snapshot.host, fields: ["execution"] });
        continue;
      }
      const fields = diffPaths(baseline.transcript, sample.transcript);
      if (baseline.caseLabel !== sample.caseLabel) fields.unshift("caseLabel");
      if (baseline.artifactDigest !== sample.artifactDigest) fields.unshift("artifactDigest");
      if (fields.length > 0) {
        mismatches.push({ caseId, baselineHost: baseline.host, comparedHost: snapshot.host, fields });
      }
    }
  }
  return mismatches;
}

export function deterministicTranscript(run: RunResult): DeterministicTranscript {
  return {
    code: run.code,
    stdout: run.stdout,
    stderr: run.stderr,
    files: Object.fromEntries(Object.entries(run.files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, contents]) => [path, bytesToHex(contents)])),
    termination: run.termination,
    trapMessage: run.trapMessage,
    determinism: run.determinism,
    resources: run.resources,
    metrics: run.metrics,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export async function artifactDigest(artifact: BuildArtifact): Promise<string> {
  const metadata = {
    kind: artifact.kind,
    forgeContract: artifact.forgeContract,
    projectId: artifact.projectId,
    cacheKey: artifact.cacheKey,
    name: artifact.name,
    language: artifact.language,
    target: artifact.target,
    optimization: artifact.optimization,
    size: artifact.size,
    toolchains: artifact.toolchains,
    costProfile: artifact.costProfile,
  };
  if (artifact.kind === "wasm") {
    return sha256Hex(JSON.stringify({
      ...metadata,
      bytesSha256: await sha256Hex(artifact.bytes),
    }));
  }
  const files: Array<[string, string]> = [];
  for (const [path, contents] of canonicalFileEntries(artifact.files)) {
    files.push([path, await sha256Hex(typeof contents === "string" ? contents : contents)]);
  }
  return sha256Hex(JSON.stringify({
    ...metadata,
    runtimePackage: artifact.runtimePackage,
    command: artifact.command,
    entry: artifact.entry,
    manifest: artifact.manifest,
    files,
  }));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function diffPaths(left: unknown, right: unknown, path = ""): string[] {
  if (Object.is(left, right)) return [];
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return [path || "value"];
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  return [...keys].sort().flatMap((key) => diffPaths(
    leftRecord[key],
    rightRecord[key],
    path ? `${path}.${key}` : key,
  ));
}
