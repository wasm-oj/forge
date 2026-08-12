export const CONTAINER_IDENTITY_PATH: string;
export interface ContainerVerifiedDistribution {
  readonly compilerExecutable: string;
  readonly runtimeExecutable: string;
  readonly toolchainAssetFiles: Readonly<Record<string, string>>;
  readonly toolchainRootSha256: string;
}

export interface ContainerVerifiedDistributionEvidence {
  readonly compilerExecutable: string;
  readonly compilerSha256: string;
  readonly runtimeExecutable: string;
  readonly runnerSha256: string;
  readonly toolchains: readonly import("@wasm-oj/contracts").ServerToolchainSource[];
  readonly toolchainAssets: Readonly<Record<string, string>>;
  readonly toolchainRootSha256: string;
}

export interface ContainerIdentity {
  readonly schema: "wasm-oj-platform/container-identity/v2";
  readonly releaseId: string;
  readonly gitCommit: string;
  readonly contract: 2;
  readonly executionRootSha256: string;
  readonly protocol: "wasm-oj-container-v2";
  readonly identitySha256: string;
  readonly runtimeRootSha256: string;
  readonly toolchainRootSha256: string;
  readonly compilerSha256: string;
  readonly runnerSha256: string;
  /** Process-local capability; intentionally non-enumerable in JSON output. */
  readonly verifiedDistribution: ContainerVerifiedDistribution;
}
export function loadEmbeddedContainerIdentity(options?: {
  readonly identityPath?: string;
  readonly compilerPath?: string;
  readonly runnerPath?: string;
  readonly runtimePath?: string;
  readonly toolchainPath?: string;
  readonly executionPath?: string;
  readonly executionExcludedRelativePaths?: readonly string[];
  readonly executionAllowInternalSymlinks?: boolean;
  readonly toolchains?: readonly import("@wasm-oj/contracts").ServerToolchainSource[];
  readonly createVerifiedServerDistribution?: (
    evidence: ContainerVerifiedDistributionEvidence,
  ) => ContainerVerifiedDistribution;
}): Promise<ContainerIdentity>;
export function assertExpectedContainerIdentity(
  job: { readonly expectedReleaseId?: string; readonly expectedContainerIdentitySha256?: string },
  identity: ContainerIdentity,
): void;
