import { describe, expect, it } from "vitest";
import { parseClangDiagnostics, parsePythonDiagnostics, projectPath } from "./diagnostics";

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
});
