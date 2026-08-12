import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import {
  activateReadyBatch,
  erasureAdjustedExpectedCount,
  MATERIALIZE_REJUDGE_SUBMISSION_SQL,
  repairDispatchedRejudgeJobs,
  rejudgeSideEffectPlan,
  rejudgeWorkflowNeedsInfrastructureRepair,
} from "./rejudge";

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
  async all<T>(): Promise<{ readonly results: readonly T[] }> {
    return { results: this.database.prepare(this.sql).all(...this.bindings) as T[] };
  }
  async run(): Promise<{ readonly success: true; readonly meta: { readonly changes: number } }> {
    return { success: true, meta: { changes: Number(this.database.prepare(this.sql).run(...this.bindings).changes) } };
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }
  async batch(statements: readonly SqliteStatement[]): Promise<readonly { readonly success: true; readonly meta: { readonly changes: number } }[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class WorkflowNamespace {
  status = "complete";
  async get(): Promise<{ status(): Promise<{ readonly status: string }> }> {
    return { status: async () => ({ status: this.status }) };
  }
}

const ORIGIN_ID = "00000000-0000-4000-8000-000000000001";
const CHILD_ID = "00000000-0000-4000-8000-000000000003";
const USER_ID = "00000000-0000-4000-8000-000000000004";
const SOURCE_ID = "00000000-0000-4000-8000-000000000005";
const SERIES_ID = "00000000-0000-4000-8000-000000000006";
const OLD_PROBLEM_ID = "00000000-0000-4000-8000-000000000007";
const NEW_PROBLEM_ID = "00000000-0000-4000-8000-000000000008";
const BATCH_ID = "00000000-0000-4000-8000-000000000009";
const RELEASE_ID = "00000000-0000-4000-8000-00000000000a";
const JOB_ID = "00000000-0000-4000-8000-00000000000b";
const DIGEST = "a".repeat(64);
const NOW = "2026-08-09T08:00:00.000Z";

function recoveryFixture(updatedAt = NOW) {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE submissions (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, verdict TEXT, score REAL,
      fully_passed_cases INTEGER, updated_at TEXT NOT NULL, completed_at TEXT
    ) STRICT;
    CREATE TABLE submission_attempts (
      submission_id TEXT NOT NULL, attempt INTEGER NOT NULL, state TEXT NOT NULL,
      finished_at TEXT, failure_code TEXT, PRIMARY KEY (submission_id, attempt)
    ) STRICT;
    CREATE TABLE submission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id TEXT NOT NULL,
      event_key TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (submission_id, event_key)
    ) STRICT;
    CREATE TABLE rejudge_jobs (
      id TEXT PRIMARY KEY, new_submission_id TEXT NOT NULL, state TEXT NOT NULL,
      result_state TEXT, updated_at TEXT NOT NULL
    ) STRICT;`);
  database.prepare("INSERT INTO submissions (id, state, updated_at) VALUES (?, 'running', ?)")
    .run(CHILD_ID, updatedAt);
  database.prepare("INSERT INTO submission_attempts (submission_id, attempt, state) VALUES (?, 1, 'running')")
    .run(CHILD_ID);
  database.prepare("INSERT INTO rejudge_jobs (id, new_submission_id, state, updated_at) VALUES (?, ?, 'dispatched', ?)")
    .run(JOB_ID, CHILD_ID, updatedAt);
  const workflow = new WorkflowNamespace();
  const env = {
    DB: new SqliteD1(database) as unknown as D1Database,
    SUBMISSION_WORKFLOW: workflow as unknown as Workflow,
  } as unknown as WasmOjWorkerEnv;
  return { database, workflow, env };
}

describe("rejudge v2 lifecycle", () => {
  it("classifies direct Workflow judge errors as failed without persisting an effective result", async () => {
    const source = await readFile(new URL("./workflows.ts", import.meta.url), "utf8");
    const finalizer = source.slice(
      source.indexOf("async function finalizeContainerResult"),
      source.indexOf("async function createRetryAttempt"),
    );
    expect(finalizer).toContain("classifyRejudgeChildState(result.state)");
    expect(finalizer).toContain("SET state=?, result_state=?, updated_at=?");
    expect(finalizer).not.toContain("rejudge_results");
    expect(finalizer).not.toContain("SET state='ready', result_state=?");
  });

  it("repairs a terminal Workflow that did not commit a child result exactly once", async () => {
    const { database, env } = recoveryFixture();
    await expect(repairDispatchedRejudgeJobs(env)).resolves.toBe(1);
    expect(database.prepare("SELECT state, verdict, score, fully_passed_cases FROM submissions WHERE id=?").get(CHILD_ID)).toEqual({
      state: "infrastructure-error",
      verdict: "judge-error",
      score: 0,
      fully_passed_cases: 0,
    });
    expect(database.prepare("SELECT state, result_state FROM rejudge_jobs WHERE id=?").get(JOB_ID)).toEqual({
      state: "failed",
      result_state: "infrastructure-error",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM submission_events WHERE submission_id=?").get(CHILD_ID)).toEqual({ count: 1 });
    await expect(repairDispatchedRejudgeJobs(env)).resolves.toBe(0);
  });

  it("waits for running and recently-unknown Workflows", async () => {
    const { database, env, workflow } = recoveryFixture();
    workflow.status = "running";
    await expect(repairDispatchedRejudgeJobs(env)).resolves.toBe(0);
    expect(database.prepare("SELECT state FROM submissions WHERE id=?").get(CHILD_ID)).toEqual({ state: "running" });

    const now = new Date(NOW);
    expect(rejudgeWorkflowNeedsInfrastructureRepair({ status: "unknown", submissionUpdatedAt: "2026-08-09T07:55:00.000Z", now })).toBe(false);
    expect(rejudgeWorkflowNeedsInfrastructureRepair({ status: "unknown", submissionUpdatedAt: "2026-08-09T07:50:00.000Z", now })).toBe(true);
    expect(rejudgeWorkflowNeedsInfrastructureRepair({ status: "complete", submissionUpdatedAt: NOW, now })).toBe(true);
  });

  it("materializes A(same digest)→B→C from physical A while preserving the origin and source ID", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT, erasure_epoch INTEGER) STRICT;
      CREATE TABLE account_erasure_jobs (user_id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE submission_sources (
        id TEXT PRIMARY KEY, owner_user_id TEXT, admission_erasure_epoch INTEGER, state TEXT
      ) STRICT;
      CREATE TABLE problem_version_details (
        id TEXT PRIMARY KEY, problem_series_id TEXT, mode TEXT, execution_semantic_sha256 TEXT
      ) STRICT;
      CREATE TABLE rejudge_batches (
        id TEXT PRIMARY KEY, old_problem_version_id TEXT, new_problem_version_id TEXT,
        problem_series_id TEXT, wasm_oj_release_id TEXT, wasm_oj_manifest_sha256 TEXT, state TEXT
      ) STRICT;
      CREATE TABLE submissions (
        id TEXT PRIMARY KEY, origin_submission_id TEXT, origin_submitted_at TEXT, user_id TEXT,
        problem_version_id TEXT, problem_series_id TEXT, execution_semantic_sha256 TEXT,
        contest_id TEXT, source_id TEXT, language TEXT,
        target TEXT, optimization TEXT, entry_path TEXT, wasm_oj_release_id TEXT,
        wasm_oj_manifest_sha256 TEXT, state TEXT, visibility TEXT, admitted_at TEXT,
        created_at TEXT, updated_at TEXT
      ) STRICT;
      CREATE TABLE effective_submission_results (
        origin_submission_id TEXT, effective_submission_id TEXT, effective_problem_version_id TEXT
      ) STRICT;`);
    database.prepare("INSERT INTO users VALUES (?, 'active', 0)").run(USER_ID);
    database.prepare("INSERT INTO submission_sources VALUES (?, ?, 0, 'ready')").run(SOURCE_ID, USER_ID);
    const originalProblemId = "00000000-0000-4000-8000-00000000000c";
    database.prepare("INSERT INTO problem_version_details VALUES (?, ?, 'official-practice', ?)").run(originalProblemId, SERIES_ID, "b".repeat(64));
    database.prepare("INSERT INTO problem_version_details VALUES (?, ?, 'official-practice', ?)").run(OLD_PROBLEM_ID, SERIES_ID, "b".repeat(64));
    database.prepare("INSERT INTO problem_version_details VALUES (?, ?, 'official-practice', ?)").run(NEW_PROBLEM_ID, SERIES_ID, "c".repeat(64));
    database.prepare("INSERT INTO rejudge_batches VALUES (?, ?, ?, ?, ?, ?, 'running')")
      .run(BATCH_ID, OLD_PROBLEM_ID, NEW_PROBLEM_ID, SERIES_ID, RELEASE_ID, DIGEST);
    const insert = database.prepare(`INSERT INTO submissions VALUES
      (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'rust', 'wasip1', 'release',
       'main.rs', ?, ?, 'completed', 'private', ?, ?, ?)`);
    insert.run(ORIGIN_ID, ORIGIN_ID, NOW, USER_ID, originalProblemId, SERIES_ID, "b".repeat(64), SOURCE_ID, RELEASE_ID, DIGEST, NOW, NOW, NOW);
    database.prepare("INSERT INTO effective_submission_results VALUES (?, ?, ?)")
      .run(ORIGIN_ID, ORIGIN_ID, OLD_PROBLEM_ID);

    database.prepare(MATERIALIZE_REJUDGE_SUBMISSION_SQL).run(
      CHILD_ID, NOW, NOW, NOW, ORIGIN_ID, ORIGIN_ID, BATCH_ID,
    );
    expect(database.prepare(`SELECT origin_submission_id, problem_version_id, source_id, user_id
      FROM submissions WHERE id=?`).get(CHILD_ID)).toEqual({
      origin_submission_id: ORIGIN_ID,
      problem_version_id: NEW_PROBLEM_ID,
      source_id: SOURCE_ID,
      user_id: USER_ID,
    });
  });

  it("shrinks an unsettled expected count only after erased origins are no longer eligible", () => {
    expect(erasureAdjustedExpectedCount(10, 7, false)).toBe(10);
    expect(erasureAdjustedExpectedCount(10, 7, true)).toBe(7);
  });

  it("never enqueues materialization for a same-semantic no-op", () => {
    expect(rejudgeSideEffectPlan(true, false, "official-practice")).toEqual({
      lineageReason: "publication",
      enqueueMaterialization: false,
    });
    expect(rejudgeSideEffectPlan(true, false, "contest")).toEqual({
      lineageReason: "rejudge",
      enqueueMaterialization: false,
    });
    expect(rejudgeSideEffectPlan(true, true, "official-practice")).toEqual({
      lineageReason: null,
      enqueueMaterialization: false,
    });
    expect(rejudgeSideEffectPlan(false, false, "contest")).toEqual({
      lineageReason: null,
      enqueueMaterialization: true,
    });
  });

  it("atomically makes a fully-ready batch and its lineage effective", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE rejudge_batches (
        id TEXT PRIMARY KEY, problem_series_id TEXT NOT NULL,
        old_problem_version_id TEXT NOT NULL, new_problem_version_id TEXT NOT NULL,
        state TEXT NOT NULL, expected_count INTEGER NOT NULL,
        effective_at TEXT, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE rejudge_jobs (rejudge_batch_id TEXT NOT NULL, state TEXT NOT NULL) STRICT;
      CREATE TABLE effective_submission_results (
        origin_submission_id TEXT, effective_submission_id TEXT, effective_problem_version_id TEXT
      ) STRICT;
      CREATE TABLE submissions (
        id TEXT PRIMARY KEY, problem_series_id TEXT, state TEXT, source_id TEXT, user_id TEXT
      ) STRICT;
      CREATE TABLE submission_sources (id TEXT PRIMARY KEY, state TEXT, owner_user_id TEXT, admission_erasure_epoch INTEGER) STRICT;
      CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT, erasure_epoch INTEGER) STRICT;
      CREATE TABLE account_erasure_jobs (user_id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE problem_version_lineages (
        problem_series_id TEXT NOT NULL, predecessor_problem_version_id TEXT NOT NULL,
        successor_problem_version_id TEXT NOT NULL, reason TEXT NOT NULL,
        rejudge_batch_id TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;`);
    database.prepare(`INSERT INTO rejudge_batches VALUES
      (?, ?, ?, ?, 'ready', 1, NULL, ?)`).run(
      BATCH_ID, SERIES_ID, OLD_PROBLEM_ID, NEW_PROBLEM_ID, NOW,
    );
    database.prepare("INSERT INTO rejudge_jobs VALUES (?, 'ready')").run(BATCH_ID);
    const env = { DB: new SqliteD1(database) as unknown as D1Database } as WasmOjWorkerEnv;

    await expect(activateReadyBatch(env, {
      id: BATCH_ID,
      old_problem_version_id: OLD_PROBLEM_ID,
      new_problem_version_id: NEW_PROBLEM_ID,
      problem_series_id: SERIES_ID,
      requested_by: USER_ID,
      state: "ready",
      expected_count: 1,
      completed_count: 1,
      ready_count: 1,
      failed_count: 0,
      wasm_oj_release_id: RELEASE_ID,
      wasm_oj_manifest_sha256: DIGEST,
      failure_code: null,
      cancel_requested_at: null,
      created_at: NOW,
      updated_at: NOW,
      effective_at: null,
    })).resolves.toBe(true);
    expect(database.prepare("SELECT state, effective_at FROM rejudge_batches WHERE id=?").get(BATCH_ID)).toEqual({
      state: "effective",
      effective_at: expect.any(String),
    });
    expect(database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='rejudge_results'").get()).toBeUndefined();
    expect(database.prepare("SELECT predecessor_problem_version_id, successor_problem_version_id FROM problem_version_lineages WHERE rejudge_batch_id=?").get(BATCH_ID)).toEqual({
      predecessor_problem_version_id: OLD_PROBLEM_ID,
      successor_problem_version_id: NEW_PROBLEM_ID,
    });
  });
});
