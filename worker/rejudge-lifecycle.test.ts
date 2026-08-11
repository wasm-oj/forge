import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ForgeWorkerEnv } from "./env";
import { repairDispatchedRejudgeJobs, rejudgeWorkflowNeedsInfrastructureRepair } from "./rejudge";

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

  async run(): Promise<{ readonly meta: { readonly changes: number } }> {
    return { meta: { changes: Number(this.database.prepare(this.sql).run(...this.bindings).changes) } };
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  async batch(statements: readonly SqliteStatement[]): Promise<readonly { readonly meta: { readonly changes: number } }[]> {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class WorkflowNamespace {
  status = "complete";

  async get(): Promise<{ status(): Promise<{ readonly status: string }> }> {
    return { status: async () => ({ status: this.status }) };
  }
}

const OLD_ID = "00000000-0000-4000-8000-000000000001";
const CHILD_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const PROBLEM_ID = "00000000-0000-4000-8000-000000000004";
const NEW_PROBLEM_ID = "00000000-0000-4000-8000-000000000005";
const BATCH_ID = "00000000-0000-4000-8000-000000000006";
const DIGEST = "a".repeat(64);

function fixture(updatedAt = "2026-01-01T00:00:00.000Z") {
  const database = new DatabaseSync(":memory:");
  for (const migration of ["0001_initial.sql", "0002_rejudge_pipeline.sql", "0003_account_erasure_fence.sql", "0004_projection_outbox_uniqueness.sql", "0005_formal_admission_claim.sql", "0006_d1_submission_events_capacity.sql", "0007_leaderboard_indexes.sql"]) {
    database.exec(readFileSync(path.join(process.cwd(), "migrations/submissions", migration), "utf8"));
  }
  const insert = database.prepare(`INSERT INTO submissions
    (id, user_id, managed_problem_version_id, language, target, optimization, entry_path,
     source_r2_key, source_digest, forge_release_id, forge_manifest_sha256, state, visibility,
     created_at, updated_at, completed_at, rejudge_batch_id, rejudge_of_submission_id)
    VALUES (?, ?, ?, 'c', 'wasip1', 'release', 'main.c', ?, ?, ?, ?, ?, 'private', ?, ?, ?, ?, ?)`);
  insert.run(OLD_ID, USER_ID, PROBLEM_ID, "source", DIGEST, PROBLEM_ID, DIGEST, "completed", updatedAt, updatedAt, updatedAt, null, null);
  insert.run(CHILD_ID, USER_ID, NEW_PROBLEM_ID, "source", DIGEST, PROBLEM_ID, DIGEST, "admitting", updatedAt, updatedAt, null, BATCH_ID, OLD_ID);
  database.prepare("INSERT INTO submission_attempts (submission_id, attempt, token_hash, container_key, state) VALUES (?, 1, ?, ?, 'created')")
    .run(CHILD_ID, DIGEST, CHILD_ID);
  database.prepare("INSERT INTO rejudge_jobs (rejudge_batch_id, old_submission_id, new_submission_id, old_problem_version_id, new_problem_version_id, state, workflow_payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'dispatched', 'sensitive', ?, ?)")
    .run(BATCH_ID, OLD_ID, CHILD_ID, PROBLEM_ID, NEW_PROBLEM_ID, updatedAt, updatedAt);
  database.prepare("INSERT INTO submission_outbox (id, submission_id, kind, payload_json, created_at, delivered_at) VALUES (?, ?, 'start-workflow', '{}', ?, ?)")
    .run(BATCH_ID, CHILD_ID, updatedAt, updatedAt);
  const workflow = new WorkflowNamespace();
  const env = {
    SUBMISSIONS_DB: new SqliteD1(database) as unknown as D1Database,
    SUBMISSION_WORKFLOW: workflow as unknown as Workflow,
  } as unknown as ForgeWorkerEnv;
  return { database, workflow, env };
}

describe("rejudge terminal Workflow recovery", () => {
  it("repairs complete-without-result and emits one durable terminal event", async () => {
    const { database, env } = fixture();

    await expect(repairDispatchedRejudgeJobs(env)).resolves.toBe(1);
    expect(database.prepare("SELECT state, score, fully_passed_cases FROM submissions WHERE id=?").get(CHILD_ID)).toEqual({
      state: "infrastructure-error",
      score: 0,
      fully_passed_cases: 0,
    });
    expect(database.prepare("SELECT state, failure_code FROM submission_attempts WHERE submission_id=?").get(CHILD_ID)).toEqual({
      state: "failed",
      failure_code: "workflow-terminal-without-result",
    });
    expect(database.prepare("SELECT state, result_state, workflow_payload_json FROM rejudge_jobs WHERE new_submission_id=?").get(CHILD_ID)).toEqual({
      state: "failed",
      result_state: "infrastructure-error",
      workflow_payload_json: "{}",
    });
    expect(database.prepare("SELECT payload_json FROM submission_events WHERE submission_id=?").get(CHILD_ID)).toEqual({
      payload_json: JSON.stringify({ kind: "state", state: "infrastructure-error" }),
    });
    await expect(repairDispatchedRejudgeJobs(env)).resolves.toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM submission_events WHERE submission_id=?").get(CHILD_ID)).toEqual({ count: 1 });
  });

  it("waits for a running Workflow before repairing its missing result", async () => {
    const { database, env, workflow } = fixture();
    workflow.status = "running";
    await expect(repairDispatchedRejudgeJobs(env)).resolves.toBe(0);
    expect(database.prepare("SELECT state FROM submissions WHERE id=?").get(CHILD_ID)).toEqual({ state: "admitting" });
    workflow.status = "complete";
    await expect(repairDispatchedRejudgeJobs(env)).resolves.toBe(1);
    expect(database.prepare("SELECT state FROM submissions WHERE id=?").get(CHILD_ID)).toEqual({ state: "infrastructure-error" });
  });

  it("gives an unknown Workflow a ten-minute propagation grace", () => {
    const now = new Date("2026-08-09T08:00:00.000Z");
    expect(rejudgeWorkflowNeedsInfrastructureRepair({ status: "unknown", submissionUpdatedAt: "2026-08-09T07:55:00.000Z", now })).toBe(false);
    expect(rejudgeWorkflowNeedsInfrastructureRepair({ status: "unknown", submissionUpdatedAt: "2026-08-09T07:50:00.000Z", now })).toBe(true);
    expect(rejudgeWorkflowNeedsInfrastructureRepair({ status: "complete", submissionUpdatedAt: now.toISOString(), now })).toBe(true);
    expect(rejudgeWorkflowNeedsInfrastructureRepair({ status: "running", submissionUpdatedAt: "2020-01-01T00:00:00.000Z", now })).toBe(false);
  });
});
