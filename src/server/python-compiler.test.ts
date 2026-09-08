import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CostBaselineRegistry, createDefaultRuntimeDrivers } from "@wasm-oj/core";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { DEFAULT_RESOURCE_POLICY } from "../core/resources";
import {
  PYTHON_PACKAGE,
  PYTHON_RUNTIME_FILES_ARCHIVE_SHA256,
} from "../core/toolchains";
import { PYTHON_RUNTIME_FILES_CACHE_KEY } from "../runner/runtime-files";
import { createSdkProject } from "../sdk/project";
import { ServerCompiler } from "./server-compiler";
import { ServerRunner } from "./server-runner";
import { testToolchains } from "./test-toolchains.test-helper";

describe("server CPython compiler", () => {
  it("packages sources, executes native Python semantics, and safely rebuilds a corrupt runtime-files cache", { timeout: 300_000 }, async () => {
    const compiler = new ServerCompiler({
      compilerExecutable: process.execPath,
      toolchains: testToolchains(),
    });
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-python-runtime-test-"));
    const runtimeExecutable = path.resolve("crates/runtime-core/target/debug/wasm-oj-runner");
    execFileSync("cargo", [
      "build",
      "--locked",
      "--manifest-path",
      "crates/runtime-core/Cargo.toml",
      "--bin",
      "wasm-oj-runner",
    ], { stdio: "pipe" });
    try {
      const valid = await compiler.build(createSdkProject({
        language: "python",
        target: "wasip1",
        entry: "nested/app/main.py",
        files: {
          "nested/app/helper.py": "answer = 42\n",
          "nested/app/main.py": "from helper import answer\nprint(answer)\n",
          "nested/app/unused.py": "def invalid(:",
        },
      }), "python-3.14.7-valid");
      expect(valid.success, valid.stderr).toBe(true);
      expect(valid.artifact).toMatchObject({
        kind: "runtime-bundle",
        target: "wasip1",
        command: "python",
        entry: "nested/app/main.py",
      });
      if (valid.artifact?.kind !== "runtime-bundle") {
        throw new Error("CPython packaging produced no runtime bundle.");
      }
      const artifact = valid.artifact;
      expect(artifact.files["nested/app/main.py"]).toBe("from helper import answer\nprint(answer)\n");
      expect(artifact.files["nested/app/helper.py"]).toBe("answer = 42\n");

      const runConfig = {
        args: [],
        stdin: "",
        env: {},
        determinism: { ...DEFAULT_DETERMINISM },
        resources: { ...DEFAULT_RESOURCE_POLICY },
      };
      const createRunner = () => new ServerRunner({
        runtimeExecutable,
        toolchains: testToolchains(),
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
        `${createHash("sha256").update(cacheIdentity).digest("hex")}.wasmojfs`,
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
        entry: "nested/app/main.py",
        files: { "nested/app/main.py": "def broken(:\n    pass\n" },
      }), "python-3.14.7-invalid");
      expect(invalid.success).toBe(true);
      expect(invalid.diagnostics).toEqual([]);
      if (invalid.artifact?.kind !== "runtime-bundle") throw new Error("Missing source bundle");
      const invalidRunner = createRunner();
      try {
        const result = await invalidRunner.run(invalid.artifact, {
          ...runConfig,
          determinism: { ...runConfig.determinism, clockMode: "host" },
          resources: { ...runConfig.resources, instructionBudget: Number.MAX_SAFE_INTEGER },
        });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("SyntaxError");
        expect(result.termination).toBe("exited");
      } finally {
        invalidRunner.dispose();
      }
    } finally {
      compiler.dispose();
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });
});
