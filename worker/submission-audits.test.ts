import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
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
const USER_ID = "0198dbd3-5c00-7000-8000-000000000202";
const PROBLEM_ID = "0198dbd3-5c00-7000-8000-000000000203";
const DIGEST = "a".repeat(64);
const NOW = "2026-08-09T00:00:00.000Z";

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "0001_initial.sql",
    "0002_rejudge_pipeline.sql",
    "0003_account_erasure_fence.sql",
    "0004_projection_outbox_uniqueness.sql",
    "0005_formal_admission_claim.sql",
    "0006_d1_submission_events_capacity.sql",
  ]) {
    database.exec(readFileSync(path.join(process.cwd(), "migrations/submissions", migration), "utf8"));
  }
  database.prepare(`INSERT INTO submissions
    (id, user_id, managed_problem_version_id, language, target, optimization, entry_path,
     source_r2_key, source_digest, forge_release_id, forge_manifest_sha256, state,
     visibility, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, 'c', 'wasip1', 'release', 'main.c', 'source', ?, ?, ?, 'infrastructure-error', 'private', ?, ?, ?)`)
    .run(SUBMISSION_ID, USER_ID, PROBLEM_ID, DIGEST, PROBLEM_ID, DIGEST, NOW, NOW, NOW);
  const primary = new Bucket();
  const mirror = new Bucket();
  const env = {
    SUBMISSIONS_DB: new SqliteD1(database) as unknown as D1Database,
    JUDGE_BUCKET: primary as unknown as R2Bucket,
    JUDGE_MIRROR_BUCKET: mirror as unknown as R2Bucket,
  } as ForgeWorkerEnv;
  return { database, primary, mirror, env };
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

  it("retains the D1 claim across a partial mirrored deletion and retries", async () => {
    const { database, primary, mirror, env } = fixture();
    database.prepare("INSERT INTO submission_attempts (submission_id, attempt, token_hash, container_key, state, finished_at, audit_r2_key) VALUES (?, 1, ?, ?, 'failed', ?, ?)")
      .run(SUBMISSION_ID, DIGEST, SUBMISSION_ID, NOW, auditKey(1));
    primary.objects.add(auditKey(1));
    mirror.objects.add(auditKey(1));
    primary.deleteFailures = 1;
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(reconcileUncommittedAttemptAudits(env)).resolves.toBe(0);
      expect(database.prepare("SELECT audit_r2_key FROM submission_attempts WHERE submission_id=? AND attempt=1").get(SUBMISSION_ID)).toEqual({ audit_r2_key: auditKey(1) });
      expect(primary.objects.has(auditKey(1))).toBe(true);
      expect(mirror.objects.has(auditKey(1))).toBe(false);
      await expect(reconcileUncommittedAttemptAudits(env)).resolves.toBe(1);
      expect(database.prepare("SELECT audit_r2_key FROM submission_attempts WHERE submission_id=? AND attempt=1").get(SUBMISSION_ID)).toEqual({ audit_r2_key: null });
      expect(primary.objects.size + mirror.objects.size).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it("never deletes the permanent audit of a succeeded attempt", async () => {
    const { database, primary, mirror, env } = fixture();
    database.prepare("INSERT INTO submission_attempts (submission_id, attempt, token_hash, container_key, state, finished_at, audit_r2_key) VALUES (?, 1, ?, ?, 'succeeded', ?, ?)")
      .run(SUBMISSION_ID, DIGEST, SUBMISSION_ID, NOW, auditKey(1));
    primary.objects.add(auditKey(1));
    mirror.objects.add(auditKey(1));

    await expect(reconcileUncommittedAttemptAudits(env)).resolves.toBe(0);
    expect(primary.objects.has(auditKey(1)) && mirror.objects.has(auditKey(1))).toBe(true);
    expect(database.prepare("SELECT audit_r2_key FROM submission_attempts WHERE submission_id=?").get(SUBMISSION_ID)).toEqual({ audit_r2_key: auditKey(1) });
  });

  it("enforces one profile outbox per submission", () => {
    const { database } = fixture();
    const insert = database.prepare("INSERT OR IGNORE INTO submission_outbox (id, submission_id, kind, payload_json, created_at) VALUES (?, ?, ?, '{}', ?)");
    expect(insert.run("profile-1", SUBMISSION_ID, "update-profile", NOW).changes).toBe(1);
    expect(insert.run("profile-2", SUBMISSION_ID, "update-profile", NOW).changes).toBe(0);
  });
});
