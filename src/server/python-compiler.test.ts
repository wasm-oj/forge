import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CostBaselineRegistry } from "../core/cost";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { DEFAULT_RESOURCE_POLICY } from "../core/resources";
import {
  PYTHON_PACKAGE,
  PYTHON_RUNTIME_FILES_ARCHIVE_SHA256,
} from "../core/toolchains";
import { createDefaultRuntimeDrivers } from "../runner/artifact";
import { PYTHON_RUNTIME_FILES_CACHE_KEY } from "../runner/runtime-files";
import { createSdkProject } from "../sdk/project";
import { ServerForgeCompiler } from "./server-compiler";
import { ServerForgeRunner } from "./server-runner";

describe("server CPython compiler", () => {
  it("byte-compiles, executes, and safely rebuilds a corrupt runtime-files cache", { timeout: 180_000 }, async () => {
    const compiler = new ServerForgeCompiler({
      compilerExecutable: process.execPath,
      toolchainDirectory: path.resolve("public/toolchains"),
    });
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-python-runtime-test-"));
    const runtimeExecutable = path.resolve("crates/runtime-core/target/debug/forge-runner");
    execFileSync("cargo", [
      "build",
      "--locked",
      "--manifest-path",
      "crates/runtime-core/Cargo.toml",
      "--bin",
      "forge-runner",
    ], { stdio: "pipe" });
    try {
      const valid = await compiler.build(createSdkProject({
        language: "python",
        target: "wasip1",
        entry: "src/main.py",
        files: {
          "src/helper.py": "answer = 42\n",
          "src/main.py": "from helper import answer\nprint(answer)\n",
        },
      }), "python-3.14.6-valid");
      expect(valid.success, valid.stderr).toBe(true);
      expect(valid.artifact).toMatchObject({
        kind: "runtime-bundle",
        target: "wasip1",
        command: "python",
        entry: "build/src/main.pyc",
      });
      if (valid.artifact?.kind !== "runtime-bundle") {
        throw new Error("CPython compilation produced no runtime bundle.");
      }
      const artifact = valid.artifact;
      expect(artifact.files["build/src/main.pyc"]).toBeInstanceOf(Uint8Array);
      expect(artifact.files["build/src/helper.pyc"]).toBeInstanceOf(Uint8Array);

      const runConfig = {
        args: [],
        stdin: "",
        env: {},
        determinism: { ...DEFAULT_DETERMINISM },
        resources: { ...DEFAULT_RESOURCE_POLICY },
      };
      const createRunner = () => new ServerForgeRunner({
        runtimeExecutable,
        toolchainDirectory: path.resolve("public/toolchains"),
        cacheDirectory,
        runtimeDrivers: createDefaultRuntimeDrivers(new CostBaselineRegistry({
          [artifact.costProfile]: 0,
        })),
      });
      const firstRunner = createRunner();
      try {
        await expect(firstRunner.run(artifact, runConfig)).resolves.toMatchObject({
          code: 0,
          stdout: "42\n",
          stderr: "",
          termination: "exited",
        });
        await expect(firstRunner.clearRuntimeCache()).resolves.toBeUndefined();
        await expect(firstRunner.run(artifact, runConfig)).resolves.toMatchObject({
          code: 0,
          stdout: "42\n",
          stderr: "",
          termination: "exited",
        });
      } finally {
        firstRunner.dispose();
      }

      const cacheIdentity = [
        PYTHON_PACKAGE,
        "python",
        PYTHON_RUNTIME_FILES_CACHE_KEY,
        PYTHON_RUNTIME_FILES_ARCHIVE_SHA256,
      ].join("\n");
      const cachePath = path.join(
        cacheDirectory,
        `${createHash("sha256").update(cacheIdentity).digest("hex")}.forgefs`,
      );
      await access(cachePath);
      await writeFile(cachePath, new Uint8Array([0, 1, 2, 3]));
      const corruptRunner = createRunner();
      try {
        await expect(corruptRunner.run(artifact, runConfig)).resolves.toMatchObject({
          code: 0,
          stdout: "42\n",
          stderr: "",
          termination: "exited",
        });
      } finally {
        corruptRunner.dispose();
      }
      expect(createHash("sha256").update(await readFile(cachePath)).digest("hex"))
        .toBe(PYTHON_RUNTIME_FILES_ARCHIVE_SHA256);

      const invalid = await compiler.build(createSdkProject({
        language: "python",
        target: "wasip1",
        entry: "src/main.py",
        files: { "src/main.py": "def broken(:\n    pass\n" },
      }), "python-3.14.6-invalid");
      expect(invalid.success).toBe(false);
      expect(invalid.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: "src/main.py",
          line: 1,
          severity: "error",
          source: "python",
        }),
      ]));
    } finally {
      compiler.dispose();
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });
});
