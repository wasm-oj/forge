import { sha256Hex } from "./crypto";
import { readBoundedResponseJson } from "./http";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;
const MAX_CONTAINER_IDENTITY_BYTES = 16 * 1024;

const IDENTITY_KEYS = [
  "compilerSha256",
  "contract",
  "executionRootSha256",
  "gitCommit",
  "identitySha256",
  "protocol",
  "releaseId",
  "runnerSha256",
  "runtimeRootSha256",
  "schema",
  "toolchainRootSha256",
] as const;

const EMBEDDED_IDENTITY_KEYS = [
  "compilerSha256",
  "contract",
  "executionRootSha256",
  "gitCommit",
  "protocol",
  "releaseId",
  "runnerSha256",
  "runtimeRootSha256",
  "schema",
  "toolchainRootSha256",
] as const;

const FENCE_KEYS = [
  "attempt",
  "attemptTokenHash",
  "compilerSha256",
  "environment",
  "executionRootSha256",
  "identitySha256",
  "jobId",
  "manifestSha256",
  "protocol",
  "releaseId",
  "runnerSha256",
  "runtimeRootSha256",
  "schema",
  "toolchainRootSha256",
  "workerVersionId",
] as const;

export interface ProbedContainerIdentity {
  readonly schema: "forge-container-identity-v1";
  readonly contract: 1;
  readonly protocol: "forge-container-v1";
  readonly releaseId: string;
  readonly gitCommit: string;
  readonly identitySha256: string;
  readonly executionRootSha256: string;
  readonly runtimeRootSha256: string;
  readonly toolchainRootSha256: string;
  readonly compilerSha256: string;
  readonly runnerSha256: string;
}

export interface ContainerIdentityReleaseBinding {
  readonly environment: "development" | "staging" | "production";
  readonly releaseId: string;
  readonly manifestSha256: string;
  readonly workerVersionId: string;
  readonly forgeContract: 1;
  readonly sourceCommit: string;
  readonly containerIdentitySha256: string;
  readonly protocol: "forge-container-v1";
  readonly executionRootSha256: string;
  readonly runtimeRootSha256: string;
  readonly toolchainRootSha256: string;
  readonly compilerSha256: string;
  readonly runnerSha256: string;
}

export interface ContainerIdentityJobBinding {
  readonly jobId: string;
  readonly attempt: number;
  readonly attemptTokenHash: string;
  readonly expectedReleaseId: string;
  readonly expectedManifestSha256: string;
  readonly expectedContainerIdentitySha256: string;
}

export interface ContainerIdentityFence {
  readonly schema: "forge-container-identity-fence-v1";
  readonly environment: ContainerIdentityReleaseBinding["environment"];
  readonly jobId: string;
  readonly attempt: number;
  readonly attemptTokenHash: string;
  readonly releaseId: string;
  readonly manifestSha256: string;
  readonly workerVersionId: string;
  readonly identitySha256: string;
  readonly protocol: "forge-container-v1";
  readonly executionRootSha256: string;
  readonly runtimeRootSha256: string;
  readonly toolchainRootSha256: string;
  readonly compilerSha256: string;
  readonly runnerSha256: string;
}

export interface FencedContainerAuthorization {
  readonly jobId: string;
  readonly attempt: number;
  readonly attemptTokenHash: string;
  readonly expectedReleaseId: string;
  readonly expectedManifestSha256: string;
  readonly expectedContainerIdentitySha256: string;
}

export type ContainerIdentityWorkerBinding = Pick<
  ContainerIdentityReleaseBinding,
  "environment" | "releaseId" | "manifestSha256" | "workerVersionId"
>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

export function parseProbedContainerIdentity(value: unknown): ProbedContainerIdentity {
  const identity = record(value, "Container identity probe");
  exact(identity, IDENTITY_KEYS, "Container identity probe");
  if (
    identity.schema !== "forge-container-identity-v1"
    || identity.contract !== 1
    || identity.protocol !== "forge-container-v1"
    || typeof identity.releaseId !== "string"
    || !UUID.test(identity.releaseId)
    || typeof identity.gitCommit !== "string"
    || !COMMIT.test(identity.gitCommit)
  ) throw new TypeError("Container identity probe has invalid release coordinates.");
  return {
    schema: "forge-container-identity-v1",
    contract: 1,
    protocol: "forge-container-v1",
    releaseId: identity.releaseId,
    gitCommit: identity.gitCommit,
    identitySha256: digest(identity.identitySha256, "Container identity"),
    executionRootSha256: digest(identity.executionRootSha256, "Container execution root"),
    runtimeRootSha256: digest(identity.runtimeRootSha256, "Container runtime root"),
    toolchainRootSha256: digest(identity.toolchainRootSha256, "Container toolchain root"),
    compilerSha256: digest(identity.compilerSha256, "Container compiler"),
    runnerSha256: digest(identity.runnerSha256, "Container runner"),
  };
}

