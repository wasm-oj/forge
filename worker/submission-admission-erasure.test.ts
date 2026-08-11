import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ForgeWorkerEnv } from "./env";
import { abortFormalSubmissionAdmission } from "./formal-admissions";
import {
  INSERT_FORMAL_SUBMISSION_ADMISSION_SQL,
  INSERT_OFFICIAL_SUBMISSION_ATTEMPT_SQL,
  INSERT_OFFICIAL_SUBMISSION_IDEMPOTENCY_SQL,
  INSERT_OFFICIAL_SUBMISSION_OUTBOX_SQL,
  INSERT_OFFICIAL_SUBMISSION_SQL,
} from "./submissions";

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
  async delete(key: string): Promise<void> { this.objects.delete(key); }
  async head(key: string): Promise<{ readonly key: string } | null> { return this.objects.has(key) ? { key } : null; }
}

const SUBMISSION_ID = "0198dbd3-5c00-7000-8000-000000000501";
const USER_ID = "0198dbd3-5c00-7000-8000-000000000502";
const ANONYMOUS_ID = "anon:0198dbd3-5c00-7000-8000-000000000503";
const PROBLEM_ID = "0198dbd3-5c00-7000-8000-000000000504";
const RELEASE_ID = "0198dbd3-5c00-7000-8000-000000000505";
const OUTBOX_ID = "0198dbd3-5c00-7000-8000-000000000506";
const DIGEST = "a".repeat(64);
const CLAIM = "b".repeat(64);
const SOURCE_KEY = `sources/${USER_ID}/${SUBMISSION_ID}.${DIGEST}.json`;
const NOW = "2026-08-09T00:00:00.000Z";

function database(): DatabaseSync {
  const value = new DatabaseSync(":memory:");
  for (const migration of ["0001_initial.sql", "0002_rejudge_pipeline.sql", "0003_account_erasure_fence.sql", "0004_projection_outbox_uniqueness.sql", "0005_formal_admission_claim.sql"]) {
    value.exec(readFileSync(path.join(process.cwd(), "migrations/submissions", migration), "utf8"));
  }
  return value;
}

