import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../core/hash";
import { createDependencyBuildBundle } from "../dependencies/build";
import { createDependencyLock } from "../dependencies/lock";
import type { DependencyEcosystem, LockedDependencyPackage } from "../dependencies/types";
import type { CompileInput } from "../sdk/project";
import type { ForgeEngine } from "../sdk/engine";
import { createServerForge } from "./factory";

const enabled = process.env.FORGE_RUN_DEPENDENCY_INTEGRATION === "1";
const encoder = new TextEncoder();

describe.skipIf(!enabled)("real server dependency compiler integration", () => {
  let engine: ForgeEngine;
  let cacheDirectory: string;

  beforeAll(async () => {
    execFileSync("cargo", [
      "build", "--locked", "--manifest-path", "crates/runtime-core/Cargo.toml", "--release", "--bins",
    ], { stdio: "pipe" });
    cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-dependency-integration-"));
    engine = await createServerForge({ cacheDirectory });
  }, 300_000);

  afterAll(async () => {
    engine?.dispose();
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  });

  it.each(dependencyCases())("compiles and runs $language with a locked $ecosystem dependency", { timeout: 300_000 }, async (item) => {
    const payload = encoder.encode(`${item.ecosystem}:${item.name}`);
    const record: LockedDependencyPackage = {
      id: `${item.ecosystem}:${item.name}@1.0.0`,
      ecosystem: item.ecosystem,
      name: item.name,
      version: "1.0.0",
      source: item.ecosystem === "pypi" ? "https://packages.example/answer-1.0.0-py3-none-any.whl" : "https://packages.example/archive",
      integritySha256: await sha256Hex(payload),
      dependencies: [],
    };
    const lock = createDependencyLock("0".repeat(64), [record.id], [record]);
    const dependencies = await createDependencyBuildBundle(lock, new Map([[record.id, payload]]), [{
      ecosystem: item.ecosystem,
      async materialize() { return item.dependencyFiles; },
    }]);
    const result = await engine.execute({ ...item.input, dependencies });

    expect(result.build.success, `${result.build.stderr}\n${JSON.stringify(result.build.diagnostics)}`).toBe(true);
    expect(result.run?.termination).toBe("exited");
    expect(result.run?.stdout.trim()).toBe("42");
  });
});

function dependencyCases(): Array<{
  language: string;
  ecosystem: DependencyEcosystem;
  name: string;
  input: CompileInput;
  dependencyFiles: Record<string, Uint8Array>;
}> {
  return [
    {
      language: "C++",
      ecosystem: "cpp",
      name: "answer",
      input: {
        language: "cpp",
        entry: "main.cpp",
        files: { "main.cpp": '#include <iostream>\n#include "answer.hpp"\nint main(){std::cout << answer();}\n' },
      },
      dependencyFiles: {
        "answer.hpp": encoder.encode("int answer();\n"),
        "answer.cpp": encoder.encode('#include "answer.hpp"\nint answer(){return 42;}\n'),
      },
    },
    {
      language: "Rust",
      ecosystem: "cargo",
      name: "answer",
      input: {
        language: "rust",
        entry: "main.rs",
        files: { "main.rs": 'fn main(){println!("{}", answer::value());}\n' },
      },
      dependencyFiles: {
        "Cargo.toml": encoder.encode('[package]\nname="answer"\nversion="1.0.0"\nedition="2021"\n'),
        "src/lib.rs": encoder.encode("pub fn value() -> i32 { 42 }\n"),
      },
    },
    {
      language: "Python",
      ecosystem: "pypi",
      name: "answer",
      input: {
        language: "python",
        entry: "main.py",
        files: { "main.py": "import answer\nprint(answer.value)\n" },
      },
      dependencyFiles: { "answer/__init__.py": encoder.encode("value = 42\n") },
    },
    {
      language: "JavaScript",
      ecosystem: "npm",
      name: "answer",
      input: {
        language: "javascript",
        entry: "main.js",
        files: { "main.js": 'const std=require("std");std.out.puts(String(require("answer")));\n' },
      },
      dependencyFiles: {
        "package.json": encoder.encode(JSON.stringify({ name: "answer", version: "1.0.0", main: "index.js" })),
        "index.js": encoder.encode("module.exports = 42;\n"),
      },
    },
    {
      language: "Go",
      ecosystem: "go",
      name: "example.com/answer",
      input: {
        language: "go",
        entry: "main.go",
        files: { "main.go": 'package main\nimport (\n  "fmt"\n  "example.com/answer"\n)\nfunc main(){fmt.Print(answer.Value())}\n' },
      },
      dependencyFiles: {
        "go.mod": encoder.encode("module example.com/answer\n\ngo 1.26\n"),
        "answer.go": encoder.encode("package answer\nfunc Value() int { return 42 }\n"),
      },
    },
  ];
}
