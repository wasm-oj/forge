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
      "forge_release_id",
      "forge_manifest_sha256",
      "ready_count",
      "failed_count",
      "cancel_requested_at",
      "mappings_finalized_at",
    ]));
    expect(columns(database, "effective_problem_versions")).toEqual([
      "original_problem_version_id",
      "effective_problem_version_id",
      "rejudge_batch_id",
      "effective_at",
    ]);
    expect(columns(database, "submissions")).toEqual(expect.arrayContaining([
      "admitted_at",
      "rejudge_batch_id",
      "rejudge_of_submission_id",
      "source_erased_at",
    ]));
    expect(columns(database, "rejudge_jobs")).toEqual(expect.arrayContaining([
      "old_submission_id",
      "new_submission_id",
      "state",
      "erasure_excluded_at",
      "workflow_payload_json",
    ]));
    expect(columns(database, "submission_events")).toEqual([
      "id",
      "submission_id",
      "event_key",
      "payload_json",
      "created_at",
    ]);
    expect(columns(database, "effective_rejudges")).toEqual([
      "old_submission_id",
      "rejudge_batch_id",
      "new_submission_id",
      "became_effective_at",
    ]);
    for (const removed of [
      "formal_submission_admissions",
      "verified_solves",
      "rejudge_verified_solves",
      "submission_owner_erasure_fences",
      "submission_outbox",
      "rejudge_result_outbox",
      "core_outbox",
    ]) {
      expect(database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(removed)).toBeUndefined();
    }
    expect(columns(database, "outbox")).toEqual([
      "id",
      "kind",
      "aggregate_id",
      "payload_json",
      "created_at",
      "delivered_at",
      "attempts",
      "last_error",
    ]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
