/// <reference lib="webworker" />

import {
  Directory,
  Runtime,
  Wasmer,
  init,
  type Command,
  type Output,
} from "@wasmer/sdk";
import wasmerSdkUrl from "@wasmer/sdk?url";
import wasmerWasmUrl from "@wasmer/sdk/wasm?url";
import { ensureFailureDiagnostic, parseClangDiagnostics, parsePythonDiagnostics, parseQuickJsDiagnostics } from "@/src/core/diagnostics";
import {
  CLANG_PACKAGE,
  PYTHON_PACKAGE,
  QUICKJS_PACKAGE,
  TYPESCRIPT_ASSET_PATH,
  TYPESCRIPT_VERSION,
} from "@/src/core/toolchains";
import type {
  BuildArtifact,
  BuildResult,
  CompilerRequest,
  CompilerResponse,
  Diagnostic,
  Project,
  ProjectConfig,
  ProjectFile,
  RuntimeBundleArtifact,
  RunResult,
  WasmArtifact,
  WorkerPhase,
} from "@/src/core/types";
const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const encoder = new TextEncoder();
const packages = new Map<string, Promise<Wasmer>>();
let typescriptSource: Promise<string> | undefined;
let runtime: Runtime | undefined;

const RUST_CORE_COMPILER = String.raw`
import argparse
import json
import re

TYPE_MAP = {
    "i8": "int8_t", "i16": "int16_t", "i32": "int32_t", "i64": "int64_t",
    "isize": "intptr_t", "u8": "uint8_t", "u16": "uint16_t", "u32": "uint32_t",
    "u64": "uint64_t", "usize": "uintptr_t", "f32": "float", "f64": "double",
    "bool": "bool", "char": "char", "&str": "const char *", "()": "void",
}

PRELUDE = r'''#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
static void lw_print_i64(long long value) { printf("%lld", value); }
static void lw_print_f64(double value) { printf("%g", value); }
static void lw_print_str(const char *value) { fputs(value, stdout); }
static void lw_print_bool(bool value) { fputs(value ? "true" : "false", stdout); }
static int64_t read_int(void) {
    long long value = 0;
    if (scanf("%lld", &value) != 1) return 0;
    return (int64_t)value;
}
#define LW_PRINT_VALUE(value) _Generic((value), char*: lw_print_str, const char*: lw_print_str, float: lw_print_f64, double: lw_print_f64, bool: lw_print_bool, default: lw_print_i64)(value)
'''

def c_type(value):
    value = value.strip()
    if value.startswith("&") and value != "&str":
        return c_type(value[1:]) + " *"
    return TYPE_MAP.get(value)

def split_args(value):
    result, current, depth, quote, escaped = [], [], 0, None, False
    for ch in value:
        if escaped:
            current.append(ch); escaped = False; continue
        if ch == "\\" and quote:
            current.append(ch); escaped = True; continue
        if quote:
            current.append(ch)
            if ch == quote: quote = None
            continue
        if ch in ('\"', "'"):
            quote = ch; current.append(ch); continue
        if ch in "([{": depth += 1
        elif ch in ")]}" : depth -= 1
        if ch == "," and depth == 0:
            result.append("".join(current).strip()); current = []
        else: current.append(ch)
    if current: result.append("".join(current).strip())
    return result

def print_statement(indent, stream, format_literal, values, newline):
    text = bytes(format_literal[1:-1], "utf-8").decode("unicode_escape")
    parts = text.split("{}")
    if len(parts) - 1 != len(values):
        raise ValueError("format placeholders must match the number of arguments")
    statements = []
    for index, part in enumerate(parts):
        if part:
            statements.append("fputs(" + json.dumps(part) + ", " + stream + ");")
        if index < len(values):
            statements.append("LW_PRINT_VALUE(" + values[index] + ");")
    if newline: statements.append("fputc('\\n', " + stream + ");")
    return indent + "do { " + " ".join(statements) + " } while (0);"

def translate(source, filename):
    diagnostics, output = [], []
    unsupported = re.compile(r"\b(match|struct|enum|impl|trait|async|await|unsafe|extern\s+crate|mod)\b|\b(vec!|format!)")
    for number, original in enumerate(source.splitlines(), 1):
        line, stripped = original, original.strip()
        indent = line[:len(line) - len(line.lstrip())]
        if not stripped or stripped.startswith("//"):
            output.append(line); continue
        if stripped.startswith("use "):
            output.append(indent + "/* " + stripped.replace("*/", "") + " */"); continue
        code_for_check = re.sub(r'\"(?:\\\\.|[^\"\\\\])*\"', '\"\"', stripped)
        bad = unsupported.search(code_for_check)
        if bad:
            diagnostics.append({"severity":"error","message":"'" + bad.group(0) + "' is outside the Rust/WASI core profile","file":filename,"line":number,"column":bad.start()+1,"source":"rust-core","code":"RWC001"})
            output.append(""); continue
        function = re.match(r"^(\s*)fn\s+([A-Za-z_]\w*)\s*\((.*?)\)\s*(?:->\s*([^\s{]+))?\s*\{\s*$", line)
        if function:
            _, name, raw_params, return_type = function.groups()
            if name == "main":
                output.append(indent + "int main(void) {"); continue
            return_c = c_type(return_type or "()")
            params = []
            for param in split_args(raw_params):
                parts = param.split(":", 1)
                mapped = c_type(parts[1]) if len(parts) == 2 else None
                if not mapped:
                    diagnostics.append({"severity":"error","message":"unsupported parameter type in '" + param + "'","file":filename,"line":number,"column":1,"source":"rust-core","code":"RWC002"})
                    mapped = "int64_t"
                params.append(mapped + " " + parts[0].strip())
            if not return_c:
                diagnostics.append({"severity":"error","message":"unsupported return type '" + str(return_type) + "'","file":filename,"line":number,"column":1,"source":"rust-core","code":"RWC003"})
                return_c = "void"
            output.append(indent + return_c + " " + name + "(" + ", ".join(params) + ") {"); continue
        declaration = re.match(r"^(\s*)let\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*=\s*(.+);\s*$", line)
        if declaration:
            _, name, rust_type, expression = declaration.groups()
            expression = re.sub(r"String::from\((.*)\)", r"\1", expression)
            mapped = c_type(rust_type) if rust_type else ("const char *" if expression.strip().startswith('"') else "int64_t")
            if not mapped:
                diagnostics.append({"severity":"error","message":"unsupported binding type '" + rust_type.strip() + "'","file":filename,"line":number,"column":1,"source":"rust-core","code":"RWC004"})
                mapped = "int64_t"
            output.append(indent + mapped + " " + name + " = " + expression + ";"); continue
        loop = re.match(r"^(\s*)for\s+([A-Za-z_]\w*)\s+in\s+(.+?)\.\.(=)?(.+?)\s*\{\s*$", line)
        if loop:
            _, name, start, inclusive, end = loop.groups()
            comparison = "<=" if inclusive else "<"
            output.append(indent + "for (int64_t " + name + " = " + start + "; " + name + " " + comparison + " " + end + "; ++" + name + ") {"); continue
        conditional = re.match(r"^(\s*)(if|while)\s+(.+?)\s*\{\s*$", line)
        if conditional:
            _, keyword, condition = conditional.groups()
            output.append(indent + keyword + " (" + condition + ") {"); continue
        else_if = re.match(r"^(\s*)\}\s*else\s+if\s+(.+?)\s*\{\s*$", line)
        if else_if:
            _, condition = else_if.groups()
            output.append(indent + "} else if (" + condition + ") {"); continue
        printing = re.match(r"^(\s*)(e?print(?:ln)?)!\s*\((.*)\);\s*$", line)
        if printing:
            _, macro, arguments = printing.groups()
            values = split_args(arguments)
            if not values or not values[0].startswith('"'):
                diagnostics.append({"severity":"error","message":"print macros require a string literal in the Rust/WASI core profile","file":filename,"line":number,"column":1,"source":"rust-core","code":"RWC005"})
                output.append(""); continue
            try:
                output.append(print_statement(indent, "stderr" if macro.startswith("e") else "stdout", values[0], values[1:], macro.endswith("ln")))
            except ValueError as error:
                diagnostics.append({"severity":"error","message":str(error),"file":filename,"line":number,"column":1,"source":"rust-core","code":"RWC006"}); output.append("")
            continue
        line = re.sub(r"\bas\s+(i8|i16|i32|i64|isize|u8|u16|u32|u64|usize|f32|f64)\b", "", line)
        if re.search(r"\w+!\s*\(", line):
            diagnostics.append({"severity":"error","message":"unsupported macro in Rust/WASI core profile","file":filename,"line":number,"column":1,"source":"rust-core","code":"RWC007"}); output.append(""); continue
        output.append(line)
    return PRELUDE + '#line 1 "' + filename + '"\n' + "\n".join(output) + "\n", diagnostics

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--diagnostics", required=True)
args = parser.parse_args()
with open(args.input, "r", encoding="utf-8") as handle: source = handle.read()
translated, diagnostics = translate(source, args.input.replace("/project/", ""))
with open(args.output, "w", encoding="utf-8") as handle: handle.write(translated)
with open(args.diagnostics, "w", encoding="utf-8") as handle: json.dump(diagnostics, handle)
raise SystemExit(1 if diagnostics else 0)
`;

