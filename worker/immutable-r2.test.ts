import { describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto";
import { putImmutableObject } from "./immutable-r2";

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

describe("immutable R2 writes", () => {
  it("never deletes a preexisting object when verification fails", async () => {
    const bytes = new TextEncoder().encode("published object");
    const digest = await sha256Hex(bytes);
    const key = `snapshots/objects/${digest}`;
    const bucket = new MemoryBucket();
    bucket.objects.set(key, { bytes: bytes.slice(), sha256: digest, failRead: true });
    await expect(putImmutableObject(
      bucket as unknown as R2Bucket,
      key,
      bytes,
      digest,
      { customMetadata: { sha256: digest } },
    )).rejects.toThrow("injected read failure");
    expect(bucket.objects.has(key)).toBe(true);
    expect(bucket.deleted).toEqual([]);
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
    const bucket = new ConcurrentWinnerBucket();
    await expect(putImmutableObject(
      bucket as unknown as R2Bucket,
      key,
      bytes,
      digest,
      { customMetadata: { sha256: digest } },
    )).resolves.toBe("reused");
    expect(bucket.objects.has(key)).toBe(true);
    expect(bucket.deleted).toEqual([]);
  });
});
