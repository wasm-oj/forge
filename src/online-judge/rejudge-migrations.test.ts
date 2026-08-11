import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";

function applyMigrations(database: DatabaseSync, directory: "core" | "submissions", names: readonly string[]): void {
  for (const name of names) {
    database.exec(readFileSync(path.join(process.cwd(), "migrations", directory, name), "utf8"));
  }
}

function columns(database: DatabaseSync, table: string): readonly string[] {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

describe("rejudge D1 migrations", () => {
  it("applies the additive CORE_DB chain with an immutable activation pointer", () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, "core", [
      "0001_initial.sql",
      "0002_managed_compile_profiles.sql",
      "0003_organizer_application_invariants.sql",
      "0004_release_trust.sql",
      "0005_rejudge_pipeline.sql",
    ]);
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
    expect(columns(database, "formal_submission_admissions")).toEqual([
      "submission_id",
      "managed_problem_version_id",
      "user_id",
      "state",
      "source_r2_key",
      "source_sha256",
      "cleanup_state",
      "created_at",
      "expires_at",
      "updated_at",
    ]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("applies the SUBMISSIONS_DB chain with D1 events and no reservation state", () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, "submissions", [
      "0001_initial.sql",
      "0002_rejudge_pipeline.sql",
      "0003_account_erasure_fence.sql",
      "0004_projection_outbox_uniqueness.sql",
      "0005_formal_admission_claim.sql",
      "0006_d1_submission_events_capacity.sql",
      "0007_leaderboard_indexes.sql",
    ]);
    expect(columns(database, "submissions")).toEqual(expect.arrayContaining(["rejudge_batch_id", "rejudge_of_submission_id", "source_erased_at"]));
    expect(columns(database, "rejudge_jobs")).toEqual(expect.arrayContaining([
      "old_submission_id",
      "new_submission_id",
      "state",
      "erasure_excluded_at",
      "workflow_payload_json",
    ]));
    expect(columns(database, "submissions")).not.toContain("reservation_released_at");
    expect(columns(database, "rejudge_jobs")).not.toContain("reservation_released_at");
    expect(columns(database, "submission_events")).toEqual(["id", "submission_id", "event_key", "payload_json", "created_at"]);
    expect(columns(database, "submission_owner_erasure_fences")).toEqual([
      "owner_user_id",
      "erasure_job_id",
      "anonymous_user_id",
      "fenced_at",
    ]);
    expect(columns(database, "effective_rejudges")).toEqual([
      "old_submission_id",
      "rejudge_batch_id",
      "new_submission_id",
      "became_effective_at",
    ]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
