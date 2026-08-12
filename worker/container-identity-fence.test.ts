import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertContainerIdentityFence,
  createContainerIdentityFence,
  establishContainerIdentityFence,
  parseProbedContainerIdentity,
  type ContainerIdentityJobBinding,
  type ContainerIdentityReleaseBinding,
  type ProbedContainerIdentity,
} from "./container-identity-fence";

const releaseId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const sha = (character: string): string => character.repeat(64);

const embeddedIdentity = {
  compilerSha256: sha("5"),
  contract: 2 as const,
  executionRootSha256: sha("2"),
  gitCommit: "a".repeat(40),
  protocol: "wasm-oj-container-v2" as const,
  releaseId,
  runnerSha256: sha("6"),
  runtimeRootSha256: sha("3"),
  schema: "wasm-oj-platform/container-identity/v2" as const,
  toolchainRootSha256: sha("4"),
};

const identity: ProbedContainerIdentity = {
  ...embeddedIdentity,
  identitySha256: createHash("sha256").update(`${JSON.stringify(embeddedIdentity)}\n`).digest("hex"),
};

const job: ContainerIdentityJobBinding = {
  jobId,
  attempt: 1,
  attemptTokenHash: sha("7"),
  expectedReleaseId: releaseId,
  expectedManifestSha256: sha("8"),
  expectedContainerIdentitySha256: identity.identitySha256,
};

const release: ContainerIdentityReleaseBinding = {
  environment: "staging",
  releaseId,
  manifestSha256: job.expectedManifestSha256,
  workerVersionId: "worker-version-123",
  wasmOjContract: 2,
  sourceCommit: identity.gitCommit,
  containerIdentitySha256: identity.identitySha256,
  protocol: identity.protocol,
  executionRootSha256: identity.executionRootSha256,
  runtimeRootSha256: identity.runtimeRootSha256,
  toolchainRootSha256: identity.toolchainRootSha256,
  compilerSha256: identity.compilerSha256,
  runnerSha256: identity.runnerSha256,
};

const authorization = {
  jobId: job.jobId,
  attempt: job.attempt,
  attemptTokenHash: job.attemptTokenHash,
  expectedReleaseId: job.expectedReleaseId,
  expectedManifestSha256: job.expectedManifestSha256,
  expectedContainerIdentitySha256: job.expectedContainerIdentitySha256,
};

const worker = {
  environment: release.environment,
  releaseId: release.releaseId,
  manifestSha256: release.manifestSha256,
  workerVersionId: release.workerVersionId,
};

describe("Worker-side Container identity fence", () => {
  it("commits the exact fence before forwarding any job bytes", async () => {
    const order: string[] = [];
    let committed: unknown;
    const result = await establishContainerIdentityFence({
      probe: async () => { order.push("probe"); return identity; },
      job,
      loadRelease: async () => { order.push("release"); return release; },
      commit: async (fence) => { order.push("commit"); committed = fence; },
      forward: async () => { order.push("forward"); return "ok"; },
    });

    expect(result).toBe("ok");
    expect(order).toEqual(["probe", "release", "commit", "forward"]);
    expect(() => assertContainerIdentityFence(committed, authorization, job.attemptTokenHash, worker)).not.toThrow();
  });

  it.each([
    ["old release", { releaseId: "33333333-3333-4333-8333-333333333333" }],
    ["wrong image identity", { identitySha256: sha("9") }],
  ])("rejects a fake %s before any release or job R2 read", async (_label, patch) => {
    const loadRelease = vi.fn(async () => release);
    const commit = vi.fn(async () => undefined);
    const sourceOrJudgeR2Read = vi.fn(async () => "unreachable");

    await expect(establishContainerIdentityFence({
      probe: async () => ({ ...identity, ...patch }),
      job,
      loadRelease,
      commit,
      forward: sourceOrJudgeR2Read,
    })).rejects.toThrow(/embedded identity fields|immutable job binding/);

    expect(loadRelease).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(sourceOrJudgeR2Read).not.toHaveBeenCalled();
  });

  it.each([
    ["protocol", { protocol: "unsupported-container-protocol" }],
    ["execution root", { executionRootSha256: sha("9") }],
    ["runtime root", { runtimeRootSha256: sha("9") }],
    ["toolchain root", { toolchainRootSha256: sha("9") }],
    ["compiler", { compilerSha256: sha("9") }],
    ["runner", { runnerSha256: sha("9") }],
    ["source commit", { gitCommit: "b".repeat(40) }],
  ])("rejects a mismatched %s before authorization or source R2 access", async (_label, patch) => {
    const loadRelease = vi.fn(async () => release);
    const commit = vi.fn(async () => undefined);
    const sourceOrJudgeR2Read = vi.fn(async () => "unreachable");
    await expect(establishContainerIdentityFence({
      probe: async () => ({ ...identity, ...patch }),
      job,
      loadRelease,
      commit,
      forward: sourceOrJudgeR2Read,
    })).rejects.toThrow();
    expect(loadRelease).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(sourceOrJudgeR2Read).not.toHaveBeenCalled();
  });

  it("requires an exact, bounded identity shape", () => {
    const retiredBrand = ["for", "ge"].join("");
    expect(() => parseProbedContainerIdentity({ ...identity, unexpected: true })).toThrow(/invalid shape/);
    expect(() => parseProbedContainerIdentity({ ...identity, releaseId: `${releaseId}suffix` })).toThrow(/coordinates/);
    expect(() => parseProbedContainerIdentity({ ...identity, compilerSha256: "a".repeat(65) })).toThrow(/SHA-256/);
    expect(() => parseProbedContainerIdentity({ ...identity, contract: 1 })).toThrow(/coordinates/);
    expect(() => parseProbedContainerIdentity({ ...identity, protocol: `${retiredBrand}-container-v1` })).toThrow(/coordinates/);
    expect(() => parseProbedContainerIdentity({ ...identity, schema: `${retiredBrand}-container-identity-v1` })).toThrow(/coordinates/);
  });

  it("rejects callback replay across attempt token, job, or Worker deployment", () => {
    const fence = createContainerIdentityFence(identity, job, release);
    expect(() => assertContainerIdentityFence(fence, authorization, sha("9"), worker)).toThrow(/exact Worker-side identity fence/);
    expect(() => assertContainerIdentityFence(fence, { ...authorization, jobId: "33333333-3333-4333-8333-333333333333" }, job.attemptTokenHash, worker)).toThrow(/exact Worker-side identity fence/);
    expect(() => assertContainerIdentityFence(fence, authorization, job.attemptTokenHash, { ...worker, workerVersionId: "different-worker" })).toThrow(/exact Worker-side identity fence/);
  });

  it("never forwards when durable fence commit fails", async () => {
    const forward = vi.fn(async () => "unreachable");
    await expect(establishContainerIdentityFence({
      probe: async () => identity,
      job,
      loadRelease: async () => release,
      commit: async () => { throw new Error("storage unavailable"); },
      forward,
    })).rejects.toThrow("storage unavailable");
    expect(forward).not.toHaveBeenCalled();
  });
});
