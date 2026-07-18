/**
 * The single compatibility boundary shared by Forge compilers, runners,
 * artifacts, judge specifications, caches, and conformance evidence.
 *
 * Package and upstream toolchain versions remain independent release metadata;
 * they do not define Forge protocol compatibility.
 */
export const FORGE_CONTRACT_VERSION = 1 as const;

export const FORGE_CONTRACT_ID = `wasm-oj-forge-v${FORGE_CONTRACT_VERSION}` as const;

export const FORGE_SCHEMAS = Object.freeze({
  clangPins: `${FORGE_CONTRACT_ID}/clang-pins`,
  clangLibcxxPch: `${FORGE_CONTRACT_ID}/clang-libcxx-pch`,
  clangToolchain: `${FORGE_CONTRACT_ID}/clang-toolchain`,
  compileBatch: `${FORGE_CONTRACT_ID}/compile-batch`,
  compileTrace: `${FORGE_CONTRACT_ID}/compile-trace`,
  conformance: `${FORGE_CONTRACT_ID}/conformance`,
  conformanceEvidence: `${FORGE_CONTRACT_ID}/conformance-evidence`,
  conformanceMatrix: `${FORGE_CONTRACT_ID}/conformance-matrix`,
  costBaselineManifest: `${FORGE_CONTRACT_ID}/cost-baseline-manifest`,
  costBaselineRaw: `${FORGE_CONTRACT_ID}/cost-baseline-raw`,
  costBaselineTable: `${FORGE_CONTRACT_ID}/cost-baseline-table`,
  cppDependencyLock: `${FORGE_CONTRACT_ID}/cpp-dependency-lock`,
  dependencyLock: `${FORGE_CONTRACT_ID}/dependency-lock`,
  dependencyOfflineBundle: `${FORGE_CONTRACT_ID}/dependency-offline-bundle`,
  incrementalBuildGraph: `${FORGE_CONTRACT_ID}/incremental-build-graph`,
  interactiveRequest: `${FORGE_CONTRACT_ID}/interactive-request`,
  goToolchain: `${FORGE_CONTRACT_ID}/go-toolchain`,
  objectCache: `${FORGE_CONTRACT_ID}/object-cache`,
  pythonToolchain: `${FORGE_CONTRACT_ID}/python-toolchain`,
  replayBundle: `${FORGE_CONTRACT_ID}/replay-bundle`,
  rustToolchain: `${FORGE_CONTRACT_ID}/rust-toolchain`,
  runRequest: `${FORGE_CONTRACT_ID}/run-request`,
  runtimeBundle: `${FORGE_CONTRACT_ID}/runtime-bundle`,
  runtimeCoreLicenses: `${FORGE_CONTRACT_ID}/runtime-core-licenses`,
  thirdPartyComponents: `${FORGE_CONTRACT_ID}/third-party-components`,
  wasmerSdkLicenses: `${FORGE_CONTRACT_ID}/wasmer-sdk-licenses`,
} as const);

export const FORGE_STORAGE = Object.freeze({
  database: `${FORGE_CONTRACT_ID}:storage`,
  databaseVersion: FORGE_CONTRACT_VERSION,
  dependencyCache: `${FORGE_CONTRACT_ID}:dependencies`,
  incrementalBuildCache: `${FORGE_CONTRACT_ID}:incremental-build-cache`,
  runtimeFilesCache: `${FORGE_CONTRACT_ID}:runtime-files`,
  toolchainCache: `${FORGE_CONTRACT_ID}:toolchains`,
} as const);
