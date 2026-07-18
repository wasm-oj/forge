import type { Diagnostic, OptimizationLevel, ProjectFile } from "../core/types.ts";
import { FORGE_SCHEMAS } from "../core/contract.ts";
import {
  GO_COMPRESSED_PACKAGE_SHA256,
  GO_PACKAGE_ASSET_PATH,
  GO_PACKAGE_MANIFEST_ASSET_PATH,
  GO_PACKAGE_MANIFEST_SHA256,
  GO_PACKAGE_SHA256,
  GO_COMPRESSED_STANDARD_LIBRARY_SHA256,
  GO_COMPILER_SHA256,
  GO_LINKER_SHA256,
  GO_STANDARD_LIBRARY_ASSET_PATH,
  GO_STANDARD_LIBRARY_SHA256,
  GO_VERSION,
} from "../core/toolchains.ts";

export const GO_LANGUAGE_VERSION = `go${GO_VERSION.split(".").slice(0, 2).join(".")}`;
export const GO_COMPILE_TIMEOUT_MS = 180_000;
export const GO_ARCHIVE_PATH = "/work/build/main.a";
export const GO_OUTPUT_PATH = "/work/build/app.wasm";
/** Bytes consumed by the Go runtime's internal startup seed before user code runs. */
export const GO_RUNTIME_STARTUP_ENTROPY_BYTES = 32;

export const GO_TOOLCHAIN = Object.freeze({
  version: GO_VERSION,
  target: "wasip1/wasm",
  packageAsset: GO_PACKAGE_ASSET_PATH,
  packageCompressedSha256: GO_COMPRESSED_PACKAGE_SHA256,
  packageSha256: GO_PACKAGE_SHA256,
  manifestAsset: GO_PACKAGE_MANIFEST_ASSET_PATH,
  manifestSha256: GO_PACKAGE_MANIFEST_SHA256,
  standardLibraryAsset: GO_STANDARD_LIBRARY_ASSET_PATH,
  standardLibraryCompressedSha256: GO_COMPRESSED_STANDARD_LIBRARY_SHA256,
  standardLibrarySha256: GO_STANDARD_LIBRARY_SHA256,
  compilerSha256: GO_COMPILER_SHA256,
  linkerSha256: GO_LINKER_SHA256,
});

export interface GoCompileRequest {
  entry: string;
  files: readonly ProjectFile[];
  optimization: OptimizationLevel;
}

export interface GoCompileResult {
  success: boolean;
  wasm?: Uint8Array;
  stdout: string;
  stderr: string;
  diagnostics: Diagnostic[];
}

export interface GoPackageContract {
  readonly importPath: string;
  readonly archivePath: string;
  readonly sha256: string;
}

export interface GoToolchainManifestContract {
  readonly packages: readonly GoPackageContract[];
}

export function decodeGoToolchainManifest(bytes: Uint8Array): GoToolchainManifestContract {
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
  const compiler = asRecord(manifest.compiler, "compiler");
  const linker = asRecord(manifest.linker, "linker");
  const output = asRecord(manifest.output, "output");
  const standardLibrary = asRecord(manifest.standardLibrary, "standardLibrary");
  const replacements = [
    "wasi_snapshot_preview1.random_get",
    "wasi_snapshot_preview1.clock_time_get",
    "wasi_snapshot_preview1.sock_accept",
    "wasi_snapshot_preview1.sock_shutdown",
  ];
  if (
    manifest.schema !== FORGE_SCHEMAS.goToolchain
    || manifest.version !== GO_TOOLCHAIN.version
    || manifest.target !== GO_TOOLCHAIN.target
    || compiler.command !== "go-compile"
    || compiler.sha256 !== GO_TOOLCHAIN.compilerSha256
    || linker.command !== "go-link"
    || linker.sha256 !== GO_TOOLCHAIN.linkerSha256
    || JSON.stringify(manifest.deterministicReplacements) !== JSON.stringify(replacements)
    || manifest.filesystemMount !== null
    || output.sha256 !== GO_TOOLCHAIN.packageSha256
    || output.compressedSha256 !== GO_TOOLCHAIN.packageCompressedSha256
    || standardLibrary.sha256 !== GO_TOOLCHAIN.standardLibrarySha256
    || standardLibrary.compressedSha256 !== GO_TOOLCHAIN.standardLibraryCompressedSha256
    || standardLibrary.format !== "FORGEGO1"
  ) {
    throw new Error("Pinned Go toolchain manifest does not match the compiler contract.");
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length < 200) {
    throw new Error("Pinned Go toolchain manifest has an incomplete standard library.");
  }
  let previous = "";
  const packages = manifest.packages.map((value): GoPackageContract => {
    const item = asRecord(value, "packages[]");
    if (
      typeof item.importPath !== "string"
      || item.importPath <= previous
      || typeof item.archivePath !== "string"
      || item.archivePath !== `/go/pkg/${item.importPath}.a`
      || typeof item.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(item.sha256)
    ) {
      throw new Error("Pinned Go toolchain manifest contains a non-canonical package entry.");
    }
    previous = item.importPath;
    return Object.freeze({
      importPath: item.importPath,
      archivePath: item.archivePath,
      sha256: item.sha256,
    });
  });
  return Object.freeze({ packages: Object.freeze(packages) });
}

