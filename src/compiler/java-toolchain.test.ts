import { describe, expect, it, vi } from "vitest";
import type { JavaCompileRequest } from "./java-toolchain";
import { compileJavaGc, type JavaGcCompiler } from "./java-gc";

const request: JavaCompileRequest = {
  entry: "Main.java",
  files: [{ path: "Main.java", language: "java", content: "public class Main {}" }],
  optimization: "release",
};
const classlibs = { sdk: new Uint8Array(), runtime: new Uint8Array() };
const emptyModule = new Int8Array([0, 97, 115, 109, 1, 0, 0, 0]);

function compilerFixture() {
  let report: Parameters<JavaGcCompiler["onDiagnostic"]>[0] = () => {};
  const compiler: JavaGcCompiler = {
    setSdk: vi.fn(),
    setTeaVMClasslib: vi.fn(),
    addSourceFile: vi.fn(),
    onDiagnostic: (listener) => { report = listener; },
    compile: vi.fn(() => true),
    findEntryClass: vi.fn(() => "compiled.Main"),
    generateWebAssembly: vi.fn(() => true),
    getWebAssemblyOutputFile: vi.fn(() => emptyModule),
  };
  return { compiler, engine: { createCompiler: () => compiler }, report: (diagnostic: Parameters<typeof report>[0]) => report(diagnostic) };
}

describe("Java compiler result validation", () => {
  it("preserves complete structured source diagnostics and skips the backend on CE", async () => {
    const fixture = compilerFixture();
    vi.mocked(fixture.compiler.compile).mockImplementation(() => {
      fixture.report({ type: "javac", severity: "error", message: "cannot find symbol\n  symbol: class Missing", fileName: "Main.java", lineNumber: 3 });
      return false;
    });
    const result = await compileJavaGc(fixture.engine, request, classlibs);
    expect(result).toMatchObject({ success: false, diagnostics: [{ severity: "error", file: "Main.java", line: 3 }] });
    expect(result.stderr).toContain("symbol: class Missing");
    expect(fixture.compiler.generateWebAssembly).not.toHaveBeenCalled();
  });

  it("preserves compiler runtime exceptions as infrastructure errors", async () => {
    const fixture = compilerFixture();
    const error = new WebAssembly.RuntimeError("memory access out of bounds");
    vi.mocked(fixture.compiler.compile).mockImplementation(() => { throw error; });
    await expect(compileJavaGc(fixture.engine, request, classlibs)).rejects.toBe(error);
  });

  it("rejects compiler failures without source diagnostics", async () => {
    const fixture = compilerFixture();
    vi.mocked(fixture.compiler.compile).mockReturnValue(false);
    await expect(compileJavaGc(fixture.engine, request, classlibs)).rejects.toThrow("without source diagnostics");
  });

  it("keeps backend failures distinct from student compilation errors", async () => {
    const fixture = compilerFixture();
    vi.mocked(fixture.compiler.generateWebAssembly).mockImplementation(() => {
      fixture.report({ type: "teavm", severity: "error", message: "Native method has no implementation", fileName: null, lineNumber: -1 });
      return false;
    });
    await expect(compileJavaGc(fixture.engine, request, classlibs)).rejects.toThrow("Native method has no implementation");
  });

  it("rejects missing and malformed artifacts", async () => {
    const fixture = compilerFixture();
    vi.mocked(fixture.compiler.getWebAssemblyOutputFile).mockReturnValue(null);
    await expect(compileJavaGc(fixture.engine, request, classlibs)).rejects.toThrow("did not produce app.wasm");
    vi.mocked(fixture.compiler.getWebAssemblyOutputFile).mockReturnValue(new Int8Array([1, 2, 3]));
    await expect(compileJavaGc(fixture.engine, request, classlibs)).rejects.toThrow("invalid WebAssembly");
  });

  it("passes the requested optimization mode and returns validated independent bytes", async () => {
    const fixture = compilerFixture();
    const result = await compileJavaGc(fixture.engine, { ...request, optimization: "debug" }, classlibs);
    expect(fixture.compiler.generateWebAssembly).toHaveBeenCalledWith({ mainClass: "compiled.Main", outputName: "app", optimization: "debug" });
    expect(fixture.compiler.findEntryClass).toHaveBeenCalledWith("Main.java");
    expect(result.success).toBe(true);
    expect(result.wasm).toEqual(Uint8Array.from(emptyModule));
    expect(result.wasm?.buffer).not.toBe(emptyModule.buffer);
  });
});
