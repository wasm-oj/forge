import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";

function applyCoreMigrations(database: DatabaseSync): void {
  const directory = path.join(process.cwd(), "migrations/core");
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".sql")).sort()) {
    database.exec(readFileSync(path.join(directory, name), "utf8"));
  }
}

function columns(database: DatabaseSync, table: string): readonly string[] {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

describe("single D1 rejudge schema", () => {
  it("applies the consolidated chain with submissions and immutable activation pointers", () => {
    const database = new DatabaseSync(":memory:");
    applyCoreMigrations(database);

    expect(columns(database, "rejudge_batches")).toEqual(expect.arrayContaining([
      "idempotency_key",
      "request_digest",
      "wasm_oj_release_id",
      "wasm_oj_manifest_sha256",
      "cancel_requested_at",
      "effective_at",
    ]));
    expect(columns(database, "effective_submission_results")).toEqual([
      "origin_submission_id",
      "effective_submission_id",
      "effective_problem_version_id",
      "effective_rejudge_batch_id",
      "became_effective_at",
    ]);
    expect(columns(database, "submissions")).toEqual(expect.arrayContaining([
      "admitted_at",
      "origin_submission_id",
      "origin_submitted_at",
      "problem_series_id",
      "source_id",
    ]));
    expect(columns(database, "rejudge_jobs")).toEqual(expect.arrayContaining([
      "origin_submission_id",
      "old_submission_id",
      "new_submission_id",
      "source_id",
      "state",
    ]));
    expect(columns(database, "submission_events")).toEqual([
      "id",
      "submission_id",
      "event_key",
      "payload_json",
      "created_at",
    ]);
    for (const removed of [
      "formal_submission_admissions",
      "verified_solves",
      "rejudge_verified_solves",
      "submission_owner_erasure_fences",
      "submission_outbox",
      "rejudge_result_outbox",
      "core_outbox",
      "effective_problem_versions",
      "effective_rejudges",
      "outbox",
      "rejudge_results",
      "maintenance_tasks",
    ]) {
      expect(database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(removed)).toBeUndefined();
    }
    expect(columns(database, "workflow_outbox")).toEqual([
      "id",
      "catalog_validation_job_id",
      "catalog_publish_job_id",
      "submission_id",
      "state",
      "attempts",
      "last_error",
      "created_at",
      "updated_at",
      "settled_at",
    ]);
    expect(columns(database, "problem_versions")).toEqual([
      "id",
      "catalog_publication_id",
      "problem_series_id",
      "execution_semantic_sha256",
      "created_at",
    ]);
    expect(columns(database, "submission_sources")).toEqual(expect.arrayContaining([
      "erasure_requested_at",
      "erasure_attempts",
      "erasure_next_attempt_at",
      "erasure_last_error",
    ]));
    expect(columns(database, "submissions")).not.toContain("problem_mode");
    expect(columns(database, "submission_attempts")).not.toContain("container_key");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
