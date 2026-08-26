import { readBoundedResponseJson } from "./http";

const SHA256 = /^[0-9a-f]{64}$/;
const BUILD_ID = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;
const MAX_CONTAINER_IDENTITY_BYTES = 4 * 1024;
const CONTAINER_IDENTITY_SCHEMA = "wasm-oj-platform/container-identity/v3" as const;
const CONTAINER_IDENTITY_FENCE_SCHEMA = "wasm-oj-platform/container-identity-fence/v3" as const;
export const CONTAINER_PROTOCOL = "wasm-oj-container-v2" as const;
const CONTRACT_VERSION = 2 as const;

const IDENTITY_KEYS = ["buildId", "contract", "protocol", "schema"] as const;
const FENCE_KEYS = [
  "attempt", "attemptTokenHash", "buildId", "environment", "jobId",
  "protocol", "schema", "workerVersionId",
] as const;

export interface ProbedContainerIdentity {
  readonly schema: typeof CONTAINER_IDENTITY_SCHEMA;
  readonly contract: typeof CONTRACT_VERSION;
  readonly protocol: typeof CONTAINER_PROTOCOL;
  readonly buildId: string;
}

export interface ContainerIdentityWorkerBinding {
  readonly environment: "development" | "staging" | "production";
  readonly buildId: string;
  readonly workerVersionId: string;
}

export interface ContainerIdentityJobBinding {
  readonly jobId: string;
  readonly attempt: number;
  readonly attemptTokenHash: string;
  readonly expectedBuildId: string;
  readonly expectedWorkerVersionId: string;
}

export interface ContainerIdentityFence {
  readonly schema: typeof CONTAINER_IDENTITY_FENCE_SCHEMA;
  readonly environment: ContainerIdentityWorkerBinding["environment"];
  readonly jobId: string;
  readonly attempt: number;
  readonly attemptTokenHash: string;
  readonly buildId: string;
  readonly workerVersionId: string;
  readonly protocol: typeof CONTAINER_PROTOCOL;
}

export type FencedContainerAuthorization = ContainerIdentityJobBinding;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${label} has an invalid shape.`);
}

function validWorker(worker: ContainerIdentityWorkerBinding): boolean {
  return ["development", "staging", "production"].includes(worker.environment)
    && BUILD_ID.test(worker.buildId)
    && VERSION_ID.test(worker.workerVersionId);
}

function validJob(job: ContainerIdentityJobBinding): boolean {
  return UUID.test(job.jobId)
    && Number.isSafeInteger(job.attempt) && job.attempt >= 1
    && SHA256.test(job.attemptTokenHash)
    && BUILD_ID.test(job.expectedBuildId)
    && VERSION_ID.test(job.expectedWorkerVersionId);
}

export function parseProbedContainerIdentity(value: unknown): ProbedContainerIdentity {
  const identity = record(value, "Container identity probe");
  exact(identity, IDENTITY_KEYS, "Container identity probe");
  if (
    identity.schema !== CONTAINER_IDENTITY_SCHEMA
    || identity.contract !== CONTRACT_VERSION
    || identity.protocol !== CONTAINER_PROTOCOL
    || typeof identity.buildId !== "string"
    || !BUILD_ID.test(identity.buildId)
  ) throw new TypeError("Container identity probe has invalid build coordinates.");
  return {
    schema: CONTAINER_IDENTITY_SCHEMA,
    contract: CONTRACT_VERSION,
    protocol: CONTAINER_PROTOCOL,
    buildId: identity.buildId,
  };
}

export async function readBoundedProbedContainerIdentity(response: Response): Promise<ProbedContainerIdentity> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new TypeError("Container identity probe failed.");
  }
  try { return parseProbedContainerIdentity(await readBoundedResponseJson(response, MAX_CONTAINER_IDENTITY_BYTES)); }
  catch { throw new TypeError("Container identity probe is invalid or oversized."); }
}

export function createContainerIdentityFence(
  identityValue: unknown,
  job: ContainerIdentityJobBinding,
  worker: ContainerIdentityWorkerBinding,
): ContainerIdentityFence {
  const identity = parseProbedContainerIdentity(identityValue);
  if (!validJob(job) || !validWorker(worker)) throw new TypeError("Container identity fence coordinates are invalid.");
  if (
    job.expectedBuildId !== worker.buildId
    || job.expectedWorkerVersionId !== worker.workerVersionId
    || identity.buildId !== worker.buildId
  ) throw new TypeError("Container identity does not match the executing Worker build.");
  return Object.freeze({
    schema: CONTAINER_IDENTITY_FENCE_SCHEMA,
    environment: worker.environment,
    jobId: job.jobId,
    attempt: job.attempt,
    attemptTokenHash: job.attemptTokenHash,
    buildId: worker.buildId,
    workerVersionId: worker.workerVersionId,
    protocol: identity.protocol,
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
    !validJob(authorization) || !validWorker(worker) || !SHA256.test(requestTokenHash)
    || fence.schema !== CONTAINER_IDENTITY_FENCE_SCHEMA
    || fence.protocol !== CONTAINER_PROTOCOL
    || fence.environment !== worker.environment
    || fence.jobId !== authorization.jobId
    || fence.attempt !== authorization.attempt
    || fence.attemptTokenHash !== authorization.attemptTokenHash
    || fence.attemptTokenHash !== requestTokenHash
    || fence.buildId !== authorization.expectedBuildId
    || fence.buildId !== worker.buildId
    || fence.workerVersionId !== authorization.expectedWorkerVersionId
    || fence.workerVersionId !== worker.workerVersionId
  ) throw new TypeError("Container callback is not covered by the exact Worker-side identity fence.");
}

/** Probe and commit the build fence before forwarding job bytes or attempt credentials. */
export async function establishContainerIdentityFence<T>(input: {
  readonly probe: () => Promise<unknown>;
  readonly job: ContainerIdentityJobBinding;
  readonly worker: ContainerIdentityWorkerBinding;
  readonly commit: (fence: ContainerIdentityFence) => Promise<void>;
  readonly forward: () => Promise<T>;
}): Promise<T> {
  if (!validJob(input.job) || !validWorker(input.worker)
    || input.job.expectedBuildId !== input.worker.buildId
    || input.job.expectedWorkerVersionId !== input.worker.workerVersionId) {
    throw new TypeError("Worker build identity does not match the immutable job binding.");
  }
  const identity = parseProbedContainerIdentity(await input.probe());
  if (identity.buildId !== input.job.expectedBuildId) throw new TypeError("Container identity probe does not match the immutable job binding.");
  const fence = createContainerIdentityFence(identity, input.job, input.worker);
  await input.commit(fence);
  return input.forward();
}
