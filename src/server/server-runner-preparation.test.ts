import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FORGE_CONTRACT_VERSION } from "../core/contract";
import { costProfileId } from "../core/cost-profile";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { DEFAULT_RESOURCE_POLICY } from "../core/resources";
import { PYTHON_PACKAGE } from "../core/toolchains";
import type { BuildArtifact, RunConfig } from "../core/types";
import { RuntimeDriverRegistry } from "../runner/artifact";

const spawnState = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: spawnState.spawn };
});

import { ServerForgeRunner } from "./server-runner";

const TEST_COST_PROFILE = costProfileId("zig", "wasip1", "release", "runner-stage-test");
const temporaryDirectories = new Set<string>();

beforeEach(() => {
  spawnState.spawn.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("ServerForgeRunner isolated preparation lifecycle", () => {
  it.each(["cancel", "restart", "dispose"] as const)(
    "%s terminates and releases a stage that never closes",
    async (action) => {
      const child = stalledChild();
      spawnState.spawn.mockReturnValue(child);
      const runner = await createRunner();
      const running = runner.run(wasmArtifact(), runConfig());
      const rejection = expect(running).rejects.toThrow(/cancel|superseded|disposed/i);
      await vi.waitFor(() => expect(spawnState.spawn).toHaveBeenCalledOnce());

      runner[action]();

      await rejection;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      if (action !== "dispose") runner.dispose();
    },
  );

  it("cancelAndWait reaches cache-safe quiescence without a child close event", async () => {
    const child = stalledChild();
    spawnState.spawn.mockReturnValue(child);
    const runner = await createRunner();
    try {
      const running = runner.run(wasmArtifact(), runConfig());
      const rejection = expect(running).rejects.toThrow(/cancel|superseded/i);
      await vi.waitFor(() => expect(spawnState.spawn).toHaveBeenCalledOnce());

      await expect(runner.cancelAndWait()).resolves.toBeUndefined();
      await rejection;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      await expect(runner.clearRuntimeCache()).resolves.toBeUndefined();
    } finally {
      runner.dispose();
    }
  });

  it("enforces the 120-second preparation deadline before native guest execution", async () => {
    const child = stalledChild();
    spawnState.spawn.mockReturnValue(child);
    const runner = await createRunner();
    try {
      vi.useFakeTimers();
      const running = runner.run(wasmArtifact(), runConfig());
      const rejection = expect(running).rejects.toThrow(
        "Server runtime preparation exceeded 120000 ms.",
      );
      await vi.waitFor(() => expect(spawnState.spawn).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(120_000);

      await rejection;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(spawnState.spawn).toHaveBeenCalledOnce();
    } finally {
      runner.dispose();
    }
  });

  it.each(["stdout", "stderr"] as const)(
    "kills native runtime-core when protocol %s exceeds its host transport cap",
    async (stream) => {
      const child = stalledChild();
      spawnState.spawn.mockReturnValue(child);
      const runner = await createNativeRunner();
      try {
        const config = runConfig();
        config.resources.outputLimitBytes = 1;
        const running = runner.run(wasmArtifact(), config);
        const rejection = expect(running).rejects.toThrow("transport boundary");
        await vi.waitFor(() => expect(spawnState.spawn).toHaveBeenCalledOnce());

        child[stream].write(Buffer.alloc(stream === "stdout" ? 3 * 1024 * 1024 : 2 * 1024 * 1024));

        await rejection;
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        runner.dispose();
      }
    },
  );
});

async function createRunner(): Promise<ServerForgeRunner> {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-stalled-runner-stage-"));
  temporaryDirectories.add(cacheDirectory);
  const runtimeDrivers = new RuntimeDriverRegistry();
  runtimeDrivers.register({
    id: "stalled-package-command",
    supports: (artifact) => artifact.kind === "wasm",
    prepare: async (_artifact, _config, resolver) => {
      await resolver.packageCommand(PYTHON_PACKAGE, "python");
      throw new Error("The stalled package stage unexpectedly completed.");
    },
  });
  const runner = new ServerForgeRunner({
    runtimeExecutable: process.execPath,
    toolchainDirectory: path.resolve("public/toolchains"),
    cacheDirectory,
    runtimeDrivers,
  });
  await runner.ready();
  return runner;
}

async function createNativeRunner(): Promise<ServerForgeRunner> {
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-native-transport-"));
  temporaryDirectories.add(cacheDirectory);
  const runner = new ServerForgeRunner({
    runtimeExecutable: process.execPath,
    toolchainDirectory: path.resolve("public/toolchains"),
    cacheDirectory,
    additionalCostBaselines: { [TEST_COST_PROFILE]: 0 },
  });
  await runner.ready();
  return runner;
}

function stalledChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    stdio: [PassThrough, PassThrough, PassThrough];
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr];
  child.kill = vi.fn(() => true);
  return child;
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
