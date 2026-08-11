import { describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto";
import { putImmutableMirroredObject } from "./immutable-r2";

interface Stored {
  bytes: Uint8Array;
  sha256: string;
  failRead?: boolean;
}

class MemoryBucket {
  readonly objects = new Map<string, Stored>();
  readonly deleted: string[] = [];

  async get(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      size: stored.bytes.byteLength,
      customMetadata: { sha256: stored.sha256 },
      async arrayBuffer() {
        if (stored.failRead) throw new Error("injected read failure");
        return stored.bytes.slice().buffer;
      },
    };
  }

  async put(key: string, value: Uint8Array, options: R2PutOptions) {
    if (options.onlyIf && this.objects.has(key)) return null;
    this.objects.set(key, { bytes: value.slice(), sha256: String(options.customMetadata?.sha256) });
    return {};
  }

  async delete(key: string) {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

describe("immutable mirrored R2 writes", () => {
  it("never deletes preexisting primary or mirror objects when verification fails", async () => {
    const bytes = new TextEncoder().encode("published object");
    const digest = await sha256Hex(bytes);
    const key = `snapshots/objects/${digest}`;
    const primary = new MemoryBucket();
    const mirror = new MemoryBucket();
    primary.objects.set(key, { bytes: bytes.slice(), sha256: digest });
    mirror.objects.set(key, { bytes: bytes.slice(), sha256: digest, failRead: true });
    await expect(putImmutableMirroredObject(
      primary as unknown as R2Bucket,
      mirror as unknown as R2Bucket,
      key,
      bytes,
      digest,
      { customMetadata: { sha256: digest } },
    )).rejects.toThrow("injected read failure");
    expect(primary.objects.has(key)).toBe(true);
    expect(mirror.objects.has(key)).toBe(true);
    expect(primary.deleted).toEqual([]);
    expect(mirror.deleted).toEqual([]);
  });

  it("leaves a newly created side for claim-aware GC when its mirror fails", async () => {
    const bytes = new TextEncoder().encode("candidate object");
    const digest = await sha256Hex(bytes);
    const key = `snapshots/objects/${digest}`;
    const primary = new MemoryBucket();
    const mirror = new MemoryBucket();
    mirror.objects.set(key, { bytes: bytes.slice(), sha256: "0".repeat(64) });
    await expect(putImmutableMirroredObject(
      primary as unknown as R2Bucket,
      mirror as unknown as R2Bucket,
      key,
      bytes,
      digest,
      { customMetadata: { sha256: digest } },
    )).rejects.toThrow("inconsistent metadata");
    expect(primary.objects.has(key)).toBe(true);
    expect(mirror.objects.has(key)).toBe(true);
    expect(primary.deleted).toEqual([]);
    expect(mirror.deleted).toEqual([]);
  });

  it("reuses a concurrent conditional-create winner without ever deleting it", async () => {
    const bytes = new TextEncoder().encode("concurrent immutable object");
    const digest = await sha256Hex(bytes);
    const key = `snapshots/objects/${digest}`;
    class ConcurrentWinnerBucket extends MemoryBucket {
      first = true;
      override async get(requestedKey: string) {
        if (this.first) {
          this.first = false;
          this.objects.set(requestedKey, { bytes: bytes.slice(), sha256: digest });
          return null;
        }
        return super.get(requestedKey);
      }
    }
    const primary = new ConcurrentWinnerBucket();
    const mirror = new MemoryBucket();
    mirror.objects.set(key, { bytes: bytes.slice(), sha256: digest });
    await expect(putImmutableMirroredObject(
      primary as unknown as R2Bucket,
      mirror as unknown as R2Bucket,
      key,
      bytes,
      digest,
      { customMetadata: { sha256: digest } },
    )).resolves.toEqual({ primary: "reused", mirror: "reused" });
    expect(primary.objects.has(key)).toBe(true);
    expect(primary.deleted).toEqual([]);
  });
});
