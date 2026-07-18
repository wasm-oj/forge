import { describe, expect, it, vi } from "vitest";
import { FORGE_CONTRACT_VERSION } from "../core/contract.ts";
import { costProfileId } from "../core/cost-profile.ts";
import { DEFAULT_DETERMINISM } from "../core/determinism.ts";
import { DEFAULT_RESOURCE_POLICY, WEIGHTED_METER_MODEL } from "../core/resources.ts";
import { toolchainPackageIdentities } from "../core/toolchains.ts";
import type { BuildArtifact, Project, RunConfig, RunResult } from "../core/types.ts";
import { createSdkProject } from "../sdk/project.ts";
import {
  createForgeReplayBundle,
  decodeForgeReplayBundle,
  encodeForgeReplayBundle,
  forgeReplayBundleSha256,
  replayForgeBundle,
  type ForgeReplayHost,
} from "./bundle.ts";

describe("ForgeReplayBundle", () => {
  it("normalizes ephemeral metadata and round-trips one canonical binary transport", async () => {
    const input = fixture();
    const bundle = await createForgeReplayBundle({
      project: input.project,
      artifact: input.artifact,
      operation: { kind: "run", config: input.config, result: input.result },
    });
    expect(bundle.project.updatedAt).toBe(0);
    expect(bundle.artifact).toMatchObject({ id: `replay:${bundle.artifactSha256}`, createdAt: 0, durationMs: 0 });

    const first = await encodeForgeReplayBundle(bundle);
    const second = await encodeForgeReplayBundle(bundle);
    expect(second).toEqual(first);
    expect(await forgeReplayBundleSha256(bundle)).toMatch(/^[0-9a-f]{64}$/);
    expect(await decodeForgeReplayBundle(first)).toEqual(bundle);
  });

  it("rejects a byte-level payload mutation before replay", async () => {
    const input = fixture();
    const bundle = await createForgeReplayBundle({
      project: input.project,
      artifact: input.artifact,
      operation: { kind: "run", config: input.config, result: input.result },
    });
    const encoded = await encodeForgeReplayBundle(bundle);
    encoded[encoded.byteLength - 1] ^= 1;
    await expect(decodeForgeReplayBundle(encoded)).rejects.toThrow("integrity verification");
  });

  it("recompiles, compares stable artifact identity, and ignores wall duration", async () => {
    const input = fixture();
    const bundle = await createForgeReplayBundle({
      project: input.project,
      artifact: input.artifact,
      operation: { kind: "run", config: input.config, result: input.result },
    });
    const compileProject = vi.fn(async () => ({
      success: true,
      diagnostics: [],
      artifact: { ...input.artifact, id: "different-ephemeral-id", createdAt: 999, durationMs: 42 },
      stdout: "",
      stderr: "",
      cacheHit: false,
    }));
    const run = vi.fn(async () => ({ ...input.result, durationMs: 999 }));
    const host: ForgeReplayHost = {
      compileProject,
      run,
      judge: async () => { throw new Error("not used"); },
    };

    const replayed = await replayForgeBundle(host, bundle);
    expect(replayed).toMatchObject({ compatible: true, mismatches: [] });
    expect(compileProject).toHaveBeenCalledWith(expect.objectContaining({ updatedAt: 0 }), { cache: false });
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports precise deterministic transcript mismatch paths", async () => {
    const input = fixture();
    const bundle = await createForgeReplayBundle({
      project: input.project,
      artifact: input.artifact,
      operation: { kind: "run", config: input.config, result: input.result },
    });
    const host: ForgeReplayHost = {
      compileProject: async () => { throw new Error("not used"); },
      run: async () => ({ ...input.result, stdout: "43\n" }),
      judge: async () => { throw new Error("not used"); },
    };
    const replayed = await replayForgeBundle(host, bundle, { recompile: false });
    expect(replayed.compatible).toBe(false);
    expect(replayed.mismatches).toEqual(["run.stdout"]);
  });

  it("requires judge provider inputs to be materialized for offline replay", async () => {
    const input = fixture();
    await expect(createForgeReplayBundle({
      project: input.project,
      artifact: input.artifact,
      operation: {
        kind: "judge",
        spec: {
          version: FORGE_CONTRACT_VERSION,
          cases: [{
            id: "secret",
            kind: "batch",
            input: { kind: "provider", provider: "cases", key: "1" },
            matcher: { id: "text", config: { expected: "42\n" } },
          }],
        },
        result: {
          verdict: "accepted",
          completed: 1,
          total: 1,
          cases: [{ id: "secret", verdict: "accepted", run: input.result }],
          metrics: {
            cost: 0,
            rawCost: 1,
            baselineCost: 1,
            logicalTimeNs: 1,
            maxMemoryBytes: 1,
            maxFilesystemBytes: 0,
            maxFilesystemEntries: 0,
            stdoutBytes: 3,
            stderrBytes: 0,
          },
        },
      },
    })).rejects.toThrow("materialized inline");
  });

  it("round-trips and replays a self-contained judge transcript", async () => {
    const input = fixture();
    const spec = {
      version: FORGE_CONTRACT_VERSION,
      cases: [{
        id: "sample",
        kind: "batch" as const,
        input: { kind: "inline" as const, value: "" },
        matcher: { id: "text", config: { expected: "42\n" } },
      }],
    };
    const result = {
      verdict: "accepted" as const,
      completed: 1,
      total: 1,
      cases: [{ id: "sample", verdict: "accepted" as const, run: input.result }],
      metrics: {
        cost: 0,
        rawCost: 1,
        baselineCost: 1,
        logicalTimeNs: 1,
        maxMemoryBytes: 65_536,
        maxFilesystemBytes: 3,
        maxFilesystemEntries: 1,
        stdoutBytes: 3,
        stderrBytes: 0,
      },
    };
    const bundle = await createForgeReplayBundle({
      project: input.project,
      artifact: input.artifact,
      operation: { kind: "judge", spec, result },
    });
    const decoded = await decodeForgeReplayBundle(await encodeForgeReplayBundle(bundle));
    const host: ForgeReplayHost = {
      compileProject: async () => { throw new Error("not used"); },
      run: async () => { throw new Error("not used"); },
      judge: async () => ({
        ...result,
        cases: [{ ...result.cases[0]!, run: { ...input.result, durationMs: 999 } }],
      }),
    };
    await expect(replayForgeBundle(host, decoded, { recompile: false })).resolves.toMatchObject({
      compatible: true,
      mismatches: [],
    });
  });
});

