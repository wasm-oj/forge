import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { ForgeWorkerEnv } from "./env";
import { reconcilePhase, reconcileUncommittedAttemptAudits } from "./reconciler";

type Binding = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement {
  private bindings: readonly Binding[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: Binding[]): SqliteStatement { this.bindings = values; return this; }
  async first<T>(): Promise<T | null> { return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null; }
  async all<T>(): Promise<{ readonly results: readonly T[] }> { return { results: this.database.prepare(this.sql).all(...this.bindings) as T[] }; }
  async run(): Promise<{ readonly meta: { readonly changes: number } }> {
    return { meta: { changes: Number(this.database.prepare(this.sql).run(...this.bindings).changes) } };
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string): SqliteStatement { return new SqliteStatement(this.database, sql); }
}

class Bucket {
  readonly objects = new Set<string>();
  deleteFailures = 0;
  async delete(key: string): Promise<void> {
    if (this.deleteFailures > 0) {
      this.deleteFailures -= 1;
      throw new Error("injected-audit-delete-failure");
    }
    this.objects.delete(key);
  }
  async head(key: string): Promise<{ readonly key: string } | null> { return this.objects.has(key) ? { key } : null; }
}

const SUBMISSION_ID = "0198dbd3-5c00-7000-8000-000000000201";
const DIGEST = "a".repeat(64);
const NOW = "2026-08-09T00:00:00.000Z";

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE submission_attempts (
    submission_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    container_key TEXT NOT NULL,
    state TEXT NOT NULL,
    finished_at TEXT,
    audit_r2_key TEXT,
    PRIMARY KEY (submission_id, attempt)
  ) STRICT`);
  const primary = new Bucket();
  const env = {
    DB: new SqliteD1(database) as unknown as D1Database,
    JUDGE_BUCKET: primary as unknown as R2Bucket,
  } as ForgeWorkerEnv;
  return { database, primary, env };
}

function auditKey(attempt: number): string {
  return `audits/${SUBMISSION_ID}/${attempt}.${DIGEST}.json`;
}

describe("submission attempt audit cleanup", () => {
  it("isolates a failed subsystem phase so later lifecycle repair still runs", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let laterRan = false;
    try {
      await expect(reconcilePhase("injected-phase", 0, async () => { throw new Error("injected"); })).resolves.toBe(0);
      await expect(reconcilePhase("later-phase", 0, async () => { laterRan = true; return 1; })).resolves.toBe(1);
      expect(laterRan).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("retains the D1 claim when object deletion fails and retries", async () => {
    const { database, primary, env } = fixture();
    database.prepare("INSERT INTO submission_attempts (submission_id, attempt, token_hash, container_key, state, finished_at, audit_r2_key) VALUES (?, 1, ?, ?, 'failed', ?, ?)")
      .run(SUBMISSION_ID, DIGEST, SUBMISSION_ID, NOW, auditKey(1));
    primary.objects.add(auditKey(1));
    primary.deleteFailures = 1;
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(reconcileUncommittedAttemptAudits(env)).resolves.toBe(0);
      expect(database.prepare("SELECT audit_r2_key FROM submission_attempts WHERE submission_id=? AND attempt=1").get(SUBMISSION_ID)).toEqual({ audit_r2_key: auditKey(1) });
      expect(primary.objects.has(auditKey(1))).toBe(true);
      await expect(reconcileUncommittedAttemptAudits(env)).resolves.toBe(1);
      expect(database.prepare("SELECT audit_r2_key FROM submission_attempts WHERE submission_id=? AND attempt=1").get(SUBMISSION_ID)).toEqual({ audit_r2_key: null });
      expect(primary.objects.size).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it("never deletes the permanent audit of a succeeded attempt", async () => {
    const { database, primary, env } = fixture();
    database.prepare("INSERT INTO submission_attempts (submission_id, attempt, token_hash, container_key, state, finished_at, audit_r2_key) VALUES (?, 1, ?, ?, 'succeeded', ?, ?)")
      .run(SUBMISSION_ID, DIGEST, SUBMISSION_ID, NOW, auditKey(1));
    primary.objects.add(auditKey(1));

    await expect(reconcileUncommittedAttemptAudits(env)).resolves.toBe(0);
    expect(primary.objects.has(auditKey(1))).toBe(true);
    expect(database.prepare("SELECT audit_r2_key FROM submission_attempts WHERE submission_id=?").get(SUBMISSION_ID)).toEqual({ audit_r2_key: auditKey(1) });
  });
});
