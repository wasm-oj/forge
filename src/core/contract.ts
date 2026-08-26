/**
 * The single compatibility boundary shared by WASM-OJ compilers, runners,
 * artifacts, judge specifications, caches, and conformance evidence.
 *
 * Package and upstream toolchain versions remain independent release metadata;
 * they do not define WASM-OJ protocol compatibility.
 */
export const WASM_OJ_CONTRACT_VERSION = 2 as const;

export const WASM_OJ_CONTRACT_ID = `wasm-oj-v${WASM_OJ_CONTRACT_VERSION}` as const;

export const WASM_OJ_SCHEMAS = Object.freeze({
  clangPins: `${WASM_OJ_CONTRACT_ID}/clang-pins`,
  clangLibcxxPch: `${WASM_OJ_CONTRACT_ID}/clang-libcxx-pch`,
  clangToolchain: `${WASM_OJ_CONTRACT_ID}/clang-toolchain`,
  compileBatch: `${WASM_OJ_CONTRACT_ID}/compile-batch`,
  compileTrace: `${WASM_OJ_CONTRACT_ID}/compile-trace`,
  conformance: `${WASM_OJ_CONTRACT_ID}/conformance`,
  conformanceEvidence: `${WASM_OJ_CONTRACT_ID}/conformance-evidence`,
  conformanceMatrix: `${WASM_OJ_CONTRACT_ID}/conformance-matrix`,
  cppDependencyLock: `${WASM_OJ_CONTRACT_ID}/cpp-dependency-lock`,
  dependencyLock: `${WASM_OJ_CONTRACT_ID}/dependency-lock`,
  dependencyOfflineBundle: `${WASM_OJ_CONTRACT_ID}/dependency-offline-bundle`,
  incrementalBuildGraph: `${WASM_OJ_CONTRACT_ID}/incremental-build-graph`,
  interactiveRequest: `${WASM_OJ_CONTRACT_ID}/interactive-request`,
  goToolchain: `${WASM_OJ_CONTRACT_ID}/go-toolchain`,
  objectCache: `${WASM_OJ_CONTRACT_ID}/object-cache`,
  pythonToolchain: `${WASM_OJ_CONTRACT_ID}/python-toolchain`,
  replayBundle: `${WASM_OJ_CONTRACT_ID}/replay-bundle`,
  rustToolchain: `${WASM_OJ_CONTRACT_ID}/rust-toolchain`,
  runRequest: `${WASM_OJ_CONTRACT_ID}/run-request`,
  runtimeBundle: `${WASM_OJ_CONTRACT_ID}/runtime-bundle`,
  runtimeCoreLicenses: `${WASM_OJ_CONTRACT_ID}/runtime-core-licenses`,
  thirdPartyComponents: `${WASM_OJ_CONTRACT_ID}/third-party-components`,
  wasmerSdkLicenses: `${WASM_OJ_CONTRACT_ID}/wasmer-sdk-licenses`,
  toolchainPackage: `${WASM_OJ_CONTRACT_ID}/toolchain-package`,
} as const);

export const WASM_OJ_STORAGE = Object.freeze({
  database: `${WASM_OJ_CONTRACT_ID}:storage`,
  databaseVersion: WASM_OJ_CONTRACT_VERSION,
  dependencyCache: `${WASM_OJ_CONTRACT_ID}:dependencies`,
  incrementalBuildCache: `${WASM_OJ_CONTRACT_ID}:incremental-build-cache`,
  runtimeFilesCache: `${WASM_OJ_CONTRACT_ID}:runtime-files`,
  toolchainCache: `${WASM_OJ_CONTRACT_ID}:toolchains`,
} as const);