const TYPESCRIPT_DRIVER = String.raw`
import * as std from "std";
std.loadScript("/project/.localwasi/typescript.js");
function readText(path) {
  const handle = std.open(path, "r");
  if (!handle) throw new Error("Unable to open " + path);
  try {
    return handle.readAsString();
  } finally {
    handle.close();
  }
}
const config = JSON.parse(readText("/project/.localwasi/tsconfig.json"));
const response = { outputs: {}, diagnostics: [] };
for (const file of config.files) {
  const source = readText("/project/" + file);
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ES2020,
      strict: config.typescript,
      allowJs: !config.typescript,
      checkJs: !config.typescript,
      sourceMap: false,
      removeComments: false,
    },
  });
  const outputPath = file.replace(/\.(?:m?ts|m?js)$/, ".js");
  response.outputs[outputPath] = result.outputText;
  for (const diagnostic of result.diagnostics || []) {
    let line = 1, column = 1, endLine = 1, endColumn = 1;
    if (diagnostic.file && diagnostic.start !== undefined) {
      const start = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      const end = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start + (diagnostic.length || 1));
      line = start.line + 1; column = start.character + 1;
      endLine = end.line + 1; endColumn = end.character + 1;
    }
    response.diagnostics.push({
      severity: diagnostic.category === ts.DiagnosticCategory.Warning ? "warning" : diagnostic.category === ts.DiagnosticCategory.Message ? "info" : "error",
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      file: diagnostic.file ? diagnostic.file.fileName : file,
      line, column, endLine, endColumn,
      source: "typescript",
      code: "TS" + diagnostic.code,
    });
  }
}
std.out.puts("__LOCALWASI_TSC__" + JSON.stringify(response) + "\n");
`;

