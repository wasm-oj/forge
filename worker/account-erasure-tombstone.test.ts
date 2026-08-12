import { describe, expect, it } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import { submissionSourceKey, tombstoneSubmissionSource } from "./submissions";

const SOURCE_ID = "0198dbd3-5c00-7000-8000-000000000503";

class MemoryBucket {
  object: { bytes: Uint8Array; metadata: Record<string, string> } | null = {
    bytes: new TextEncoder().encode("private contestant source"),
    metadata: { kind: "submission-source", sourceId: SOURCE_ID },
  };
  failHead = false;

  async put(
    _key: string,
    value: Uint8Array,
    options: { readonly onlyIf?: { readonly etagDoesNotMatch?: string }; readonly customMetadata?: Record<string, string> },
  ): Promise<object | null> {
    if (options.onlyIf?.etagDoesNotMatch === "*" && this.object !== null) return null;
    this.object = { bytes: value.slice(), metadata: { ...options.customMetadata } };
    return {};
  }

  async head(): Promise<{ readonly size: number; readonly customMetadata: Record<string, string> } | null> {
    if (this.failHead || !this.object) return null;
    return { size: this.object.bytes.byteLength, customMetadata: this.object.metadata };
  }
}

class Statement {
  constructor(private readonly runStatement: () => void) {}
  bind(): Statement {
    return this;
  }
  async run(): Promise<{ readonly meta: { readonly changes: number } }> {
    this.runStatement();
    return { meta: { changes: 1 } };
  }
}

function environment(bucket: MemoryBucket) {
  const writes: string[] = [];
  const database = {
    prepare(sql: string) {
      return new Statement(() => writes.push(sql));
    },
  } as unknown as D1Database;
  return {
    env: { DB: database, JUDGE_BUCKET: bucket as unknown as R2Bucket } as unknown as WasmOjWorkerEnv,
    writes,
  };
}

describe("same-key account-erasure tombstone", () => {
  it("overwrites existing private bytes and makes every late conditional create fail", async () => {
    const bucket = new MemoryBucket();
    const { env, writes } = environment(bucket);
    await tombstoneSubmissionSource(env, SOURCE_ID);

    expect(submissionSourceKey(SOURCE_ID)).toBe(`submission-sources/v2/${SOURCE_ID}`);
    expect(new TextDecoder().decode(bucket.object?.bytes)).toBe('{"schema":"wasm-oj-platform/erased-submission-source/v1"}\n');
    expect(bucket.object?.metadata.kind).toBe("erased");
    expect(writes.some((sql) => sql.includes("SET state='erased'"))).toBe(true);

    const late = await bucket.put(
      submissionSourceKey(SOURCE_ID),
      new TextEncoder().encode("late private source"),
      { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { kind: "submission-source" } },
    );
    expect(late).toBeNull();
    expect(bucket.object?.metadata.kind).toBe("erased");
  });

  it("does not mark D1 erased until HEAD observes the permanent tombstone", async () => {
    const bucket = new MemoryBucket();
    bucket.failHead = true;
    const { env, writes } = environment(bucket);
    await expect(tombstoneSubmissionSource(env, SOURCE_ID)).rejects.toThrow("persistence barrier");
    expect(writes).toEqual([]);
  });
});
