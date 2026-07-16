import type { Diagnostic, DiagnosticSeverity } from "./types";

function severity(value: string): DiagnosticSeverity {
  if (value === "warning") return "warning";
  if (value === "note" || value === "info") return "info";
  return "error";
}

export function projectPath(path: string): string {
  return path
    .replace(/^file:\/\//, "")
    .replace(/^\/?(?:workspace|project)\//, "")
    .replace(/^\.\//, "");
}

export function parseClangDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const pattern = /^(.*?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.+?)(?:\s+\[([^\]]+)\])?$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    diagnostics.push({
      file: projectPath(match[1]),
      line: Number(match[2]),
      column: Number(match[3]),
      severity: severity(match[4].replace("fatal ", "")),
      message: match[5],
      source: "clang",
      code: match[6],
    });
  }
  return diagnostics;
}

export function parsePythonDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const location = lines[index].match(/^\s*File "([^"]+)", line (\d+)/);
    if (!location) continue;
    let column = 1;
    let message = "Python compilation failed";
    const caretLine = lines[index + 2] ?? "";
    const caret = caretLine.indexOf("^");
    if (caret >= 0) column = caret + 1;
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 6); cursor += 1) {
      const error = lines[cursor].match(/^([A-Za-z]+(?:Error|Exception)):\s*(.+)$/);
      if (error) {
        message = `${error[1]}: ${error[2]}`;
        break;
      }
    }
    diagnostics.push({
      file: projectPath(location[1]),
      line: Number(location[2]),
      column,
      severity: "error",
      message,
      source: "python",
    });
  }
  return diagnostics;
}

export function parseTypeScriptDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const pattern = /^(.*?)\((\d+),(\d+)\):\s+(error|warning|message)\s+TS(\d+):\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    diagnostics.push({
      severity: severity(match[4]),
      message: match[6],
      file: projectPath(match[1]),
      line: Number(match[2]),
      column: Number(match[3]),
      source: "typescript",
      code: `TS${match[5]}`,
    });
  }
  return diagnostics;
}

export function ensureFailureDiagnostic(
  diagnostics: Diagnostic[],
  fallback: { file: string; source: string; message: string },
): Diagnostic[] {
  if (diagnostics.length > 0) return diagnostics;
  return [{
    severity: "error",
    file: projectPath(fallback.file),
    line: 1,
    column: 1,
    source: fallback.source,
    message: fallback.message,
  }];
}
