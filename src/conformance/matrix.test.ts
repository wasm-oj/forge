import { describe, expect, it } from "vitest";
import { FORGE_CONTRACT_VERSION } from "../core/contract";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { DEFAULT_RESOURCE_POLICY, WEIGHTED_METER_MODEL } from "../core/resources";
import type { BuildArtifact, RunResult } from "../core/types";
import {
  artifactDigest,
  compareConformanceSnapshots,
  deterministicTranscript,
  runConformanceHost,
  runConformanceMatrix,
  type ConformanceHost,
} from "./matrix";

const artifact: BuildArtifact = {
  kind: "wasm",
  forgeContract: FORGE_CONTRACT_VERSION,
  id: "ignored-host-observation",
  projectId: "project",
  cacheKey: "cache",
  name: "app.wasm",
  language: "c",
  target: "wasip1",
  optimization: "release",
  createdAt: 0,
  durationMs: 0,
  size: 8,
  toolchains: [],
  costProfile: "test-cost-profile",
  bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
};

function result(stdout = "42\n"): RunResult {
  return {
    code: 0,
    stdout,
    stderr: "",
    files: {},
    durationMs: 2,
    termination: "exited",
    determinism: { ...DEFAULT_DETERMINISM },
    resources: { ...DEFAULT_RESOURCE_POLICY },
    metrics: {
      cost: 7,
      rawCost: 10,
      baselineCost: 3,
      costProfile: artifact.costProfile,
      costModel: WEIGHTED_METER_MODEL,
      operations: { I32Const: 2, I32Add: 1 },
      memoryBytes: 65_536,
      logicalTimeNs: 1_000_000,
      filesystemBytes: 0,
      filesystemEntries: 0,
      stdoutBytes: stdout.length,
      stderrBytes: 0,
    },
  };
}

function host(id: string, stdout = "42\n"): ConformanceHost {
  return {
    id,
    async compile() {
      return { success: true, diagnostics: [], artifact: { ...artifact, id: crypto.randomUUID() }, stdout: "", stderr: "", cacheHit: false };
    },
    async run() {
      return result(stdout);
    },
  };
}

const cases = [{
  id: "sum",
  label: "C / wasip1 / sum",
  input: {
    language: "c" as const,
    target: "wasip1" as const,
    entry: "main.c",
    files: { "main.c": "int main(void){return 0;}" },
  },
  expect: {
    code: 0,
    stdout: "42\n",
    stderr: "",
    termination: "exited" as const,
    logicalTimeNs: 1_000_000,
  },
}];

