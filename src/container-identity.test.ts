import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerToolchainSource } from "@wasm-oj/contracts";
import {
  assertExpectedContainerIdentity,
  loadEmbeddedContainerIdentity,
  type ContainerVerifiedDistributionEvidence,
} from "../container/identity.mjs";
import {
  computeFileTreeIdentity,
  computeFileTreeInventory,
  deriveFileTreeInventory,
} from "../container/tree-digest.mjs";

const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

describe("embedded container identity", () => {
  it("binds pnpm-style internal symlinks and rejects root escapes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-container-tree-"));
    const root = path.join(directory, "app");
    await mkdir(root);
    await writeFile(path.join(root, "physical-package.js"), "export default 1");
    await symlink("physical-package.js", path.join(root, "package.js"));
    await expect(computeFileTreeIdentity(root)).rejects.toThrow("symlink or special file");
    await expect(computeFileTreeIdentity(root, { allowInternalSymlinks: true })).resolves.toMatchObject({ entries: 2 });
    await mkdir(path.join(root, "runtime"));
    await symlink("../physical-package.js", path.join(root, "runtime", "outside-runtime.js"));
    const inventory = await computeFileTreeInventory(root, { allowInternalSymlinks: true });
    expect(() => deriveFileTreeInventory(inventory, "runtime")).toThrow("symlink or special file");
    await writeFile(path.join(directory, "outside.js"), "outside");
    await symlink("../outside.js", path.join(root, "escape.js"));
    await expect(computeFileTreeIdentity(root, { allowInternalSymlinks: true })).rejects.toThrow("escapes its root");
  });

  it("verifies canonical metadata and actual native executables", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-container-identity-"));
    const runtimePath = path.join(directory, "runtime");
    const toolchainPath = path.join(directory, "toolchains");
    const releasePath = path.join(directory, "release");
    await Promise.all([mkdir(runtimePath), mkdir(toolchainPath), mkdir(releasePath)]);
    const compiler = Buffer.from("compiler");
    const runner = Buffer.from("runner");
    const compilerPath = path.join(runtimePath, "compiler");
    const runnerPath = path.join(runtimePath, "runner");
    await Promise.all([
      writeFile(compilerPath, compiler),
      writeFile(runnerPath, runner),
      writeFile(path.join(toolchainPath, "clang.wasm"), "toolchain"),
      writeFile(path.join(directory, "server.mjs"), "server"),
    ]);
    await Promise.all([chmod(compilerPath, 0o755), chmod(runnerPath, 0o755)]);
    const [runtimeTree, toolchainTree, executionTree] = await Promise.all([
      computeFileTreeIdentity(runtimePath),
      computeFileTreeIdentity(toolchainPath),
      computeFileTreeIdentity(directory, { excludedRelativePaths: ["release"] }),
    ]);
    const identity = {
      compilerSha256: digest(compiler), contract: 2, executionRootSha256: executionTree.rootSha256, gitCommit: "a".repeat(40),
      protocol: "wasm-oj-container-v2", releaseId: "018f0f2e-7b3c-7f51-8b36-df6ec12f8d31", runnerSha256: digest(runner),
      runtimeRootSha256: runtimeTree.rootSha256, schema: "wasm-oj-platform/container-identity/v2", toolchainRootSha256: toolchainTree.rootSha256,
    };
    const identityPath = path.join(releasePath, "identity.json");
    await writeFile(identityPath, `${JSON.stringify(identity)}\n`);
    const toolchains: readonly ServerToolchainSource[] = [{
      kind: "server",
      directory: new URL(`file://${toolchainPath}/`),
      descriptor: {
        schema: "wasm-oj-v2/toolchain-package",
        id: "test",
        version: "1.0.0",
        wasmOjContract: 2,
        languages: ["c"],
        profiles: [{ language: "c", target: "wasip1", optimization: "release" }],
        assets: [{
          path: "/toolchains/clang.wasm",
          bytes: Buffer.byteLength("toolchain"),
          sha256: digest("toolchain"),
          exportPath: "./assets/clang.wasm",
        }],
      },
    }];
    const paths = {
      identityPath,
      compilerPath,
      runnerPath,
      runtimePath,
      toolchainPath,
      executionPath: directory,
      executionExcludedRelativePaths: ["release"],
      toolchains,
      createVerifiedServerDistribution: (evidence: ContainerVerifiedDistributionEvidence) => Object.freeze({
        compilerExecutable: evidence.compilerExecutable,
        runtimeExecutable: evidence.runtimeExecutable,
        toolchainAssetFiles: Object.fromEntries(evidence.toolchains.flatMap((source) => (
          source.descriptor.assets.map((asset) => [asset.path, path.join(toolchainPath, path.basename(asset.path))])
        ))),
        toolchainRootSha256: evidence.toolchainRootSha256,
      }),
    };
    const actual = await loadEmbeddedContainerIdentity(paths);
    expect(actual.verifiedDistribution).toMatchObject({
      compilerExecutable: compilerPath,
      runtimeExecutable: runnerPath,
      toolchainAssetFiles: expect.any(Object),
    });
    expect(() => assertExpectedContainerIdentity({ expectedReleaseId: identity.releaseId, expectedContainerIdentitySha256: actual.identitySha256 }, actual)).not.toThrow();
    expect(() => assertExpectedContainerIdentity({ expectedReleaseId: crypto.randomUUID(), expectedContainerIdentitySha256: actual.identitySha256 }, actual)).toThrow("does not match");
    await writeFile(path.join(toolchainPath, "clang.wasm"), "tampered");
    await expect(loadEmbeddedContainerIdentity(paths)).rejects.toThrow("tree digest mismatch");
    await writeFile(path.join(toolchainPath, "clang.wasm"), "toolchain");
    await writeFile(path.join(directory, "server.mjs"), "tampered server");
    await expect(loadEmbeddedContainerIdentity(paths)).rejects.toThrow("execution tree digest mismatch");
  });
});
