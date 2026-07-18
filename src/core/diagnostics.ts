import type { Diagnostic, DiagnosticSeverity } from "./types.ts";

function severity(value: string): DiagnosticSeverity {
  if (value === "warning") return "warning";
  if (value === "note" || value === "info") return "info";
  return "error";
}

export function projectPath(path: string): string {
  return path
    .replace(/^file:\/\//, "")
    .replace(/^\/?(?:workspace|project|work)\//, "")
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

export function parseRustDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.$message_type !== "diagnostic" || typeof record.message !== "string") continue;
    const spans = Array.isArray(record.spans) ? record.spans : [];
    const span = spans.find((candidate) => candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).is_primary === true)
      ?? spans.find((candidate) => candidate && typeof candidate === "object");
    const location = span as Record<string, unknown> | undefined;
    const code = record.code && typeof record.code === "object"
      ? (record.code as Record<string, unknown>).code
      : undefined;
    diagnostics.push({
      severity: severity(typeof record.level === "string" ? record.level : "error"),
      message: record.message,
      file: projectPath(typeof location?.file_name === "string" ? location.file_name : "main.rs"),
      line: typeof location?.line_start === "number" ? location.line_start : 1,
      column: typeof location?.column_start === "number" ? location.column_start : 1,
      endLine: typeof location?.line_end === "number" ? location.line_end : undefined,
      endColumn: typeof location?.column_end === "number" ? location.column_end : undefined,
      source: "rustc",
      code: typeof code === "string" ? code : undefined,
    });
  }
  return diagnostics;
}

export function parseGoDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const pattern = /^(.*?\.go):(\d+)(?::(\d+))?:\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    diagnostics.push({
      severity: "error",
      message: match[4],
      file: projectPath(match[1]),
      line: Number(match[2]),
      column: Number(match[3] ?? 1),
      source: "go",
    });
  }
  return diagnostics;
}

export function ensureFailureDiagnostic(
  diagnostics: Diagnostic[],
  summary: { file: string; source: string; message: string },
): Diagnostic[] {
  if (diagnostics.length > 0) return diagnostics;
  return [{
    severity: "error",
    file: projectPath(summary.file),
    line: 1,
    column: 1,
    source: summary.source,
    message: summary.message,
  }];
}