function post(response: CompilerResponse): void {
  scope.postMessage(response);
}

function progress(requestId: string, phase: WorkerPhase, label: string, value?: number): void {
  post({ type: "progress", requestId, progress: { phase, label, progress: value } });
}

async function initializeRuntime(requestId: string): Promise<void> {
  if (!crossOriginIsolated) {
    throw new Error("Wasmer requires a cross-origin-isolated page. Serve this app with COOP and COEP headers.");
  }
  progress(requestId, "initializing", "Starting Wasmer runtime", 0.2);
  await init({
    log: "warn",
    module: new URL(wasmerWasmUrl, scope.location.origin),
    sdkUrl: new URL(wasmerSdkUrl, scope.location.origin),
  });
  runtime = Runtime.global(true);
  progress(requestId, "initializing", "Wasmer runtime ready", 1);
}

function requireRuntime(): Runtime {
  if (!runtime) throw new Error("Wasmer runtime is not initialized.");
  return runtime;
}

async function getPackage(specifier: string, requestId: string): Promise<Wasmer> {
  let promise = packages.get(specifier);
  if (!promise) {
    progress(requestId, "loading-toolchain", `Loading ${specifier}`);
    promise = Wasmer.fromRegistry(specifier, requireRuntime());
    packages.set(specifier, promise);
  }
  try {
    return await promise;
  } catch (error) {
    packages.delete(specifier);
    throw error;
  }
}

function command(pkg: Wasmer, name: string): Command {
  const selected = pkg.commands[name] ?? (pkg.entrypoint?.name === name ? pkg.entrypoint : undefined);
  if (!selected) throw new Error(`Package does not expose the '${name}' command.`);
  return selected;
}

