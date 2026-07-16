import type { Language, TargetAbi } from "./types";

export interface ToolchainDefinition {
  language: Language;
  label: string;
  artifact: "wasm" | "runtime-bundle";
  compilerPackages: string[];
  runtimePackage?: string;
  targets: TargetAbi[];
  version: string;
  note: string;
}

export const CLANG_PACKAGE = "clang/clang@0.160000.1";
export const PYTHON_PACKAGE = "python/python@=0.2.0";
export const QUICKJS_PACKAGE = "adamz/quickjs@0.20210327.0";
export const TYPESCRIPT_VERSION = "4.9.5";
export const TYPESCRIPT_ASSET_PATH = `/toolchains/typescript-${TYPESCRIPT_VERSION}.js`;

export const TOOLCHAINS: Record<Language, ToolchainDefinition> = {
  c: {
    language: "c",
    label: "Clang 16",
    artifact: "wasm",
    compilerPackages: [CLANG_PACKAGE],
    targets: ["wasi", "wasix"],
    version: "16.0.0",
    note: "Native WASI/WASIX module via Clang and wasm-ld.",
  },
  cpp: {
    language: "cpp",
    label: "Clang++ 16",
    artifact: "wasm",
    compilerPackages: [CLANG_PACKAGE],
    targets: ["wasi", "wasix"],
    version: "16.0.0",
    note: "Native WASI/WASIX module via Clang and wasm-ld.",
  },
  rust: {
    language: "rust",
    label: "Rust/WASI core profile",
    artifact: "wasm",
    compilerPackages: [PYTHON_PACKAGE, CLANG_PACKAGE],
    targets: ["wasi", "wasix"],
    version: "0.1.0",
    note: "A documented Rust core profile for dependency-free programs; Cargo and full rustc are not emulated.",
  },
  python: {
    language: "python",
    label: "CPython 3.12",
    artifact: "runtime-bundle",
    compilerPackages: [PYTHON_PACKAGE],
    runtimePackage: PYTHON_PACKAGE,
    targets: ["wasix"],
    version: "3.12.0",
    note: "Byte-compiled project bundled with the browser-compatible CPython/WASIX runtime contract.",
  },
  javascript: {
    language: "javascript",
    label: "QuickJS",
    artifact: "runtime-bundle",
    compilerPackages: [QUICKJS_PACKAGE],
    runtimePackage: QUICKJS_PACKAGE,
    targets: ["wasi", "wasix"],
    version: "2021-03-27",
    note: "ES modules bundled with the QuickJS WASI runtime contract.",
  },
  typescript: {
    language: "typescript",
    label: "TypeScript + QuickJS",
    artifact: "runtime-bundle",
    compilerPackages: [QUICKJS_PACKAGE],
    runtimePackage: QUICKJS_PACKAGE,
    targets: ["wasi", "wasix"],
    version: TYPESCRIPT_VERSION,
    note: "TypeScript compiler executes inside QuickJS/WASI, then emits an executable runtime bundle.",
  },
};

export function extensionLanguage(path: string): Language | undefined {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ({
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    rs: "rust",
    py: "python",
    js: "javascript",
    mjs: "javascript",
    ts: "typescript",
    mts: "typescript",
  } as Record<string, Language | undefined>)[extension];
}

export function languageLabel(language: Language): string {
  return ({ c: "C", cpp: "C++", rust: "Rust", python: "Python", javascript: "JavaScript", typescript: "TypeScript" })[language];
}