function runAdmissionBatch(db: DatabaseSync): readonly number[] {
  db.exec("BEGIN IMMEDIATE");
  try {
    const results = [
      db.prepare(INSERT_OFFICIAL_SUBMISSION_SQL).run(SUBMISSION_ID, USER_ID, PROBLEM_ID, null, NOW, CLAIM, "c", "wasip1", "release", "main.c", SOURCE_KEY, DIGEST, RELEASE_ID, DIGEST, NOW, NOW, USER_ID),
      db.prepare(INSERT_OFFICIAL_SUBMISSION_IDEMPOTENCY_SQL).run(USER_ID, "request-1", DIGEST, SUBMISSION_ID, NOW, SUBMISSION_ID, USER_ID, SOURCE_KEY, DIGEST, NOW, CLAIM, null),
      db.prepare(INSERT_OFFICIAL_SUBMISSION_ATTEMPT_SQL).run(SUBMISSION_ID, DIGEST, `${SUBMISSION_ID}:1`, SUBMISSION_ID, USER_ID, SOURCE_KEY, DIGEST, NOW, CLAIM, null),
      db.prepare(INSERT_OFFICIAL_SUBMISSION_OUTBOX_SQL).run(OUTBOX_ID, SUBMISSION_ID, JSON.stringify({ submissionId: SUBMISSION_ID, attempt: 1, expectedReleaseId: RELEASE_ID, expectedManifestSha256: DIGEST }), NOW, SUBMISSION_ID, USER_ID, SOURCE_KEY, DIGEST, NOW, CLAIM, null),
    ];
    db.exec("COMMIT");
    return results.map((result) => Number(result.changes));
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function fenceOwner(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT OR IGNORE INTO submission_owner_erasure_fences (owner_user_id, erasure_job_id, anonymous_user_id, fenced_at) VALUES (?, 'erasure-1', ?, ?)")
    .run(USER_ID, ANONYMOUS_ID, NOW);
  db.prepare("UPDATE submissions SET state='cancelled', updated_at=?, completed_at=? WHERE user_id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')")
    .run(NOW, NOW, USER_ID);
  db.prepare("UPDATE submission_attempts SET state='cancelled', finished_at=? WHERE submission_id IN (SELECT id FROM submissions WHERE user_id=?) AND state IN ('created','running')")
    .run(NOW, USER_ID);
  db.prepare("UPDATE submission_outbox SET delivered_at=?, payload_json='{}' WHERE submission_id IN (SELECT id FROM submissions WHERE user_id=?)")
    .run(NOW, USER_ID);
  db.exec("COMMIT");
}

describe("official submission / account erasure admission fence", () => {
  it("refuses a CORE admission marker once the account is inactive or has an erasure job", () => {
    const core = new DatabaseSync(":memory:");
    core.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
      CREATE TABLE account_erasure_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL) STRICT;
      CREATE TABLE rejudge_batches (old_problem_version_id TEXT NOT NULL, status TEXT NOT NULL) STRICT;
      CREATE TABLE effective_problem_versions (original_problem_version_id TEXT NOT NULL) STRICT;
      CREATE TABLE contests (id TEXT PRIMARY KEY, status TEXT NOT NULL, access_mode TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL) STRICT;
      CREATE TABLE contest_problems (contest_id TEXT NOT NULL, managed_problem_version_id TEXT NOT NULL) STRICT;
      CREATE TABLE contest_participants (contest_id TEXT NOT NULL, user_id TEXT NOT NULL) STRICT;
      CREATE TABLE formal_submission_admissions (
        submission_id TEXT PRIMARY KEY, managed_problem_version_id TEXT NOT NULL, user_id TEXT NOT NULL,
        contest_id TEXT, admitted_at TEXT, state TEXT NOT NULL, source_r2_key TEXT, source_sha256 TEXT, cleanup_state TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;`);
    core.prepare("INSERT INTO users (id, status) VALUES (?, 'active')").run(USER_ID);
    const insert = (submissionId: string) => core.prepare(INSERT_FORMAL_SUBMISSION_ADMISSION_SQL).run(
      submissionId, PROBLEM_ID, USER_ID, null, SOURCE_KEY, DIGEST, NOW, "2999-01-01T00:00:00.000Z", NOW,
    );
    expect(insert(SUBMISSION_ID).changes).toBe(1);
    core.prepare("DELETE FROM formal_submission_admissions").run();
    core.prepare("INSERT INTO account_erasure_jobs (id, user_id) VALUES ('erasure-1', ?)").run(USER_ID);
    expect(insert(SUBMISSION_ID).changes).toBe(0);
    core.prepare("DELETE FROM account_erasure_jobs").run();
    core.prepare("UPDATE users SET status='suspended' WHERE id=?").run(USER_ID);
    expect(insert(SUBMISSION_ID).changes).toBe(0);
  });

  it("lets the erasure transaction catch and scrub a submission batch that committed first", () => {
    const db = database();
    expect(runAdmissionBatch(db)).toEqual([1, 1, 1, 1]);
    fenceOwner(db);
    expect(db.prepare("SELECT state FROM submissions WHERE id=?").get(SUBMISSION_ID)).toEqual({ state: "cancelled" });
    expect(db.prepare("SELECT state FROM submission_attempts WHERE submission_id=?").get(SUBMISSION_ID)).toEqual({ state: "cancelled" });
    expect(db.prepare("SELECT delivered_at, payload_json FROM submission_outbox WHERE id=?").get(OUTBOX_ID)).toEqual({ delivered_at: NOW, payload_json: "{}" });
  });

  it("creates no authoritative rows when the erasure fence commits first and durably cleans source", async () => {
    const db = database();
    fenceOwner(db);
    expect(runAdmissionBatch(db)).toEqual([0, 0, 0, 0]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM submissions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM submission_attempts").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM submission_outbox").get()).toEqual({ count: 0 });

    const core = new DatabaseSync(":memory:");
    core.exec(`CREATE TABLE formal_submission_admissions (
      submission_id TEXT PRIMARY KEY, managed_problem_version_id TEXT NOT NULL, user_id TEXT NOT NULL,
      contest_id TEXT, admitted_at TEXT NOT NULL, state TEXT NOT NULL, source_r2_key TEXT, source_sha256 TEXT, cleanup_state TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT`);
    core.prepare("INSERT INTO formal_submission_admissions (submission_id, managed_problem_version_id, user_id, contest_id, admitted_at, state, source_r2_key, source_sha256, cleanup_state, created_at, expires_at, updated_at) VALUES (?, ?, ?, NULL, ?, 'pending', ?, ?, 'pending', ?, ?, ?)")
      .run(SUBMISSION_ID, PROBLEM_ID, USER_ID, NOW, SOURCE_KEY, DIGEST, NOW, "2999-01-01T00:00:00.000Z", NOW);
    const primary = new Bucket();
    const mirror = new Bucket();
    primary.objects.add(SOURCE_KEY);
    mirror.objects.add(SOURCE_KEY);
    const env = {
      CORE_DB: new SqliteD1(core) as unknown as D1Database,
      SUBMISSIONS_DB: new SqliteD1(db) as unknown as D1Database,
      JUDGE_BUCKET: primary as unknown as R2Bucket,
      JUDGE_MIRROR_BUCKET: mirror as unknown as R2Bucket,
    } as unknown as ForgeWorkerEnv;
    await expect(abortFormalSubmissionAdmission(env, {
      submissionId: SUBMISSION_ID,
      managedProblemVersionId: PROBLEM_ID,
      userId: USER_ID,
    })).resolves.toBe("cleaned");
    expect(primary.objects.size + mirror.objects.size).toBe(0);
    expect(core.prepare("SELECT state, cleanup_state, source_r2_key FROM formal_submission_admissions WHERE submission_id=?").get(SUBMISSION_ID)).toEqual({
      state: "aborted",
      cleanup_state: "complete",
      source_r2_key: null,
    });
  });
});
