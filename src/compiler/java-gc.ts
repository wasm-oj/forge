import type { Diagnostic } from "../core/types.ts";
import type { JavaCompileRequest, JavaCompileResult } from "./java-toolchain.ts";
import { compileJavaModule, defaults, hasStringBuiltins } from "./vendor/java-compiler-runtime.mjs";
import { jsBodyFactories } from "./vendor/java-compiler-bindings.mjs";

interface CompilerDiagnostic {
  type: string;
  severity: "error" | "warning";
  message: string;
  fileName: string | null;
  lineNumber: number;
}

export interface JavaGcCompiler {
  setSdk(bytes: Int8Array): void;
  setTeaVMClasslib(bytes: Int8Array): void;
  addSourceFile(name: string, content: string): void;
  onDiagnostic(listener: (diagnostic: CompilerDiagnostic) => void): void;
  compile(): boolean;
  findEntryClass(sourcePath: string): string | null;
  generateWebAssembly(options: { mainClass: string; outputName: string; optimization: string }): boolean;
  getWebAssemblyOutputFile(name: string): Int8Array | null;
}

export interface JavaGcEngine {
  createCompiler(): JavaGcCompiler;
}

export async function loadJavaGcEngine(bytes: Uint8Array): Promise<JavaGcEngine> {
  const wasmModule = await compileJavaModule(bytes);
  const imports: WebAssembly.Imports = {};
  const exports: Record<string, unknown> = {};
  const context = defaults(imports, exports, { jsBodyFactories }, wasmModule, await hasStringBuiltins());
  const instance = await WebAssembly.instantiate(wasmModule, imports);
  context.supplyExports(instance.exports);
  for (const [key, value] of Object.entries(instance.exports)) {
    if (value instanceof WebAssembly.Global) Object.defineProperty(exports, key, { get: () => value.value });
  }
  if (typeof exports.createCompiler !== "function") throw new Error("The pinned Java compiler has no createCompiler export.");
  return exports as unknown as JavaGcEngine;
}

export async function compileJavaGc(
  engine: JavaGcEngine,
  request: JavaCompileRequest,
  classlibs: { sdk: Uint8Array; runtime: Uint8Array },
): Promise<JavaCompileResult> {
  const entry = request.files.find((file) => file.path === request.entry);
  if (!entry) throw new Error(`Java entry '${request.entry}' does not exist.`);
  const compiler = engine.createCompiler();
  compiler.setSdk(new Int8Array(classlibs.sdk.buffer, classlibs.sdk.byteOffset, classlibs.sdk.byteLength));
  compiler.setTeaVMClasslib(new Int8Array(classlibs.runtime.buffer, classlibs.runtime.byteOffset, classlibs.runtime.byteLength));
  const diagnostics: Diagnostic[] = [];
  const backendErrors: string[] = [];
  compiler.onDiagnostic((diagnostic) => {
    if (diagnostic.type !== "javac") {
      if (diagnostic.severity === "error") backendErrors.push(diagnostic.message);
      return;
    }
    diagnostics.push({
      severity: diagnostic.severity,
      message: diagnostic.message,
      source: "java",
      line: Math.max(1, diagnostic.lineNumber),
      column: 1,
      file: diagnostic.fileName ?? request.entry,
    });
  });
  for (const file of request.files) {
    if (file.path.endsWith(".java")) compiler.addSourceFile(file.path, file.content);
  }
  const compiled = compiler.compile();
  const stderr = diagnostics.map((diagnostic) => `${diagnostic.file ?? request.entry}:${diagnostic.line ?? 1}: ${diagnostic.severity}: ${diagnostic.message}`).join("\n");
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { success: false, stdout: "", stderr, diagnostics };
  }
  if (!compiled) throw new Error("Java compilation failed without source diagnostics.");
  const mainClass = compiler.findEntryClass(request.entry);
  if (!mainClass) throw new Error(`Java entry '${request.entry}' did not emit its named class.`);
  const generated = compiler.generateWebAssembly({
    mainClass,
    outputName: "app",
    optimization: request.optimization,
  });
  if (!generated || backendErrors.length) {
    throw new Error(`Java WASI backend failed.${backendErrors.length ? `\n${backendErrors.join("\n")}` : ""}`);
  }
  const output = compiler.getWebAssemblyOutputFile("app");
  if (!output) throw new Error("Java compiler did not produce app.wasm.");
  const wasm = Uint8Array.from(output);
  try {
    await WebAssembly.compile(wasm);
  } catch (cause) {
    throw new Error("Java compiler produced invalid WebAssembly.", { cause });
  }
  return { success: true, stdout: "", stderr, diagnostics, wasm };
}
