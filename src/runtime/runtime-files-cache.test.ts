import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  openOptionalRuntimeFilesCache,
  restoreOrExportRuntimeFiles,
} from "./runtime-files-cache";

describe("browser runtime-files cache", () => {
  it("re-exports and verifies during the same call after a corrupt cache hit", async () => {
    const canonical = runtimeArchive([["/runtime.txt", "verified"]]);
    const corrupt = canonical.slice();
    corrupt[corrupt.byteLength - 1] ^= 1;
    const expectedSha256 = digest(canonical);
    const cacheRequest = new Request("https://forge.test/runtime-files");
    const exportArchive = vi.fn(async () => canonical);
    const reportIssue = vi.fn();
    const cache = fakeCache({
      match: vi.fn(async () => new Response(corrupt)),
      delete: vi.fn(async () => {
        throw new DOMException("quota", "QuotaExceededError");
      }),
    });

    const files = await restoreOrExportRuntimeFiles(
      cache,
      { cacheRequest, cacheKey: "runtime-test", expectedSha256 },
      exportArchive,
      reportIssue,
    );

    expect(new TextDecoder().decode(files["/runtime.txt"])).toBe("verified");
    expect(exportArchive).toHaveBeenCalledOnce();
    expect(cache.delete).toHaveBeenCalledWith(cacheRequest);
    expect(cache.put).toHaveBeenCalledOnce();
    expect(reportIssue.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("invalid runtime-files cache archive"),
      expect.stringContaining("Unable to delete"),
    ]);
  });

  it("returns verified files when optional cache persistence fails", async () => {
    const canonical = runtimeArchive([["/runtime.txt", "verified"]]);
    const cacheRequest = new Request("https://forge.test/runtime-files");
    const reportIssue = vi.fn();
    const cache = fakeCache({
      put: vi.fn(async () => {
        throw new DOMException("quota", "QuotaExceededError");
      }),
    });

    const files = await restoreOrExportRuntimeFiles(
      cache,
      { cacheRequest, cacheKey: "runtime-test", expectedSha256: digest(canonical) },
      async () => canonical,
      reportIssue,
    );

    expect(new TextDecoder().decode(files["/runtime.txt"])).toBe("verified");
    expect(cache.put).toHaveBeenCalledOnce();
    expect(reportIssue).toHaveBeenCalledOnce();
    expect(reportIssue).toHaveBeenCalledWith(
      expect.stringContaining("continuing without cache persistence"),
      expect.any(DOMException),
    );
  });

  it("does not use or cache a freshly exported archive with the wrong digest", async () => {
    const canonical = runtimeArchive([["/runtime.txt", "verified"]]);
    const corrupt = canonical.slice();
    corrupt[corrupt.byteLength - 1] ^= 1;
    const cache = fakeCache();

    await expect(restoreOrExportRuntimeFiles(
      cache,
      {
        cacheRequest: new Request("https://forge.test/runtime-files"),
        cacheKey: "runtime-test",
        expectedSha256: digest(canonical),
      },
      async () => corrupt,
    )).rejects.toThrow(`expected ${digest(canonical)}`);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("continues without caching when CacheStorage cannot be opened", async () => {
    const reportIssue = vi.fn();
    const storage = {
      open: vi.fn(async () => {
        throw new DOMException("disabled", "SecurityError");
      }),
    } as unknown as CacheStorage;

    await expect(openOptionalRuntimeFilesCache(storage, "runtime-files", reportIssue)).resolves.toBeUndefined();
    expect(reportIssue).toHaveBeenCalledOnce();
  });
});

function fakeCache(overrides: Partial<Cache> = {}): Cache {
  return {
    match: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => true),
    ...overrides,
  } as unknown as Cache;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runtimeArchive(entries: Array<[string, string]>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [encoder.encode("FORGEFS1")];
  for (const [filePath, value] of entries) {
    const encodedPath = encoder.encode(filePath);
    const data = encoder.encode(value);
    const header = new Uint8Array(12);
    const view = new DataView(header.buffer);
    view.setUint32(0, encodedPath.byteLength, true);
    view.setBigUint64(4, BigInt(data.byteLength), true);
    chunks.push(header, encodedPath, data);
  }
  chunks.push(new Uint8Array(12));
  const archive = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}
