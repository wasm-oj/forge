import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { RepositoryContest } from "../src/online-judge/repository-contract";
import {
  failCatalogSync,
  persistCatalogSync,
  type CatalogSyncContext,
  type ValidatedCatalogProblem,
} from "./catalog-persistence";
import type { WasmOjWorkerEnv } from "./env";

class Statement {
  private bindings: SQLInputValue[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]) { this.bindings = values as SQLInputValue[]; return this; }
  async first<T>(): Promise<T | null> { return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null; }
  async all<T>(): Promise<D1Result<T>> {
    return { success: true, results: this.database.prepare(this.sql).all(...this.bindings) as T[], meta: {} } as D1Result<T>;
  }
  async run(): Promise<D1Result> {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string): Statement { return new Statement(this.database, sql); }
  async batch(statements: readonly Statement[]): Promise<D1Result[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const CATALOG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_JOB = "33333333-3333-4333-8333-333333333333";
const SECOND_JOB = "44444444-4444-4444-8444-444444444444";
const FAILED_JOB = "55555555-5555-4555-8555-555555555555";
const RUNNING_FAILURE_JOB = "66666666-6666-4666-8666-666666666666";
const COMMIT = "a".repeat(40);

function databaseFixture(): { database: DatabaseSync; env: WasmOjWorkerEnv } {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE catalogs (id TEXT PRIMARY KEY, active_commit_sha TEXT, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE catalog_sync_jobs (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, error_code TEXT, summary_json TEXT,
      updated_at TEXT NOT NULL, finished_at TEXT
    ) STRICT;
    CREATE TABLE catalog_deployments (
      catalog_id TEXT NOT NULL, commit_sha TEXT NOT NULL, sync_job_id TEXT NOT NULL,
      synced_by TEXT NOT NULL, synced_at TEXT NOT NULL, problem_count INTEGER NOT NULL,
      contest_count INTEGER NOT NULL, PRIMARY KEY (catalog_id, commit_sha)
    ) STRICT;
    CREATE TABLE problem_series (
      id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL, slug TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (catalog_id, slug)
    ) STRICT;
    CREATE TABLE problem_revisions (
      problem_id TEXT NOT NULL, commit_sha TEXT NOT NULL, ordinal INTEGER NOT NULL,
      title_json TEXT NOT NULL, summary_json TEXT NOT NULL, practice_enabled INTEGER NOT NULL,
      practice_bundle_path TEXT NOT NULL, practice_bundle_bytes INTEGER NOT NULL,
      practice_bundle_sha256 TEXT NOT NULL, contest_bundle_path TEXT NOT NULL,
      contest_bundle_bytes INTEGER NOT NULL, contest_bundle_sha256 TEXT NOT NULL,
      judge_package_path TEXT NOT NULL, judge_package_bytes INTEGER NOT NULL,
      judge_digest TEXT NOT NULL, allowed_profiles_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (problem_id, commit_sha)
    ) STRICT;
    CREATE TABLE contest_series (
      id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL, slug TEXT NOT NULL,
      invite_code_hash TEXT, created_at TEXT NOT NULL, UNIQUE (catalog_id, slug)
    ) STRICT;
    CREATE TABLE contest_revisions (
      contest_id TEXT NOT NULL, commit_sha TEXT NOT NULL, status TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL, access_mode TEXT NOT NULL,
      starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, freeze_at TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (contest_id, commit_sha)
    ) STRICT;
    CREATE TABLE contest_revision_problems (
      contest_id TEXT NOT NULL, commit_sha TEXT NOT NULL, problem_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, PRIMARY KEY (contest_id, commit_sha, problem_id),
      UNIQUE (contest_id, commit_sha, ordinal)
    ) STRICT;
    INSERT INTO catalogs VALUES ('${CATALOG_ID}', NULL, '2026-08-26T00:00:00.000Z');
    INSERT INTO catalog_sync_jobs VALUES ('${FIRST_JOB}', 'running', NULL, NULL, '2026-08-26T00:00:00.000Z', NULL);
  `);
  return { database, env: { DB: new SqliteD1(database) as unknown as D1Database } as WasmOjWorkerEnv };
}

function context(jobId: string, commitSha = COMMIT): CatalogSyncContext {
  return { jobId, catalogId: CATALOG_ID, githubRepositoryId: 42, commitSha, requestedBy: USER_ID, state: "running" };
}

function problem(): ValidatedCatalogProblem {
  return {
    source: {
      slug: "sum", order: 1, title: { "zh-TW": "加總", en: "Sum" },
      summary: { "zh-TW": "計算", en: "Compute" }, practiceEnabled: true,
      practiceBundle: { path: "collection/sum.practice.json", bytes: 10, sha256: "1".repeat(64) },
      contestBundle: { path: "collection/sum.contest.json", bytes: 9, sha256: "2".repeat(64) },
      judgePackage: { path: "collection/sum.wasmojjudge", bytes: 20, sha256: "3".repeat(64) },
    },
    allowedProfilesJson: JSON.stringify({ c: { target: "wasip1", optimization: "release" } }),
  };
}

const contest: RepositoryContest = {
  slug: "weekly", status: "published", title: "Weekly", description: "",
  accessMode: "invite", startsAt: "2026-08-26T00:00:00Z", endsAt: "2026-08-27T00:00:00Z",
  freezeAt: null, problems: ["sum"],
};

describe("catalog projection persistence", () => {
  it("replays the same commit idempotently without overwriting invite operational state", async () => {
    const { database, env } = databaseFixture();
    await persistCatalogSync(env, context(FIRST_JOB), [problem()], [contest]);
    const contestId = database.prepare("SELECT id FROM contest_series WHERE slug='weekly'").get()!.id as string;
    database.prepare("UPDATE contest_series SET invite_code_hash='operational-hmac' WHERE id=?").run(contestId);
    database.prepare("INSERT INTO catalog_sync_jobs VALUES (?, 'running', NULL, NULL, ?, NULL)")
      .run(SECOND_JOB, "2026-08-26T00:01:00.000Z");

    await persistCatalogSync(env, context(SECOND_JOB), [problem()], [contest]);

    expect(database.prepare("SELECT active_commit_sha FROM catalogs WHERE id=?").get(CATALOG_ID)).toEqual({ active_commit_sha: COMMIT });
    expect(database.prepare("SELECT COUNT(*) AS count FROM problem_revisions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM contest_revisions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT invite_code_hash FROM contest_series WHERE id=?").get(contestId)).toEqual({ invite_code_hash: "operational-hmac" });
    expect(database.prepare("SELECT sync_job_id FROM catalog_deployments WHERE catalog_id=? AND commit_sha=?").get(CATALOG_ID, COMMIT))
      .toEqual({ sync_job_id: SECOND_JOB });
  });

  it("cannot write projections or move the active commit after losing the running-state fence", async () => {
    const { database, env } = databaseFixture();
    await persistCatalogSync(env, context(FIRST_JOB), [problem()], [contest]);
    database.prepare("INSERT INTO catalog_sync_jobs VALUES (?, 'failed', 'prior-failure', NULL, ?, ?)")
      .run(FAILED_JOB, "2026-08-26T00:02:00.000Z", "2026-08-26T00:02:00.000Z");

    await expect(persistCatalogSync(env, context(FAILED_JOB, "b".repeat(40)), [problem()], [contest]))
      .rejects.toThrow("running-state fence");
    expect(database.prepare("SELECT active_commit_sha FROM catalogs WHERE id=?").get(CATALOG_ID)).toEqual({ active_commit_sha: COMMIT });
    expect(database.prepare("SELECT COUNT(*) AS count FROM problem_revisions WHERE commit_sha=?").get("b".repeat(40))).toEqual({ count: 0 });

    database.prepare("INSERT INTO catalog_sync_jobs VALUES (?, 'running', NULL, NULL, ?, NULL)")
      .run(RUNNING_FAILURE_JOB, "2026-08-26T00:03:00.000Z");
    await failCatalogSync(env, RUNNING_FAILURE_JOB, new TypeError("invalid manifest"));
    expect(database.prepare("SELECT state, error_code FROM catalog_sync_jobs WHERE id=?").get(RUNNING_FAILURE_JOB))
      .toEqual({ state: "failed", error_code: "catalog-contract-invalid" });
    expect(database.prepare("SELECT active_commit_sha FROM catalogs WHERE id=?").get(CATALOG_ID))
      .toEqual({ active_commit_sha: COMMIT });
  });
});
