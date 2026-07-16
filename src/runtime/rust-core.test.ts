import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function compilerSource(): string {
  const worker = readFileSync(new URL("./compiler.worker.ts", import.meta.url), "utf8");
  const match = worker.match(/const RUST_CORE_COMPILER = String\.raw`([\s\S]*?)`;\n\nconst TYPESCRIPT_DRIVER/);
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

  it("rejects constructs outside the declared profile", () => {
    const result = compile("struct Point { x: i32 }\nfn main() {}\n");
    expect(result.code).toBe(1);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "RWC001", line: 1 }));
  });
});
