import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
import type { RepositoryObjectDescriptor } from "../src/online-judge/repository-contract";
import { sha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";
import { ensureJudgeCacheObject } from "./catalog-workflows";

const bytes = new TextEncoder().encode("WOJJDG02 fixture");

function object(descriptor: RepositoryObjectDescriptor, digest = descriptor.sha256) {
  return {
    size: descriptor.bytes,
    checksums: { toJSON: () => ({ sha256: digest }) },
  } as unknown as R2Object;
}

async function descriptor(): Promise<RepositoryObjectDescriptor> {
  return { path: "collection/problems/001-test.wasmojjudge", bytes: bytes.byteLength, sha256: await sha256Hex(bytes) };
}

describe("catalog judge cache repair", () => {
  it("keeps an existing object identified by key, size, and built-in checksum", async () => {
    const value = await descriptor();
    const head = vi.fn(async () => object(value));
    const put = vi.fn();
    await ensureJudgeCacheObject({ JUDGE_BUCKET: { head, put } } as unknown as WasmOjWorkerEnv, value, bytes);
    expect(head).toHaveBeenCalledWith(`judge-packages/v2/${value.sha256}`);
    expect(put).not.toHaveBeenCalled();
  });

  it("conditionally repairs a missing object without duplicate checksum metadata", async () => {
    const value = await descriptor();
    const head = vi.fn(async () => null);
    const put = vi.fn(async () => object(value));
    await ensureJudgeCacheObject({ JUDGE_BUCKET: { head, put } } as unknown as WasmOjWorkerEnv, value, bytes);
    expect(put).toHaveBeenCalledWith(`judge-packages/v2/${value.sha256}`, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: expect.any(Uint8Array),
      httpMetadata: { contentType: "application/octet-stream" },
    });
  });

  it("fails closed when an existing object disagrees with the descriptor", async () => {
    const value = await descriptor();
    const head = vi.fn(async () => object(value, "b".repeat(64)));
    await expect(ensureJudgeCacheObject(
      { JUDGE_BUCKET: { head } } as unknown as WasmOjWorkerEnv,
      value,
      bytes,
    )).rejects.toThrow("content identity");
  });
});
