import { describe, expect, it, vi } from "vitest";
import {
  assertContainerIdentityFence,
  establishContainerIdentityFence,
  parseProbedContainerIdentity,
  type ContainerIdentityJobBinding,
  type ContainerIdentityWorkerBinding,
} from "./container-identity-fence";

const buildId = "a".repeat(40);
const job: ContainerIdentityJobBinding = {
  jobId: "22222222-2222-4222-8222-222222222222",
  attempt: 1,
  attemptTokenHash: "7".repeat(64),
  expectedBuildId: buildId,
  expectedWorkerVersionId: "worker-version-123",
};
const worker: ContainerIdentityWorkerBinding = {
  environment: "production",
  buildId,
  workerVersionId: "worker-version-123",
};
const identity = { schema: "wasm-oj-platform/container-identity/v3", contract: 2, protocol: "wasm-oj-container-v2", buildId };

describe("Worker-side Container build fence", () => {
  it("commits the build fence before forwarding attempt credentials", async () => {
    const order: string[] = [];
    let committed: unknown;
    await expect(establishContainerIdentityFence({
      probe: async () => { order.push("probe"); return identity; },
      job,
      worker,
      commit: async (fence) => { order.push("commit"); committed = fence; },
      forward: async () => { order.push("forward"); return "ok"; },
    })).resolves.toBe("ok");
    expect(order).toEqual(["probe", "commit", "forward"]);
    expect(() => assertContainerIdentityFence(committed, job, job.attemptTokenHash, worker)).not.toThrow();
  });

  it("rejects Worker or Container build mismatch before forwarding", async () => {
    const commit = vi.fn(); const forward = vi.fn();
    await expect(establishContainerIdentityFence({
      probe: async () => ({ ...identity, buildId: "b".repeat(40) }), job, worker, commit, forward,
    })).rejects.toThrow("immutable job binding");
    expect(commit).not.toHaveBeenCalled(); expect(forward).not.toHaveBeenCalled();
  });

  it("requires the exact four-field identity shape", () => {
    expect(parseProbedContainerIdentity(identity)).toEqual(identity);
    expect(() => parseProbedContainerIdentity({ ...identity, checksum: "x" })).toThrow("invalid shape");
    expect(() => parseProbedContainerIdentity({ ...identity, protocol: "v1" })).toThrow("build coordinates");
  });
});