export async function readBoundedProbedContainerIdentity(response: Response): Promise<ProbedContainerIdentity> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new TypeError("Container identity probe failed.");
  }
  try {
    return parseProbedContainerIdentity(await readBoundedResponseJson(response, MAX_CONTAINER_IDENTITY_BYTES));
  } catch {
    throw new TypeError("Container identity probe is invalid or oversized.");
  }
}

function embeddedContainerIdentityBytes(identity: ProbedContainerIdentity): Uint8Array {
  const embedded = Object.fromEntries(EMBEDDED_IDENTITY_KEYS.map((key) => [key, identity[key]]));
  return new TextEncoder().encode(`${JSON.stringify(embedded)}\n`);
}

export async function assertSelfAuthenticatedContainerIdentity(identity: ProbedContainerIdentity): Promise<void> {
  if (await sha256Hex(embeddedContainerIdentityBytes(identity)) !== identity.identitySha256) {
    throw new TypeError("Container identity probe does not authenticate its embedded identity fields.");
  }
}

export function assertProbedContainerIdentityMatchesRelease(
  identity: ProbedContainerIdentity,
  release: ContainerIdentityReleaseBinding,
): void {
  if (
    !UUID.test(release.releaseId)
    || !SHA256.test(release.manifestSha256)
    || !VERSION_ID.test(release.workerVersionId)
    || !["development", "staging", "production"].includes(release.environment)
    || release.forgeContract !== 1
    || !COMMIT.test(release.sourceCommit)
    || release.protocol !== "forge-container-v1"
    || !SHA256.test(release.containerIdentitySha256)
    || !SHA256.test(release.executionRootSha256)
    || !SHA256.test(release.runtimeRootSha256)
    || !SHA256.test(release.toolchainRootSha256)
    || !SHA256.test(release.compilerSha256)
    || !SHA256.test(release.runnerSha256)
  ) throw new TypeError("Container release identity binding is invalid.");
  if (
    identity.releaseId !== release.releaseId
    || identity.identitySha256 !== release.containerIdentitySha256
    || identity.contract !== release.forgeContract
    || identity.gitCommit !== release.sourceCommit
    || identity.protocol !== release.protocol
    || identity.executionRootSha256 !== release.executionRootSha256
    || identity.runtimeRootSha256 !== release.runtimeRootSha256
    || identity.toolchainRootSha256 !== release.toolchainRootSha256
    || identity.compilerSha256 !== release.compilerSha256
    || identity.runnerSha256 !== release.runnerSha256
  ) throw new TypeError("Container identity does not match the immutable Worker release binding.");
}

export function createContainerIdentityFence(
  identityValue: unknown,
  job: ContainerIdentityJobBinding,
  release: ContainerIdentityReleaseBinding,
): ContainerIdentityFence {
  const identity = parseProbedContainerIdentity(identityValue);
  if (
    !UUID.test(job.jobId)
    || !Number.isSafeInteger(job.attempt)
    || job.attempt < 1
    || !SHA256.test(job.attemptTokenHash)
    || !UUID.test(job.expectedReleaseId)
    || !SHA256.test(job.expectedManifestSha256)
    || !SHA256.test(job.expectedContainerIdentitySha256)
    || !UUID.test(release.releaseId)
    || !SHA256.test(release.manifestSha256)
    || !VERSION_ID.test(release.workerVersionId)
    || !["development", "staging", "production"].includes(release.environment)
  ) throw new TypeError("Container identity fence coordinates are invalid.");
  if (
    job.expectedReleaseId !== release.releaseId
    || job.expectedManifestSha256 !== release.manifestSha256
    || job.expectedContainerIdentitySha256 !== release.containerIdentitySha256
  ) throw new TypeError("Container job does not match the immutable Worker release binding.");
  assertProbedContainerIdentityMatchesRelease(identity, release);
  return Object.freeze({
    schema: "forge-container-identity-fence-v1",
    environment: release.environment,
    jobId: job.jobId,
    attempt: job.attempt,
    attemptTokenHash: job.attemptTokenHash,
    releaseId: release.releaseId,
    manifestSha256: release.manifestSha256,
    workerVersionId: release.workerVersionId,
    identitySha256: identity.identitySha256,
    protocol: identity.protocol,
    executionRootSha256: identity.executionRootSha256,
    runtimeRootSha256: identity.runtimeRootSha256,
    toolchainRootSha256: identity.toolchainRootSha256,
    compilerSha256: identity.compilerSha256,
    runnerSha256: identity.runnerSha256,
  });
}