async function loadTypescriptSource(): Promise<string> {
  typescriptSource ??= fetch(TYPESCRIPT_ASSET_PATH).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Unable to load the pinned TypeScript ${TYPESCRIPT_VERSION} compiler asset (${response.status}).`);
    }
    return response.text();
  });
  try {
    return await typescriptSource;
  } catch (error) {
    typescriptSource = undefined;
    throw error;
  }
}

function projectDirectory(files: ProjectFile[]): Directory {
  const initial: Record<string, string> = {};
  for (const file of files) initial[`/${file.path}`] = file.content;
  return new Directory(initial);
}

async function ensureDirectory(directory: Directory, path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    try {
      await directory.createDir(current);
    } catch (error) {
      if (!String(error).toLowerCase().includes("exist")) throw error;
    }
  }
}

function compilerFlags(project: Project): string[] {
  return project.config.optimization === "release" ? ["-O2", "-DNDEBUG"] : ["-O0", "-g"];
}

function createArtifactBase(project: Project, cacheKey: string, started: number, size: number, toolchains: string[]) {
  return {
    id: crypto.randomUUID(),
    projectId: project.id,
    cacheKey,
    name: `${project.name}.${project.config.target === "wasi" ? "wasm" : "wasix.wasm"}`,
    language: project.config.language,
    target: project.config.target,
    createdAt: Date.now(),
    durationMs: performance.now() - started,
    size,
    toolchains,
  } as const;
}

function outputResult(output: Output): Pick<BuildResult, "stdout" | "stderr"> {
  return { stdout: output.stdout, stderr: output.stderr };
}

interface WasiPipelineResult {
  ok: boolean;
  code: number;
  stage: "compiler" | "linker";
  stdout: string;
  stderr: string;
  diagnostics: Diagnostic[];
}

async function runPlainWasiPipeline(
  pkg: Wasmer,
  directory: Directory,
  sources: string[],
  isCpp: boolean,
  flags: string[],
  requestId: string,
): Promise<WasiPipelineResult> {
  const objects: string[] = [];
  let stdout = "";
  let stderr = "";
  let diagnostics: Diagnostic[] = [];
  const optimization = flags.includes("-O2")
    ? ["-O2", "-D", "NDEBUG"]
    : ["-O0", "-debug-info-kind=constructor", "-dwarf-version=4"];

  for (const [index, source] of sources.entries()) {
    progress(requestId, "compiling", `Compiling ${source}`, 0.2 + (0.5 * (index + 1)) / sources.length);
    const object = `/project/build/unit-${index}.o`;
    const instance = await command(pkg, "clang-16").run({
      args: [
        "-cc1",
        "-triple", "wasm32-unknown-wasi",
        "-emit-obj",
        "-mrelocation-model", "static",
        "-mframe-pointer=none",
        "-ffp-contract=on",
        "-fno-rounding-math",
        "-mconstructor-aliases",
        "-target-cpu", "generic",
        "-fvisibility=hidden",
        "-resource-dir", "/lib/clang/16",
        "-isysroot", "/sysroot",
        ...(isCpp ? [
          "-internal-isystem", "/sysroot/include/wasm32-wasi/c++/v1",
          "-internal-isystem", "/sysroot/include/c++/v1",
        ] : []),
        "-internal-isystem", "/lib/clang/16/include",
        "-internal-isystem", "/sysroot/include/wasm32-wasi",
        "-internal-isystem", "/sysroot/include",
        isCpp ? "-std=c++17" : "-std=c17",
        ...(isCpp ? ["-fcxx-exceptions", "-fexceptions"] : []),
        "-ferror-limit", "19",
        "-fgnuc-version=4.2.1",
        ...optimization,
        "-I", "/project/src",
        "-o", object,
        "-x", isCpp ? "c++" : "c",
        `/project/${source}`,
      ],
      cwd: "/project",
      env: { PATH: "/bin" },
      mount: { "/project": directory },
    });
    const output = await instance.wait();
    stdout += output.stdout;
    stderr += output.stderr;
    diagnostics = [...diagnostics, ...parseClangDiagnostics(`${output.stderr}\n${output.stdout}`)];
    if (!output.ok) return { ok: false, code: output.code, stage: "compiler", stdout, stderr, diagnostics };
    objects.push(object);
  }

  progress(requestId, "linking", "Linking WebAssembly module with wasm-ld", 0.82);
  const linker = await command(pkg, "wasm-ld").run({
    args: [
      "-m", "wasm32",
      "-L/sysroot/lib/wasm32-wasi",
      "/sysroot/lib/wasm32-wasi/crt1-command.o",
      ...objects,
      ...(isCpp ? ["-lc++", "-lc++abi"] : []),
      "-lc",
      "/lib/clang/16/lib/wasi/libclang_rt.builtins-wasm32.a",
      "-o", "/project/build/app.wasm",
    ],
    cwd: "/project",
    env: { PATH: "/bin" },
    mount: { "/project": directory },
  });
  const output = await linker.wait();
  stdout += output.stdout;
  stderr += output.stderr;
  diagnostics = [...diagnostics, ...parseClangDiagnostics(`${output.stderr}\n${output.stdout}`)];
  return {
    ok: output.ok,
    code: output.code,
    stage: "linker",
    stdout,
    stderr,
    diagnostics,
  };
}

async function buildClang(project: Project, cacheKey: string, requestId: string): Promise<BuildResult> {
  const started = performance.now();
  const directory = projectDirectory(project.files);
  await ensureDirectory(directory, "/build");
  const pkg = await getPackage(CLANG_PACKAGE, requestId);
  const isCpp = project.config.language === "cpp";
  const extensions = isCpp ? /\.(?:cc|cpp|cxx)$/ : /\.c$/;
  const sources = project.files.filter((file) => extensions.test(file.path)).map((file) => file.path);
  if (!sources.includes(project.config.entry)) sources.unshift(project.config.entry);

  let stdout: string;
  let stderr: string;
  let diagnostics: Diagnostic[];
  let ok: boolean;
  let code: number;
  let failedTool = "Clang";

  if (project.config.target === "wasi") {
    const output = await runPlainWasiPipeline(pkg, directory, sources, isCpp, compilerFlags(project), requestId);
    ({ stdout, stderr, diagnostics, ok, code } = output);
    failedTool = output.stage === "linker" ? "wasm-ld" : "Clang";
  } else {
    progress(requestId, "compiling", `Compiling ${sources.length} source file${sources.length === 1 ? "" : "s"}`, 0.45);
    const instance = await command(pkg, "clang").run({
      args: [
        ...(isCpp ? ["--driver-mode=g++", "-std=c++17"] : ["-std=c17"]),
        ...compilerFlags(project),
        "-fdiagnostics-color=never",
        "-I/project/src",
        ...sources,
        "-o",
        "build/app.wasm",
      ],
      cwd: "/project",
      env: { PATH: "/bin" },
      mount: { "/project": directory },
    });
    const output = await instance.wait();
    stdout = output.stdout;
    stderr = output.stderr;
    diagnostics = parseClangDiagnostics(`${output.stderr}\n${output.stdout}`);
    ok = output.ok;
    code = output.code;
  }

  if (!ok) {
    return {
      success: false,
      diagnostics: ensureFailureDiagnostic(diagnostics, {
        file: project.config.entry,
        source: failedTool.toLowerCase(),
        message: stderr.trim() || `${failedTool} exited with code ${code}.`,
      }),
      artifact: undefined,
      stdout,
      stderr,
      cacheHit: false,
    };
  }

  progress(requestId, "linking", "Reading linked WebAssembly module", 0.9);
  const bytes = await directory.readFile("/build/app.wasm");
  const artifact: WasmArtifact = {
    kind: "wasm",
    ...createArtifactBase(project, cacheKey, started, bytes.byteLength, [CLANG_PACKAGE]),
    bytes,
  };
  return { success: true, diagnostics, artifact, stdout, stderr, cacheHit: false };
}

async function buildRust(project: Project, cacheKey: string, requestId: string): Promise<BuildResult> {
  const started = performance.now();
  const directory = projectDirectory(project.files);
  await ensureDirectory(directory, "/build");
  await ensureDirectory(directory, "/.localwasi");
  await directory.writeFile("/.localwasi/rust_core.py", RUST_CORE_COMPILER);

  progress(requestId, "checking", "Translating Rust/WASI core profile", 0.25);
  const python = await getPackage(PYTHON_PACKAGE, requestId);
  const translate = await command(python, "python").run({
    args: [
      "/project/.localwasi/rust_core.py",
      "--input", `/project/${project.config.entry}`,
      "--output", "/project/build/main.c",
      "--diagnostics", "/project/build/rust-diagnostics.json",
    ],
    cwd: "/project",
    mount: { "/project": directory },
  });
  const translateOutput = await translate.wait();
  let diagnostics: Diagnostic[] = [];
  try {
    diagnostics = JSON.parse(await directory.readTextFile("/build/rust-diagnostics.json")) as Diagnostic[];
  } catch {
    diagnostics = parsePythonDiagnostics(translateOutput.stderr);
  }
  if (!translateOutput.ok) {
    return {
      success: false,
      diagnostics: ensureFailureDiagnostic(diagnostics, {
        file: project.config.entry,
        source: "rust-core",
        message: translateOutput.stderr.trim() || "Rust/WASI core translation failed.",
      }),
      stdout: translateOutput.stdout,
      stderr: translateOutput.stderr,
      cacheHit: false,
    };
  }

  progress(requestId, "compiling", "Compiling translated Rust with Clang", 0.55);
  const clang = await getPackage(CLANG_PACKAGE, requestId);
  let stdout: string;
  let stderr: string;
  let ok: boolean;
  let code: number;
  if (project.config.target === "wasi") {
    const output = await runPlainWasiPipeline(clang, directory, ["build/main.c"], false, compilerFlags(project), requestId);
    stdout = output.stdout;
    stderr = output.stderr;
    ok = output.ok;
    code = output.code;
    diagnostics = [...diagnostics, ...output.diagnostics];
  } else {
    const instance = await command(clang, "clang").run({
      args: ["-std=c17", ...compilerFlags(project), "-fdiagnostics-color=never", "build/main.c", "-o", "build/app.wasm"],
      cwd: "/project",
      env: { PATH: "/bin" },
      mount: { "/project": directory },
    });
    const output = await instance.wait();
    stdout = output.stdout;
    stderr = output.stderr;
    ok = output.ok;
    code = output.code;
    diagnostics = [...diagnostics, ...parseClangDiagnostics(`${output.stderr}\n${output.stdout}`)];
  }
  if (!ok) {
    return {
      success: false,
      diagnostics: ensureFailureDiagnostic(diagnostics, {
        file: project.config.entry,
        source: "clang",
        message: stderr.trim() || `Clang pipeline exited with code ${code}.`,
      }),
      stdout: `${translateOutput.stdout}${stdout}`,
      stderr: `${translateOutput.stderr}${stderr}`,
      cacheHit: false,
    };
  }
  const bytes = await directory.readFile("/build/app.wasm");
  const artifact: WasmArtifact = {
    kind: "wasm",
    ...createArtifactBase(project, cacheKey, started, bytes.byteLength, [PYTHON_PACKAGE, CLANG_PACKAGE]),
    bytes,
  };
  return {
    success: true,
    diagnostics,
    artifact,
    stdout: `${translateOutput.stdout}${stdout}`,
    stderr: `${translateOutput.stderr}${stderr}`,
    cacheHit: false,
  };
}

function sumFileSize(files: Record<string, string | Uint8Array>): number {
  return Object.values(files).reduce((total, file) => total + (typeof file === "string" ? encoder.encode(file).byteLength : file.byteLength), 0);
}

function runtimeManifest(project: Project, runtimePackage: string, commandName: string, entry: string): string {
  return JSON.stringify({
    schema: "https://localwasi.dev/schemas/runtime-bundle-v1.json",
    version: 1,
    name: project.name,
    target: project.config.target,
    language: project.config.language,
    runtime: { package: runtimePackage, command: commandName },
    entry,
    files: project.files.map((file) => file.path),
  }, null, 2);
}

async function buildPython(project: Project, cacheKey: string, requestId: string): Promise<BuildResult> {
  const started = performance.now();
  const directory = projectDirectory(project.files);
  await ensureDirectory(directory, "/build");
  const pythonFiles = project.files.filter((file) => file.path.endsWith(".py"));
  const compileScript = [
    "import pathlib, py_compile",
    `files = ${JSON.stringify(pythonFiles.map((file) => file.path))}`,
    "for name in files:",
    "    output = pathlib.Path('/project/build') / pathlib.Path(name).with_suffix('.pyc')",
    "    output.parent.mkdir(parents=True, exist_ok=True)",
    "    py_compile.compile('/project/' + name, cfile=str(output), doraise=True)",
  ].join("\n");
  progress(requestId, "compiling", `Byte-compiling ${pythonFiles.length} Python file${pythonFiles.length === 1 ? "" : "s"}`, 0.55);
  const pkg = await getPackage(PYTHON_PACKAGE, requestId);
  const instance = await command(pkg, "python").run({
    args: ["-c", compileScript],
    cwd: "/project",
    mount: { "/project": directory },
  });
  const output = await instance.wait();
  const diagnostics = parsePythonDiagnostics(`${output.stderr}\n${output.stdout}`);
  if (!output.ok) {
    return {
      success: false,
      diagnostics: ensureFailureDiagnostic(diagnostics, {
        file: project.config.entry,
        source: "python",
        message: output.stderr.trim() || `Python exited with code ${output.code}.`,
      }),
      ...outputResult(output),
      cacheHit: false,
    };
  }
  const files: Record<string, string | Uint8Array> = Object.fromEntries(project.files.map((file) => [file.path, file.content]));
  for (const file of pythonFiles) {
    const compiledPath = `build/${file.path.replace(/\.py$/, ".pyc")}`;
    files[compiledPath] = await directory.readFile(`/${compiledPath}`);
  }
  const entry = `build/${project.config.entry.replace(/\.py$/, ".pyc")}`;
  const manifest = runtimeManifest(project, PYTHON_PACKAGE, "python", entry);
  files["localwasi.manifest.json"] = manifest;
  const size = sumFileSize(files);
  const artifact: RuntimeBundleArtifact = {
    kind: "runtime-bundle",
    ...createArtifactBase(project, cacheKey, started, size, [PYTHON_PACKAGE]),
    name: `${project.name}.python-${project.config.target}.json`,
    runtimePackage: PYTHON_PACKAGE,
    command: "python",
    entry,
    files,
    manifest,
  };
  return { success: true, diagnostics, artifact, ...outputResult(output), cacheHit: false };
}

interface TranspileResponse {
  outputs: Record<string, string>;
  diagnostics: Diagnostic[];
}

async function transpileScriptProject(project: Project, requestId: string): Promise<{ response?: TranspileResponse; output: Output }> {
  const scriptFiles = project.files.filter((file) => /\.(?:m?js|m?ts)$/.test(file.path));
  const directory = projectDirectory(project.files);
  await ensureDirectory(directory, "/.localwasi");
  await directory.writeFile("/.localwasi/typescript.js", await loadTypescriptSource());
  await directory.writeFile("/.localwasi/tsc.mjs", TYPESCRIPT_DRIVER);
  await directory.writeFile("/.localwasi/tsconfig.json", JSON.stringify({
    files: scriptFiles.map((file) => file.path),
    typescript: project.config.language === "typescript",
  }));
  const pkg = await getPackage(QUICKJS_PACKAGE, requestId);
  const instance = await command(pkg, "qjs").run({
    args: ["--std", "-m", "/project/.localwasi/tsc.mjs"],
    cwd: "/project",
    mount: { "/project": directory },
  });
  const output = await instance.wait();
  const marker = "__LOCALWASI_TSC__";
  const line = output.stdout.split(/\r?\n/).find((value) => value.startsWith(marker));
  return { response: line ? JSON.parse(line.slice(marker.length)) as TranspileResponse : undefined, output };
}

async function buildScript(project: Project, cacheKey: string, requestId: string): Promise<BuildResult> {
  const started = performance.now();
  progress(requestId, "compiling", project.config.language === "typescript" ? "Transpiling TypeScript inside QuickJS/WASI" : "Checking JavaScript inside QuickJS/WASI", 0.5);
  const { response, output } = await transpileScriptProject(project, requestId);
  const diagnostics = response?.diagnostics ?? parseQuickJsDiagnostics(`${output.stderr}\n${output.stdout}`);
  if (!output.ok || !response || diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return {
      success: false,
      diagnostics: ensureFailureDiagnostic(diagnostics, {
        file: project.config.entry,
        source: "quickjs",
        message: output.stderr.trim() || "The TypeScript compiler did not produce a result.",
      }),
      ...outputResult(output),
      cacheHit: false,
    };
  }
  const files: Record<string, string | Uint8Array> = { ...response.outputs };
  const entry = project.config.entry.replace(/\.(?:m?ts|m?js)$/, ".js");
  const manifest = runtimeManifest(project, QUICKJS_PACKAGE, "qjs", entry);
  files["localwasi.manifest.json"] = manifest;
  const size = sumFileSize(files);
  const artifact: RuntimeBundleArtifact = {
    kind: "runtime-bundle",
    ...createArtifactBase(project, cacheKey, started, size, [QUICKJS_PACKAGE, `typescript@${TYPESCRIPT_VERSION}`]),
    name: `${project.name}.${project.config.language === "typescript" ? "typescript" : "javascript"}-${project.config.target}.json`,
    runtimePackage: QUICKJS_PACKAGE,
    command: "qjs",
    entry,
    files,
    manifest,
  };
  return { success: true, diagnostics, artifact, ...outputResult(output), cacheHit: false };
}

async function buildProject(project: Project, cacheKey: string, requestId: string): Promise<BuildResult> {
  progress(requestId, "checking", "Validating project configuration", 0.05);
  if (!project.files.some((file) => file.path === project.config.entry)) {
    return {
      success: false,
      diagnostics: [{ severity: "error", message: "Configured entry file does not exist.", file: project.config.entry, line: 1, column: 1, source: "project" }],
      stdout: "",
      stderr: "",
      cacheHit: false,
    };
  }
  switch (project.config.language) {
    case "c":
    case "cpp":
      return buildClang(project, cacheKey, requestId);
    case "rust":
      return buildRust(project, cacheKey, requestId);
    case "python":
      return buildPython(project, cacheKey, requestId);
    case "javascript":
    case "typescript":
      return buildScript(project, cacheKey, requestId);
  }
}

function artifactDirectory(artifact: RuntimeBundleArtifact): Directory {
  const initial: Record<string, string | Uint8Array> = {};
  for (const [path, value] of Object.entries(artifact.files)) initial[`/${path}`] = value;
  return new Directory(initial);
}

async function runArtifact(artifact: BuildArtifact, config: ProjectConfig, requestId: string): Promise<RunResult> {
  const started = performance.now();
  progress(requestId, "running", `Running ${artifact.name} with Wasmer`, 0.2);
  let output: Output;
  if (artifact.kind === "wasm") {
    const executable = Wasmer.fromWasm(artifact.bytes, requireRuntime());
    const entrypoint = executable.entrypoint;
    if (!entrypoint) throw new Error("Generated WebAssembly module has no executable entrypoint.");
    const instance = await entrypoint.run({
      args: config.args,
      env: config.env,
      stdin: config.stdin,
    });
    output = await instance.wait();
  } else {
    const pkg = await getPackage(artifact.runtimePackage, requestId);
    const directory = artifactDirectory(artifact);
    const args = artifact.command === "qjs"
      ? ["--std", "-m", `/project/${artifact.entry}`, ...config.args]
      : [`/project/${artifact.entry}`, ...config.args];
    const instance = await command(pkg, artifact.command).run({
      args,
      env: {
        ...(artifact.command === "python" ? { PYTHONPATH: "/project/src", PYTHONDONTWRITEBYTECODE: "1" } : {}),
        ...config.env,
      },
      stdin: config.stdin,
      cwd: "/project",
      mount: { "/project": directory },
    });
    output = await instance.wait();
  }
  if (output.stdout) post({ type: "stream", requestId, stream: "stdout", chunk: output.stdout });
  if (output.stderr) post({ type: "stream", requestId, stream: "stderr", chunk: output.stderr });
  return { code: output.code, stdout: output.stdout, stderr: output.stderr, durationMs: performance.now() - started };
}

async function clearCaches(): Promise<void> {
  packages.clear();
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith("localwasi-toolchains-")).map((name) => caches.delete(name)));
}

scope.addEventListener("message", (event: MessageEvent<CompilerRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      switch (request.type) {
        case "initialize":
          await initializeRuntime(request.requestId);
          post({ type: "ready", requestId: request.requestId });
          break;
        case "build":
          post({ type: "build-result", requestId: request.requestId, result: await buildProject(request.project, request.cacheKey, request.requestId) });
          break;
        case "run":
          post({ type: "run-result", requestId: request.requestId, result: await runArtifact(request.artifact, request.config, request.requestId) });
          break;
        case "clear-toolchain-cache":
          await clearCaches();
          post({ type: "cache-cleared", requestId: request.requestId });
          break;
      }
    } catch (error) {
      const caught = error instanceof Error ? error : new Error(String(error));
      post({ type: "error", requestId: request.requestId, message: caught.message, stack: caught.stack });
    }
  })();
});

export {};
