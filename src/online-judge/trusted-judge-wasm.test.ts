import { describe, expect, it } from "vitest";
import { validateTrustedJudgeWasm } from "./trusted-judge-wasm";

const encoder = new TextEncoder();

function u32(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function name(value: string): number[] {
  const bytes = [...encoder.encode(value)];
  return [...u32(bytes.length), ...bytes];
}

function section(id: number, payload: readonly number[]): number[] {
  return [id, ...u32(payload.length), ...payload];
}

function module(options: {
  readonly unsupportedImport?: boolean;
  readonly wrongWasiSignature?: boolean;
  readonly validWasiImport?: boolean;
  readonly reservedExport?: boolean;
  readonly startSection?: boolean;
  readonly initialMemoryPages?: number;
} = {}): Uint8Array {
  const importedFunctions = options.unsupportedImport || options.wrongWasiSignature || options.validWasiImport ? 1 : 0;
  const exports = [
    ...name("memory"), 0x02, 0x00,
    ...name("_start"), 0x00, importedFunctions,
    ...(options.reservedExport ? [...name("__wasm_oj_probe"), 0x00, importedFunctions] : []),
  ];
  const importSection = importedFunctions
    ? section(2, [0x01, ...name(options.unsupportedImport ? "env" : "wasi_snapshot_preview1"), ...name(options.unsupportedImport ? "forbidden" : "proc_exit"), 0x00, 0x00])
    : [];
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, options.validWasiImport
      ? [0x02, 0x60, 0x01, 0x7f, 0x00, 0x60, 0x00, 0x00]
      : [0x01, 0x60, 0x00, 0x00]),
    ...importSection,
    ...section(3, [0x01, options.validWasiImport ? 0x01 : 0x00]),
    ...section(5, [0x01, 0x00, ...u32(options.initialMemoryPages ?? 1)]),
    ...section(7, [options.reservedExport ? 0x03 : 0x02, ...exports]),
    ...(options.startSection ? section(8, [importedFunctions]) : []),
    ...section(10, [0x01, 0x02, 0x00, 0x0b]),
  ]);
}

describe("trusted judge Wasm static admission", () => {
  it("accepts the exact command ABI without instantiating it", () => {
    const bytes = module();
    expect(WebAssembly.validate(bytes.slice().buffer)).toBe(true);
    expect(validateTrustedJudgeWasm(bytes)).toEqual({ bytes: bytes.byteLength, initialMemoryPages: 1, imports: [] });
    expect(validateTrustedJudgeWasm(module({ validWasiImport: true })).imports).toEqual(["wasi_snapshot_preview1.proc_exit"]);
  });

  it("rejects imports outside the admitted WASI Preview 1 surface", () => {
    expect(WebAssembly.validate(module({ unsupportedImport: true }).slice().buffer)).toBe(true);
    expect(() => validateTrustedJudgeWasm(module({ unsupportedImport: true }))).toThrow("outside the admitted WASI Preview 1 surface");
    expect(() => validateTrustedJudgeWasm(module({ wrongWasiSignature: true }))).toThrow("invalid WASI ABI signature");
  });

  it("rejects runtime-owned exports and implicit start execution", () => {
    expect(() => validateTrustedJudgeWasm(module({ reservedExport: true }))).toThrow("reserved by WASM-OJ");
    expect(() => validateTrustedJudgeWasm(module({ startSection: true }))).toThrow("must not declare a start section");
  });

  it("rejects an initial memory larger than the problem ceiling", () => {
    expect(() => validateTrustedJudgeWasm(module({ initialMemoryPages: 2 }), { memoryLimitBytes: 65_536 })).toThrow("exceeds the problem memory limit");
  });
});