export function assertContainerIdentityFence(
  value: unknown,
  authorization: FencedContainerAuthorization,
  requestTokenHash: string,
  worker: ContainerIdentityWorkerBinding,
): asserts value is ContainerIdentityFence {
  const fence = record(value, "Container identity fence");
  exact(fence, FENCE_KEYS, "Container identity fence");
  if (
    fence.schema !== "forge-container-identity-fence-v1"
    || !["development", "staging", "production"].includes(fence.environment as string)
    || fence.protocol !== "forge-container-v1"
    || typeof fence.jobId !== "string"
    || !UUID.test(fence.jobId)
    || !Number.isSafeInteger(fence.attempt)
    || (fence.attempt as number) < 1
    || typeof fence.releaseId !== "string"
    || !UUID.test(fence.releaseId)
    || fence.jobId !== authorization.jobId
    || fence.attempt !== authorization.attempt
    || fence.attemptTokenHash !== authorization.attemptTokenHash
    || fence.attemptTokenHash !== requestTokenHash
    || fence.releaseId !== authorization.expectedReleaseId
    || fence.manifestSha256 !== authorization.expectedManifestSha256
    || fence.identitySha256 !== authorization.expectedContainerIdentitySha256
    || fence.environment !== worker.environment
    || fence.releaseId !== worker.releaseId
    || fence.manifestSha256 !== worker.manifestSha256
    || fence.workerVersionId !== worker.workerVersionId
    || typeof fence.workerVersionId !== "string"
    || !VERSION_ID.test(fence.workerVersionId)
    || !UUID.test(authorization.jobId)
    || !Number.isSafeInteger(authorization.attempt)
    || authorization.attempt < 1
    || !UUID.test(authorization.expectedReleaseId)
  ) throw new TypeError("Container callback is not covered by the exact Worker-side identity fence.");
  for (const [label, digestValue] of Object.entries({
    token: fence.attemptTokenHash,
    manifest: fence.manifestSha256,
    identity: fence.identitySha256,
    executionRoot: fence.executionRootSha256,
    runtimeRoot: fence.runtimeRootSha256,
    toolchainRoot: fence.toolchainRootSha256,
    compiler: fence.compilerSha256,
    runner: fence.runnerSha256,
  })) digest(digestValue, `Container fence ${label}`);
}

/**
 * Establishes the identity fence before the job bytes can reach the Container.
 * This ordering is security-critical: a mismatched old image is never forwarded
 * an attempt token and therefore cannot pass any outbound callback gate.
 */
export async function establishContainerIdentityFence<T>(input: {
  readonly probe: () => Promise<unknown>;
  readonly job: ContainerIdentityJobBinding;
  readonly loadRelease: () => Promise<ContainerIdentityReleaseBinding>;
  readonly commit: (fence: ContainerIdentityFence) => Promise<void>;
  readonly forward: () => Promise<T>;
}): Promise<T> {
  const identity = parseProbedContainerIdentity(await input.probe());
  // The image returns both the embedded release identity and its digest. Hash
  // the exact canonical embedded bytes here instead of trusting that claimed
  // digest. This makes every protocol/root/tool digest mismatch detectable
  // before loading the active release manifest from R2.
  await assertSelfAuthenticatedContainerIdentity(identity);
  if (
    !UUID.test(input.job.jobId)
    || !Number.isSafeInteger(input.job.attempt)
    || input.job.attempt < 1
    || !SHA256.test(input.job.attemptTokenHash)
    || !UUID.test(input.job.expectedReleaseId)
    || !SHA256.test(input.job.expectedManifestSha256)
    || !SHA256.test(input.job.expectedContainerIdentitySha256)
    || identity.releaseId !== input.job.expectedReleaseId
    || identity.identitySha256 !== input.job.expectedContainerIdentitySha256
  ) throw new TypeError("Container identity probe does not match the immutable job binding.");
  // Loading the active release reads its immutable manifest from R2. The exact
  // job/image identity check above therefore must remain before this callback.
  const release = await input.loadRelease();
  const fence = createContainerIdentityFence(identity, input.job, release);
  await input.commit(fence);
  return input.forward();
}
