import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FINALIZE_SUBMISSION_ATTEMPT_SQL,
  FINALIZE_SUBMISSION_SQL,
  finalizedSubmissionAttemptMatches,
  type FinalizedSubmissionAttemptRecord,
} from "./submission-finalization";

const SUBMISSION_ID = "0198dbd3-5c00-7000-8000-000000000301";
const USER_ID = "0198dbd3-5c00-7000-8000-000000000302";
const PROBLEM_ID = "0198dbd3-5c00-7000-8000-000000000303";
const DIGEST = "a".repeat(64);
const TOKEN_HASH = "b".repeat(64);
const NOW = "2026-08-09T00:00:00.000Z";
const AUDIT_KEY = `audits/${SUBMISSION_ID}/1.${DIGEST}.json`;

function database(): DatabaseSync {
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
     visibility, created_at, updated_at)
    VALUES (?, ?, ?, 'c', 'wasip1', 'release', 'main.c', 'source', ?, ?, ?, 'running', 'private', ?, ?)`)
    .run(SUBMISSION_ID, USER_ID, PROBLEM_ID, DIGEST, PROBLEM_ID, DIGEST, NOW, NOW);
  database.prepare("INSERT INTO submission_attempts (submission_id, attempt, token_hash, container_key, state, started_at, audit_r2_key) VALUES (?, 1, ?, ?, 'running', ?, ?)")
    .run(SUBMISSION_ID, TOKEN_HASH, SUBMISSION_ID, NOW, AUDIT_KEY);
  return database;
}

function finalize(database: DatabaseSync, suffix: string): readonly number[] {
  database.exec("BEGIN IMMEDIATE");
  try {
    const submission = database.prepare(FINALIZE_SUBMISSION_SQL)
      .run("completed", 100, 10, 1234, 4096, 1, NOW, NOW, SUBMISSION_ID, 1, SUBMISSION_ID, SUBMISSION_ID, 1, TOKEN_HASH);
    const attempt = database.prepare(FINALIZE_SUBMISSION_ATTEMPT_SQL)
      .run(NOW, SUBMISSION_ID, 1, TOKEN_HASH, AUDIT_KEY, AUDIT_KEY, SUBMISSION_ID, 1, "completed");
    const terminal = database.prepare("INSERT OR IGNORE INTO submission_events (submission_id, event_key, payload_json, created_at) SELECT ?, 'attempt:1:terminal', ?, ? WHERE EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='completed' AND effective_attempt=1)")
      .run(SUBMISSION_ID, JSON.stringify({ kind: "state", state: "completed" }), NOW, SUBMISSION_ID);
    const profile = database.prepare("INSERT OR IGNORE INTO submission_outbox (id, submission_id, kind, payload_json, created_at) SELECT ?, ?, 'update-profile', '{}', ? WHERE EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='completed' AND effective_attempt=1)")
      .run(`profile-${suffix}`, SUBMISSION_ID, NOW, SUBMISSION_ID);
    database.exec("COMMIT");
    return [submission.changes, attempt.changes, terminal.changes, profile.changes].map(Number);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

describe("submission result finalization", () => {
  it("treats a response-loss replay as exact and preserves one terminal/projection set", () => {
    const db = database();
    expect(finalize(db, "first")).toEqual([1, 1, 1, 1]);
    expect(finalize(db, "replay")).toEqual([0, 0, 0, 0]);
    const record = db.prepare(`SELECT submissions.state, submissions.score, submissions.fully_passed_cases,
        submissions.deterministic_cost, submissions.peak_memory_bytes, submissions.effective_attempt,
        submission_attempts.state AS attempt_state, submission_attempts.token_hash, submission_attempts.audit_r2_key
      FROM submissions JOIN submission_attempts ON submission_attempts.submission_id=submissions.id
      WHERE submissions.id=? AND submission_attempts.attempt=1`).get(SUBMISSION_ID) as unknown as FinalizedSubmissionAttemptRecord;
    expect(finalizedSubmissionAttemptMatches(record, {
      state: "completed",
      score: 100,
      fullyPassedCases: 10,
      deterministicCost: 1234,
      peakMemoryBytes: 4096,
      attempt: 1,
      tokenHash: TOKEN_HASH,
      auditR2Key: AUDIT_KEY,
    })).toBe(true);
    expect(db.prepare("SELECT kind, COUNT(*) AS count FROM submission_outbox GROUP BY kind ORDER BY kind").all()).toEqual([
      { kind: "update-profile", count: 1 },
    ]);
    expect(db.prepare("SELECT event_key, payload_json FROM submission_events WHERE submission_id=?").all(SUBMISSION_ID)).toEqual([
      { event_key: "attempt:1:terminal", payload_json: JSON.stringify({ kind: "state", state: "completed" }) },
    ]);
    expect(record.audit_r2_key).toBe(AUDIT_KEY);
  });
});