describe("conformance matrix", () => {
  it("compares deterministic transcripts and records efficiency observations", async () => {
    const report = await runConformanceMatrix([host("browser"), host("server")], cases, { repetitions: 2 });
    expect(report.compatible).toBe(true);
    expect(report.mismatches).toEqual([]);
    expect(report.samples).toHaveLength(2);
    expect(report.efficiency.every((row) => (
      row.netWeightedCost === 7 && row.rawWeightedCost === 10 && row.baselineWeightedCost === 3
    ))).toBe(true);
  });

  it("marks an unexpected program result as an execution mismatch", async () => {
    const report = await runConformanceMatrix([host("browser"), host("server", "430\n")], cases, { repetitions: 1, repeatCompile: false });
    expect(report.compatible).toBe(false);
    expect(report.mismatches).toContainEqual(expect.objectContaining({ fields: ["execution"] }));
  });

  it("reports precise fields when two successful serialized snapshots diverge", async () => {
    const browser = await runConformanceHost(host("browser"), cases, { repetitions: 1 });
    const server = structuredClone(browser);
    server.host = "server";
    const sample = server.samples[0];
    if (!sample?.transcript) throw new Error("Fixture transcript is missing.");
    sample.host = "server";
    sample.transcript.stdout = "430\n";
    sample.transcript.metrics.stdoutBytes = 4;
    const report = compareConformanceSnapshots([browser, server]);
    expect(report.mismatches).toContainEqual(expect.objectContaining({
      fields: expect.arrayContaining(["stdout", "metrics.stdoutBytes"]),
    }));
  });

  it("treats case labels as cross-host contract data", async () => {
    const browser = await runConformanceHost(host("browser"), cases, { repetitions: 1 });
    const server = structuredClone(browser);
    server.host = "server";
    server.samples[0]!.host = "server";
    server.samples[0]!.caseLabel = "Different label";
    expect(compareConformanceSnapshots([browser, server]).mismatches).toContainEqual(expect.objectContaining({
      fields: ["caseLabel"],
    }));
  });

  it("compares snapshots produced in independent host processes", async () => {
    const browser = await runConformanceHost(host("browser"), cases, { repetitions: 2 });
    const server = await runConformanceHost(host("server"), cases, { repetitions: 2 });
    expect(compareConformanceSnapshots([browser, server])).toMatchObject({
      compatible: true,
      repetitions: 2,
      mismatches: [],
    });
  });

  it("rejects incomplete or host-mismatched serialized snapshots", async () => {
    const snapshot = await runConformanceHost(host("browser"), cases, { repetitions: 1 });
    expect(() => compareConformanceSnapshots([{ ...snapshot, samples: [] }]))
      .toThrow("exactly one sample");
    expect(() => compareConformanceSnapshots([{
      ...snapshot,
      samples: [{ ...snapshot.samples[0]!, host: "server" }],
    }])).toThrow("does not match");
  });

  it("rejects duplicate samples and successful samples without proof", async () => {
    const snapshot = await runConformanceHost(host("browser"), cases, { repetitions: 1 });
    expect(() => compareConformanceSnapshots([{
      ...snapshot,
      caseIds: ["sum", "other"],
      samples: [snapshot.samples[0]!, snapshot.samples[0]!],
    }])).toThrow("repeats sample");
    const { transcript, ...withoutTranscript } = snapshot.samples[0]!;
    expect(transcript).toBeDefined();
    expect(() => compareConformanceSnapshots([{
      ...snapshot,
      samples: [withoutTranscript],
    }])).toThrow("deterministic transcript");
  });

  it("fails a sample when execution does not satisfy the declared result", async () => {
    const snapshot = await runConformanceHost(host("server", "wrong\n"), cases, {
      repetitions: 1,
      repeatCompile: false,
    });
    expect(snapshot.samples[0]).toMatchObject({
      success: false,
      error: expect.stringContaining("unexpected result"),
    });
  });

  it("fails a sample when virtual-clock consumption does not satisfy the declared result", async () => {
    const wrongClock: ConformanceHost = {
      ...host("server"),
      async run() {
        const run = result();
        run.metrics.logicalTimeNs = 2_000_000;
        return run;
      },
    };
    const snapshot = await runConformanceHost(wrongClock, cases, {
      repetitions: 1,
      repeatCompile: false,
    });
    expect(snapshot.samples[0]).toMatchObject({
      success: false,
      error: expect.stringContaining("logicalTimeNs 2000000 (expected 1000000)"),
    });
  });

  it("includes policy-defined trap details in the deterministic transcript", () => {
    const trapped = {
      ...result(""),
      code: 1,
      termination: "trap" as const,
      trapMessage: "Forge denied nondeterministic capability wasix_32v1.thread_spawn",
    };
    expect(deterministicTranscript(trapped)).toMatchObject({
      code: 1,
      termination: "trap",
      trapMessage: trapped.trapMessage,
    });
  });

  it("binds semantic artifact metadata while excluding host observations", async () => {
    const observed = { ...artifact, id: "other", createdAt: 99, durationMs: 42 };
    expect(await artifactDigest(observed)).toBe(await artifactDigest(artifact));
    expect(await artifactDigest({ ...observed, toolchains: ["different"] }))
      .not.toBe(await artifactDigest(artifact));
    expect(await artifactDigest({ ...observed, target: "wasix" }))
      .not.toBe(await artifactDigest(artifact));
  });
});
