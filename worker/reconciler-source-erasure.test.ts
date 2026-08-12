import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import { reconcileSourceTombstones } from "./reconciler";
import { submissionSourceKey } from "./submissions";

type Binding = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement {
  private bindings: readonly Binding[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: Binding[]): SqliteStatement {
    this.bindings = values;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null;
  }
  async run(): Promise<D1Result> {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
  }
}

class MemoryBucket {
  private readonly objects = new Map<string, { readonly size: number; readonly customMetadata: Record<string, string> }>();
  constructor(private readonly failHeadKey: string) {}
  async put(key: string, value: Uint8Array, options?: R2PutOptions): Promise<R2Object> {
    const object = { size: value.byteLength, customMetadata: options?.customMetadata ?? {} };
    this.objects.set(key, object);
    return object as unknown as R2Object;
  }
  async head(key: string): Promise<R2Object | null> {
    if (key === this.failHeadKey) return null;
    return (this.objects.get(key) as unknown as R2Object | undefined) ?? null;
  }
}

describe("source-row tombstone queue", () => {
  it("backs off a failed source without blocking the next eligible source", async () => {
    const failedId = "00000000-0000-4000-8000-000000000001";
    const succeedingId = "00000000-0000-4000-8000-000000000002";
    const now = new Date("2026-08-12T00:00:00.000Z");
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE submission_sources (
      id TEXT PRIMARY KEY, owner_user_id TEXT, content_sha256 TEXT, bytes INTEGER,
      state TEXT NOT NULL, erased_at TEXT, erasure_requested_at TEXT NOT NULL,
      erasure_attempts INTEGER NOT NULL, erasure_next_attempt_at TEXT,
      erasure_last_error TEXT
    ) STRICT;`);
    const insert = database.prepare(`INSERT INTO submission_sources
      VALUES (?, 'user', NULL, NULL, 'erasing', NULL, ?, 0, ?, NULL)`);
    insert.run(failedId, "2026-08-11T23:58:00.000Z", now.toISOString());
    insert.run(succeedingId, "2026-08-11T23:59:00.000Z", now.toISOString());
    const bucket = new MemoryBucket(submissionSourceKey(failedId));
    const env = {
      DB: { prepare: (sql: string) => new SqliteStatement(database, sql) } as unknown as D1Database,
      JUDGE_BUCKET: bucket as unknown as R2Bucket,
    } as WasmOjWorkerEnv;

    await expect(reconcileSourceTombstones(env, now)).resolves.toBe(1);
    expect(database.prepare(`SELECT state, erasure_attempts, erasure_next_attempt_at, erasure_last_error
      FROM submission_sources WHERE id=?`).get(failedId)).toEqual({
      state: "erasing",
      erasure_attempts: 1,
      erasure_next_attempt_at: "2026-08-12T00:01:00.000Z",
      erasure_last_error: "Submission source tombstone did not cross the R2 persistence barrier.",
    });
    expect(database.prepare(`SELECT state, owner_user_id, erasure_attempts,
      erasure_next_attempt_at, erasure_last_error FROM submission_sources WHERE id=?`).get(succeedingId)).toEqual({
      state: "erased",
      owner_user_id: null,
      erasure_attempts: 1,
      erasure_next_attempt_at: null,
      erasure_last_error: null,
    });
  });
});
