import path from "node:path";
import type { ServerToolchainSource } from "@wasm-oj/contracts";
import {
  serverToolchainAssetFiles,
  snapshotServerToolchainSources,
} from "./toolchain-sources.ts";

export interface VerifiedServerDistributionEvidence {
  readonly compilerExecutable: string;
  readonly compilerSha256: string;
  readonly runtimeExecutable: string;
  readonly runnerSha256: string;
  readonly toolchains: readonly ServerToolchainSource[];
  /** Descriptor asset path to the digest verified by immutable-container startup. */
  readonly toolchainAssets: Readonly<Record<string, string>>;
  readonly toolchainRootSha256: string;
}

export interface VerifiedServerDistribution {
  readonly compilerExecutable: string;
  readonly runtimeExecutable: string;
  readonly toolchainAssetFiles: Readonly<Record<string, string>>;
  readonly toolchainRootSha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const verifiedDistributions = new WeakSet<VerifiedServerDistribution>();

/** @internal Create a process-local capability from already verified container inventory. */
export function createVerifiedServerDistribution(
  evidence: VerifiedServerDistributionEvidence,
): VerifiedServerDistribution {
  if (!SHA256.test(evidence.compilerSha256) || !SHA256.test(evidence.runnerSha256)
    || !SHA256.test(evidence.toolchainRootSha256)) {
    throw new Error("Verified WASM-OJ distribution evidence contains an invalid digest.");
  }
  const toolchains = snapshotServerToolchainSources(evidence.toolchains);
  const declaredAssets = toolchains.flatMap((source) => source.descriptor.assets);
  const evidencePaths = Object.keys(evidence.toolchainAssets).sort();
  const declaredPaths = declaredAssets.map((asset) => asset.path).sort();
  if (evidencePaths.length !== declaredPaths.length
    || evidencePaths.some((assetPath, index) => assetPath !== declaredPaths[index])) {
    throw new Error("Verified WASM-OJ distribution evidence does not exactly match its toolchain descriptors.");
  }
  for (const asset of declaredAssets) {
    if (evidence.toolchainAssets[asset.path] !== asset.sha256) {
      throw new Error(`Verified WASM-OJ distribution evidence does not bind toolchain asset '${asset.path}'.`);
    }
  }
  const toolchainAssetFiles = serverToolchainAssetFiles(toolchains, declaredPaths);
  const token = Object.freeze({
    compilerExecutable: path.resolve(evidence.compilerExecutable),
    runtimeExecutable: path.resolve(evidence.runtimeExecutable),
    toolchainAssetFiles,
    toolchainRootSha256: evidence.toolchainRootSha256,
  });
  verifiedDistributions.add(token);
  return token;
}

export function assertVerifiedServerDistribution(
  token: VerifiedServerDistribution,
  paths: Pick<VerifiedServerDistribution, "compilerExecutable" | "runtimeExecutable">,
  toolchains: readonly ServerToolchainSource[],
): void {
  if (!verifiedDistributions.has(token)
    || token.compilerExecutable !== path.resolve(paths.compilerExecutable)
    || token.runtimeExecutable !== path.resolve(paths.runtimeExecutable)) {
    throw new Error("WASM-OJ verified-distribution token does not authorize the resolved server runtime.");
  }
  assertVerifiedToolchainDistribution(token, toolchains);
}

export function assertVerifiedToolchainDistribution(
  token: VerifiedServerDistribution,
  toolchains: readonly ServerToolchainSource[],
): void {
  if (!verifiedDistributions.has(token)) {
    throw new Error("WASM-OJ verified-distribution token is not process-authentic.");
  }
  const assetPaths = toolchains.flatMap((source) => source.descriptor.assets.map((asset) => asset.path));
  const actual = serverToolchainAssetFiles(toolchains, assetPaths);
  if (!sameRecord(token.toolchainAssetFiles, actual)) {
    throw new Error("WASM-OJ verified-distribution token does not authorize these toolchain sources.");
  }
}

function sameRecord(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): boolean {
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  return expectedEntries.length === actualEntries.length
    && expectedEntries.every(([key, value], index) => {
      const candidate = actualEntries[index];
      return candidate?.[0] === key && candidate[1] === value;
    });
}
