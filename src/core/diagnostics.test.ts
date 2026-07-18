import { describe, expect, it } from "vitest";
import { parseClangDiagnostics, parsePythonDiagnostics, parseRustDiagnostics, parseTypeScriptDiagnostics, projectPath } from "./diagnostics";

describe("diagnostic parsing", () => {
  it("normalizes mounted project paths", () => {
    expect(projectPath("/project/src/main.c")).toBe("src/main.c");
    expect(projectPath("/workspace/src/main.c")).toBe("src/main.c");
  });

  it("parses clang locations and codes", () => {
    const [diagnostic] = parseClangDiagnostics(
      "/project/src/main.c:4:9: warning: unused variable 'value' [-Wunused-variable]",
    );
    expect(diagnostic).toMatchObject({
      file: "src/main.c",
      line: 4,
      column: 9,
      severity: "warning",
      code: "-Wunused-variable",
    });
  });

  it("parses Python syntax errors", () => {
    const [diagnostic] = parsePythonDiagnostics(
      '  File "/project/src/main.py", line 2\n    print(\n         ^\nSyntaxError: incomplete input',
    );
    expect(diagnostic).toMatchObject({
      file: "src/main.py",
      line: 2,
      severity: "error",
      message: "SyntaxError: incomplete input",
    });
  });

  it("parses native TypeScript diagnostics", () => {
    const [diagnostic] = parseTypeScriptDiagnostics(
      "/project/src/main.ts(3,15): error TS2322: Type 'number' is not assignable to type 'string'.",
    );
    expect(diagnostic).toMatchObject({
      file: "src/main.ts",
      line: 3,
      column: 15,
      severity: "error",
      code: "TS2322",
    });
  });

  it("parses rustc JSON diagnostics with source ranges", () => {
    const output = JSON.stringify({
      $message_type: "diagnostic",
      message: "mismatched types",
      code: { code: "E0308" },
      level: "error",
      spans: [{ file_name: "/work/src/main.rs", line_start: 3, line_end: 3, column_start: 9, column_end: 14, is_primary: true }],
    });
    expect(parseRustDiagnostics(output)).toEqual([expect.objectContaining({
      file: "src/main.rs",
      line: 3,
      column: 9,
      endLine: 3,
      endColumn: 14,
      source: "rustc",
      code: "E0308",
    })]);
  });
});
