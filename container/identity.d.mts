export const CONTAINER_IDENTITY_PATH: string;
export interface ContainerIdentity {
  readonly schema: "forge-container-identity-v1";
  readonly releaseId: string;
  readonly gitCommit: string;
  readonly contract: 1;
  readonly executionRootSha256: string;
  readonly protocol: "forge-container-v1";
  readonly identitySha256: string;
  readonly runtimeRootSha256: string;
  readonly toolchainRootSha256: string;
  readonly compilerSha256: string;
  readonly runnerSha256: string;
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
}): Promise<ContainerIdentity>;
export function assertExpectedContainerIdentity(
  job: { readonly expectedReleaseId?: string; readonly expectedContainerIdentitySha256?: string },
  identity: ContainerIdentity,
): void;