interface GoStandardLibraryIndexEntry extends GoPackageContract {
  offset: number;
  length: number;
}

export function decodeGoStandardLibrary(
  bytes: Uint8Array,
  packages: readonly GoPackageContract[],
): Record<string, Uint8Array> {
  if (bytes.byteLength < 12 || new TextDecoder().decode(bytes.subarray(0, 8)) !== "FORGEGO1") {
    throw new Error("Pinned Go standard library has an invalid format header.");
  }
  const indexLength = new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0, true);
  const dataOffset = 12 + indexLength;
  if (dataOffset > bytes.byteLength) throw new Error("Pinned Go standard-library index exceeds its archive.");
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(12, dataOffset))) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== packages.length) {
    throw new Error("Pinned Go standard-library index does not match the manifest.");
  }
  const files: Record<string, Uint8Array> = {
    "/go/VERSION": new TextEncoder().encode(`go${GO_VERSION}\n`),
  };
  let expectedOffset = 0;
  for (let index = 0; index < packages.length; index += 1) {
    const entry = asRecord(parsed[index], "standardLibrary[]") as unknown as GoStandardLibraryIndexEntry;
    const declared = packages[index];
    if (
      entry.importPath !== declared.importPath
      || entry.archivePath !== declared.archivePath
      || entry.sha256 !== declared.sha256
      || !Number.isSafeInteger(entry.offset)
      || entry.offset !== expectedOffset
      || !Number.isSafeInteger(entry.length)
      || entry.length <= 8
      || dataOffset + entry.offset + entry.length > bytes.byteLength
    ) {
      throw new Error("Pinned Go standard-library index contains a non-canonical archive entry.");
    }
    files[entry.archivePath] = bytes.slice(
      dataOffset + entry.offset,
      dataOffset + entry.offset + entry.length,
    );
    expectedOffset += entry.length;
  }
  if (dataOffset + expectedOffset !== bytes.byteLength) {
    throw new Error("Pinned Go standard library contains trailing or missing archive bytes.");
  }
  return files;
}

/** Normalize the runtime-core compiler filesystem contract to raw bytes. */
export function encodeGoCompilerFiles(
  files: Readonly<Record<string, Uint8Array | string>>,
): Record<string, Uint8Array> {
  const encoder = new TextEncoder();
  return Object.fromEntries(Object.entries(files).map(([path, contents]) => [
    path,
    typeof contents === "string" ? encoder.encode(contents) : contents,
  ]));
}

export function goImportConfig(packages: readonly GoPackageContract[], includeMain: boolean): string {
  const lines = packages.map((item) => `packagefile ${item.importPath}=${item.archivePath}`);
  if (includeMain) lines.push(`packagefile command-line-arguments=${GO_ARCHIVE_PATH}`);
  return `${lines.join("\n")}\n`;
}

export function goCompileArguments(files: readonly ProjectFile[], optimization: OptimizationLevel): string[] {
  const sources = files
    .filter((file) => file.path.endsWith(".go"))
    .map((file) => `/work/${file.path}`)
    .sort();
  if (sources.length === 0) throw new Error("A Go project must contain at least one .go source file.");
  return [
    "-o", GO_ARCHIVE_PATH,
    "-p", "main",
    "-lang", GO_LANGUAGE_VERSION,
    "-complete",
    "-buildid=forge_submission",
    "-c=1",
    "-dwarf=false",
    "-trimpath", "/work=.",
    "-importcfg", "/work/importcfg",
    "-pack",
    ...(optimization === "debug" ? ["-N", "-l"] : []),
    ...sources,
  ];
}

export function goLinkArguments(optimization: OptimizationLevel): string[] {
  return [
    "-o", GO_OUTPUT_PATH,
    "-importcfg", "/work/importcfg.link",
    "-buildmode=exe",
    "-buildid=",
    ...(optimization === "release" ? ["-s", "-w"] : []),
    GO_ARCHIVE_PATH,
  ];
}

export function deterministicGoCompilerEnvironment(): Record<string, string> {
  return {
    GOOS: "wasip1",
    GOARCH: "wasm",
    GOROOT: "/go",
    GOENV: "off",
    GOTOOLCHAIN: "local",
    PWD: "/work",
    SOURCE_DATE_EPOCH: "946684800",
    TZ: "UTC",
    LC_ALL: "C",
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Pinned Go toolchain manifest '${label}' field must be an object.`);
  }
  return value as Record<string, unknown>;
}

export type GoStageRequest =
  | { type: "compile"; request: GoCompileRequest; assetBaseUrl: string }
  | { type: "shutdown" };

export type GoStageResponse =
  | { type: "result"; result: GoCompileResult }
  | { type: "shutdown-complete" }
  | { type: "error"; message: string; stack?: string };
