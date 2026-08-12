import path from "node:path";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { PINNED_TOOLCHAIN_ASSET_SHA256 } from "../core/toolchains";
import { createServerEngine, resolveServerPaths } from "./factory";
import { createVerifiedServerDistribution } from "./verified-distribution";
import { testToolchains } from "./test-toolchains.test-helper";

describe("server WASM-OJ factory", () => {
  it("resolves only the explicitly provisioned runtime and toolchains", () => {
    const runtimeDirectory = path.resolve("runtime");
    const toolchains = testToolchains();
    const paths = resolveServerPaths({ runtimeDirectory, toolchains });

    expect(paths.compilerExecutable).toBe(path.join(
      runtimeDirectory,
      process.platform === "win32" ? "wasm-oj-compiler.exe" : "wasm-oj-compiler",
    ));
    expect(paths.runtimeExecutable).toContain("wasm-oj-runner");
    expect(paths.toolchains).toHaveLength(1);
    expect(path.isAbsolute(paths.cacheDirectory)).toBe(true);
  });

  it("reports missing provisioned binaries through the stable initialization error", async () => {
    await expect(createServerEngine({
      runtimeDirectory: path.join(process.cwd(), "does-not-exist"),
      toolchains: testToolchains(),
    })).rejects.toMatchObject({
      code: "initialization-failure",
      stage: "initialize",
      retryable: false,
    });
  });

  it("accepts one verified inventory capability without rescanning pinned assets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-verified-distribution-"));
    const runtimeDirectory = path.join(root, "runtime");
    const toolchainPackageDirectory = path.join(root, "toolchains");
    const cacheDirectory = path.join(root, "cache");
    const compilerExecutable = path.join(runtimeDirectory, process.platform === "win32" ? "wasm-oj-compiler.exe" : "wasm-oj-compiler");
    const runtimeExecutable = path.join(runtimeDirectory, process.platform === "win32" ? "wasm-oj-runner.exe" : "wasm-oj-runner");
    await Promise.all([mkdir(runtimeDirectory), mkdir(toolchainPackageDirectory)]);
    await Promise.all([writeFile(compilerExecutable, "compiler"), writeFile(runtimeExecutable, "runner")]);
    await Promise.all([chmod(compilerExecutable, 0o755), chmod(runtimeExecutable, 0o755)]);
    const toolchains = testToolchains(toolchainPackageDirectory, path.resolve("public/toolchains"));
    const verifiedDistribution = createVerifiedServerDistribution({
      compilerExecutable,
      compilerSha256: "1".repeat(64),
      runtimeExecutable,
      runnerSha256: "2".repeat(64),
      toolchains,
      toolchainRootSha256: "3".repeat(64),
      toolchainAssets: { ...PINNED_TOOLCHAIN_ASSET_SHA256 },
    });

    try {
      const engine = await createServerEngine({
        runtimeDirectory,
        toolchains,
        cacheDirectory,
        artifactCache: false,
        verifiedDistribution,
      });
      engine.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
