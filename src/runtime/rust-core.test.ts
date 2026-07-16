import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function compilerSource(): string {
  const worker = readFileSync(new URL("./compiler.worker.ts", import.meta.url), "utf8");
  const match = worker.match(/const RUST_CORE_COMPILER = String\.raw`([\s\S]*?)`;\n\nconst QUICKJS_TYPES/);
  if (!match) throw new Error("Unable to locate the embedded Rust core compiler.");
  return match[1];
}

function compile(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "localwasi-rust-core-"));
  const compiler = join(directory, "compiler.py");
  const input = join(directory, "main.rs");
  const output = join(directory, "main.c");
  const diagnostics = join(directory, "diagnostics.json");
  writeFileSync(compiler, compilerSource());
  writeFileSync(input, source);
  const result = spawnSync("python3", [compiler, "--input", input, "--output", output, "--diagnostics", diagnostics], { encoding: "utf8" });
  return {
    code: result.status,
    stderr: result.stderr,
    directory,
    outputPath: output,
    output: readFileSync(output, "utf8"),
    diagnostics: JSON.parse(readFileSync(diagnostics, "utf8")) as Array<{ code: string; line: number }>,
  };
}

describe("Rust/WASI core compiler", () => {
  it("translates functions, bindings, control flow, and print macros", () => {
    const result = compile(`fn square(value: i32) -> i32 {\n    return value * value;\n}\nfn main() {\n    let answer: i32 = square(7);\n    if answer > 0 {\n        println!("answer: {}", answer);\n    }\n}\n`);
    expect(result.code).toBe(0);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain("int32_t square(int32_t value)");
    expect(result.output).toContain("if (answer > 0)");
    expect(result.output).toContain("LW_PRINT_VALUE(answer)");
  });

  it("provides deterministic integer stdin for local judge problems", () => {
    const result = compile(`fn main() {\n    let left: i64 = read_int();\n    let right: i64 = read_int();\n    println!("{}", left + right);\n}\n`);
    expect(result.code).toBe(0);
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain("static int64_t read_int(void)");
    expect(result.output).toContain("int64_t left = read_int()");

    const executable = join(result.directory, "judge-program");
    const nativeCompile = spawnSync("cc", ["-std=c17", result.outputPath, "-o", executable], { encoding: "utf8" });
    expect(nativeCompile.status, nativeCompile.stderr).toBe(0);
    const nativeRun = spawnSync(executable, { input: "7 35\n", encoding: "utf8" });
    expect(nativeRun.status, nativeRun.stderr).toBe(0);
    expect(nativeRun.stdout).toBe("42\n");
  });

  it("rejects constructs outside the declared profile", () => {
    const result = compile("struct Point { x: i32 }\nfn main() {}\n");
    expect(result.code).toBe(1);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "RWC001", line: 1 }));
  });
});
