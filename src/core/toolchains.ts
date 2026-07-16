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
export const QUICKJS_VERSION = "0.15.1";
export const QUICKJS_PACKAGE = `localwasi/quickjs-ng@${QUICKJS_VERSION}`;
export const QUICKJS_ASSET_PATH = `/toolchains/quickjs-${QUICKJS_VERSION}.wasm.gz`;
export const TYPESCRIPT_VERSION = "7.0.2";
export const TYPESCRIPT_ASSET_PATH = `/toolchains/typescript-${TYPESCRIPT_VERSION}.wasm.gz`;

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
    label: "QuickJS-ng",
    artifact: "runtime-bundle",
    compilerPackages: [`typescript@${TYPESCRIPT_VERSION}-wasi`, QUICKJS_PACKAGE],
    runtimePackage: QUICKJS_PACKAGE,
    targets: ["wasi", "wasix"],
    version: QUICKJS_VERSION,
    note: "JavaScript checked by TypeScript/WASI, then executed by the bundled QuickJS-ng/WASI runtime.",
  },
  typescript: {
    language: "typescript",
    label: "TypeScript + QuickJS-ng",
    artifact: "runtime-bundle",
    compilerPackages: [`typescript@${TYPESCRIPT_VERSION}-wasi`],
    runtimePackage: QUICKJS_PACKAGE,
    targets: ["wasi", "wasix"],
    version: TYPESCRIPT_VERSION,
    note: "The native TypeScript compiler and QuickJS-ng runtime both execute as local WASI modules.",
  },
};

export function toolchainCacheIdentity(language: Language) {
  const toolchain = TOOLCHAINS[language];
  return {
    version: toolchain.version,
    compilerPackages: toolchain.compilerPackages,
    runtimePackage: toolchain.runtimePackage,
  };
}

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
    ts: "typescript",
  } as Record<string, Language | undefined>)[extension];
}

export function languageLabel(language: Language): string {
  return ({ c: "C", cpp: "C++", rust: "Rust", python: "Python", javascript: "JavaScript", typescript: "TypeScript" })[language];
}
