import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createForgeEngine } from "../sdk/engine";
import { createSdkProject } from "../sdk/project";
import { ServerForgeCompiler } from "./server-compiler";
import { ServerForgeRunner } from "./server-runner";

describe("server compiler and runner", () => {
  it("rejects malformed direct compiler inputs before starting an isolated stage", async () => {
    const compiler = new ServerForgeCompiler({
      compilerExecutable: process.execPath,
      toolchainDirectory: path.resolve("public/toolchains"),
    });
    const malformed = createSdkProject({
      language: "javascript",
      entry: "main.js",
      files: { "main.js": "" },
    });
    malformed.config.args = [1] as unknown as string[];
    try {
      await expect(compiler.build(malformed, "cache-key")).rejects.toThrow("arguments must contain only strings");
      await expect(compiler.build(createSdkProject({
        language: "javascript",
        entry: "main.js",
        files: { "main.js": "" },
      }), " ")).rejects.toThrow("cache keys must be non-empty");
    } finally {
      compiler.dispose();
    }
  });

  it("captures complete Rust warning and error diagnostics", { timeout: 300_000 }, async () => {
    const compiler = new ServerForgeCompiler({
      compilerExecutable: process.execPath,
      toolchainDirectory: path.resolve("public/toolchains"),
    });
    await compiler.ready();
    try {
      const warning = await compiler.build(createSdkProject({
        language: "rust",
        target: "wasip1",
        entry: "src/main.rs",
        files: { "src/main.rs": "fn main() { let unused = 42; println!(\"ok\"); }\n" },
      }), "rust-warning-diagnostic-test");
      expect(warning.success, warning.stderr).toBe(true);
      expect(warning.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          source: "rustc",
          code: "unused_variables",
          file: "src/main.rs",
          line: 1,
        }),
      ]));
      const warningRepeat = await compiler.build(createSdkProject({
        language: "rust",
        target: "wasip1",
        entry: "src/main.rs",
        files: { "src/main.rs": "fn main() { let unused = 42; println!(\"ok\"); }\n" },
      }), "rust-warning-diagnostic-repeat-test");
      expect(warningRepeat.success, warningRepeat.stderr).toBe(true);
      if (warning.artifact?.kind !== "wasm" || warningRepeat.artifact?.kind !== "wasm") {
        throw new Error("Repeated Rust compilation did not produce standalone Wasm artifacts.");
      }
      expect(createHash("sha256").update(warningRepeat.artifact.bytes).digest("hex"))
        .toBe(createHash("sha256").update(warning.artifact.bytes).digest("hex"));

      const invalid = await compiler.build(createSdkProject({
        language: "rust",
        target: "wasip1",
        entry: "src/main.rs",
        files: { "src/main.rs": "fn main() { let value: String = 42; }\n" },
      }), "rust-error-diagnostic-test");
      expect(invalid.success).toBe(false);
      expect(invalid.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "rustc", code: "E0308", file: "src/main.rs", line: 1 }),
      ]));
    } finally {
      compiler.dispose();
    }
  });

  it("compile and replay the same TypeScript artifact through native Wasmer", { timeout: 300_000 }, async () => {
    execFileSync("cargo", [
      "build",
      "--manifest-path",
      "crates/runtime-core/Cargo.toml",
      "--bin",
      "forge-runner",
    ], { stdio: "pipe" });
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-server-test-"));
    const compiler = new ServerForgeCompiler({
      compilerExecutable: process.execPath,
      toolchainDirectory: path.resolve("public/toolchains"),
    });
    const runner = new ServerForgeRunner({
      runtimeExecutable: path.resolve("crates/runtime-core/target/debug/forge-runner"),
      toolchainDirectory: path.resolve("public/toolchains"),
      cacheDirectory,
    });
    const engine = await createForgeEngine({ compiler, runner });
    try {
      const execution = await engine.execute({
        language: "typescript",
        entry: "src/main.ts",
        files: {
          "src/main.ts": 'import * as std from "std";\nstd.out.puts("42\\n");',
        },
      });
      expect(execution.build.success, `${execution.build.stderr}\n${JSON.stringify(execution.build.diagnostics)}`).toBe(true);
      expect(execution.build.artifact?.kind).toBe("runtime-bundle");
      if (!execution.build.artifact || !execution.run) {
        throw new Error("The server engine did not compile and run an artifact.");
      }

      const first = execution.run;
      const second = await engine.run(execution.build.artifact);
      expect(first).toMatchObject({ code: 0, stdout: "42\n", stderr: "", termination: "exited" });
      expect(second).toMatchObject({ code: 0, stdout: "42\n", stderr: "", termination: "exited" });
      expect(first).not.toHaveProperty("trapMessage");
      expect(second).not.toHaveProperty("trapMessage");
      expect(first.metrics.cost).toBeGreaterThan(0);
      if (first.metrics.cost === null || first.metrics.rawCost === null) {
        throw new Error("Successful execution did not report cost metrics.");
      }
      expect(first.metrics.rawCost).toBe(first.metrics.cost + first.metrics.baselineCost);
      expect(first.metrics.costProfile).toBe(execution.build.artifact.costProfile);
      expect(second.metrics).toEqual(first.metrics);

      const exhausted = await engine.run(execution.build.artifact, {
        resources: { instructionBudget: 1 },
      });
      expect(exhausted).toMatchObject({
        code: 137,
        termination: "instruction-limit",
        metrics: {
          cost: 1,
          rawCost: exhausted.metrics.baselineCost + 1,
        },
      });

      const rebuilt = await engine.compile({
        language: "typescript",
        entry: "src/main.ts",
        files: {
          "src/main.ts": 'import * as std from "std";\nstd.out.puts("43\\n");',
        },
      });
      expect(rebuilt.success).toBe(true);
    } finally {
      engine.dispose();
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("compiles real Rust standard-library code with rustc under Wasmer", { timeout: 300_000 }, async () => {
    execFileSync("cargo", [
      "build",
      "--manifest-path",
      "crates/runtime-core/Cargo.toml",
      "--bin",
      "forge-runner",
    ], { stdio: "pipe" });
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-rust-server-test-"));
    const compiler = new ServerForgeCompiler({
      compilerExecutable: process.execPath,
      toolchainDirectory: path.resolve("public/toolchains"),
    });
    const runner = new ServerForgeRunner({
      runtimeExecutable: path.resolve("crates/runtime-core/target/debug/forge-runner"),
      toolchainDirectory: path.resolve("public/toolchains"),
      cacheDirectory,
    });
    const engine = await createForgeEngine({ compiler, runner });
    try {
      const execution = await engine.execute({
        language: "rust",
        target: "wasip1",
        entry: "src/main.rs",
        files: {
          "src/main.rs": "#[derive(Debug)]\nstruct Item(i32);\nfn main(){ let values=vec![Item(7),Item(35)]; println!(\"{}\", values.iter().map(|item| item.0).sum::<i32>()); }\n",
        },
      });
      expect(execution.build.success, `${execution.build.stderr}\n${JSON.stringify(execution.build.diagnostics)}`).toBe(true);
      expect(execution.build.artifact?.kind).toBe("wasm");
      expect(execution.run).toMatchObject({ code: 0, stdout: "42\n", termination: "exited" });
      expect(execution.run?.metrics.cost).toBeGreaterThan(0);
      expect(execution.run?.metrics.rawCost).toBe(
        (execution.run?.metrics.cost ?? 0) + (execution.run?.metrics.baselineCost ?? 0),
      );
      expect(execution.run?.metrics.operations).toEqual(expect.objectContaining({ Call: expect.any(Number) }));

      const invalid = await engine.compile({
        language: "rust",
        target: "wasip1",
        entry: "src/main.rs",
        files: { "src/main.rs": "fn main() { let value: String = 42; }\n" },
      });
      expect(invalid.success).toBe(false);
      expect(invalid.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "rustc", code: "E0308", file: "src/main.rs", line: 1 }),
      ]));
    } finally {
      engine.dispose();
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });
});
