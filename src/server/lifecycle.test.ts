import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FORGE_CONTRACT_VERSION } from "../core/contract";
import { costProfileId } from "../core/cost-profile";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { DEFAULT_RESOURCE_POLICY } from "../core/resources";
import type { BuildArtifact, Project, RunConfig } from "../core/types";
import { RuntimeDriverRegistry } from "../runner/artifact";
import { ServerForgeCompiler } from "./server-compiler";
import { ServerForgeRunner } from "./server-runner";

const TEST_COST_PROFILE = costProfileId("zig", "wasip1", "release", "test-content");
describe("server host lifecycle", () => {
  it("serializes compiler operations and releases cancelled builds synchronously", async () => {
    const compiler = new ServerForgeCompiler({
      compilerExecutable: process.execPath,
      toolchainDirectory: path.resolve("public/toolchains"),
    });
    const first = compiler.build(javascriptProject(), "first");
    const firstAssertion = expect(first).rejects.toThrow("superseded");
    await expect(compiler.build(javascriptProject(), "concurrent")).rejects.toThrow("one active operation");

    compiler.cancel();
    const retry = compiler.build(javascriptProject(), "retry");
    const retryAssertion = expect(retry).rejects.toThrow("superseded");
    compiler.cancel();
    await Promise.all([firstAssertion, retryAssertion]);

    const clearing = compiler.clearToolchainCache();
    await expect(compiler.build(javascriptProject(), "during-clear")).rejects.toThrow("one active operation");
    await clearing;
    compiler.dispose();
    await expect(compiler.ready()).rejects.toThrow("disposed");
  });

  it("cancels stalled custom preparation and reaches cache-safe quiescence", async () => {
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-runner-lifecycle-"));
    const runtimeDrivers = new RuntimeDriverRegistry();
    runtimeDrivers.register({
      id: "stalled-test-driver",
      supports: (artifact) => artifact.kind === "wasm",
      prepare: () => new Promise(() => undefined),
    });
    const runner = new ServerForgeRunner({
      runtimeExecutable: process.execPath,
      toolchainDirectory: path.resolve("public/toolchains"),
      cacheDirectory,
      runtimeDrivers,
    });
    try {
      const first = runner.run(wasmArtifact(), runConfig());
      const firstAssertion = expect(first).rejects.toThrow("superseded");
      await expect(runner.run(wasmArtifact(), runConfig())).rejects.toThrow("one active operation");

      await runner.cancelAndWait();
      await firstAssertion;
      const retry = runner.run(wasmArtifact(), runConfig());
      const retryAssertion = expect(retry).rejects.toThrow("superseded");
      runner.cancel();
      await expect(runner.clearRuntimeCache()).rejects.toThrow("still in flight");

      await retryAssertion;
      await expect(runner.clearRuntimeCache()).resolves.toBeUndefined();
    } finally {
      runner.dispose();
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });
});

function javascriptProject(): Project {
  return {
    id: "project",
    name: "project",
    files: [{ path: "main.js", language: "javascript", content: "" }],
    activeFile: "main.js",
    updatedAt: 0,
    config: {
      language: "javascript",
      target: "wasip1",
      optimization: "release",
      entry: "main.js",
      args: [],
      stdin: "",
      env: {},
      determinism: { ...DEFAULT_DETERMINISM },
      resources: { ...DEFAULT_RESOURCE_POLICY },
    },
  };
}

function wasmArtifact(): BuildArtifact {
  return {
    kind: "wasm",
    forgeContract: FORGE_CONTRACT_VERSION,
    id: "artifact",
    projectId: "project",
    cacheKey: "cache",
    name: "project.wasm",
    language: "zig",
    target: "wasip1",
    optimization: "release",
    createdAt: 0,
    durationMs: 0,
    size: 8,
    toolchains: ["zig-test-toolchain"],
    costProfile: TEST_COST_PROFILE,
    bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  };
}

function runConfig(): RunConfig {
  return {
    args: [],
    stdin: "",
    env: {},
    determinism: { ...DEFAULT_DETERMINISM },
    resources: { ...DEFAULT_RESOURCE_POLICY },
  };
}