function fixture(): { project: Project; artifact: BuildArtifact; config: RunConfig; result: RunResult } {
  const project = createSdkProject({
    language: "c",
    target: "wasip1",
    entry: "src/main.c",
    files: { "src/main.c": "int main(void){return 0;}\n" },
    name: "replay",
    projectId: "replay-project",
  });
  const costProfile = costProfileId("c", "wasip1", "release");
  const artifact: BuildArtifact = {
    kind: "wasm",
    forgeContract: FORGE_CONTRACT_VERSION,
    id: "original-artifact",
    projectId: project.id,
    cacheKey: "replay-cache-key",
    name: "replay.wasm",
    language: "c",
    target: "wasip1",
    optimization: "release",
    createdAt: 123,
    durationMs: 456,
    size: 8,
    toolchains: toolchainPackageIdentities("c"),
    costProfile,
    bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  };
  const config: RunConfig = {
    args: [],
    stdin: "",
    env: {},
    files: { "/input.txt": new TextEncoder().encode("42\n") },
    outputPaths: ["/answer.txt"],
    determinism: { ...DEFAULT_DETERMINISM },
    resources: { ...DEFAULT_RESOURCE_POLICY },
  };
  const result: RunResult = {
    code: 0,
    stdout: "42\n",
    stderr: "",
    files: { "/answer.txt": new TextEncoder().encode("42\n") },
    durationMs: 10,
    determinism: { ...DEFAULT_DETERMINISM },
    resources: { ...DEFAULT_RESOURCE_POLICY },
    termination: "exited",
    metrics: {
      cost: 0,
      rawCost: 1,
      baselineCost: 1,
      costProfile,
      costModel: WEIGHTED_METER_MODEL,
      operations: {},
      memoryBytes: 65_536,
      logicalTimeNs: 1_000_000,
      filesystemBytes: 3,
      filesystemEntries: 1,
      stdoutBytes: 3,
      stderrBytes: 0,
    },
  };
  return { project, artifact, config, result };
}
