import { DatabaseSync } from "node:sqlite";
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
  database.exec(`CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    managed_problem_version_id TEXT NOT NULL,
    language TEXT NOT NULL,
    target TEXT NOT NULL,
    optimization TEXT NOT NULL,
    entry_path TEXT NOT NULL,
    source_r2_key TEXT NOT NULL,
    source_digest TEXT NOT NULL,
    forge_release_id TEXT NOT NULL,
    forge_manifest_sha256 TEXT NOT NULL,
    state TEXT NOT NULL,
    verdict TEXT,
    visibility TEXT NOT NULL,
    score REAL,
    fully_passed_cases INTEGER,
    deterministic_cost INTEGER,
    peak_memory_bytes INTEGER,
    effective_attempt INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;
  CREATE TABLE submission_attempts (
    submission_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    container_key TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    audit_r2_key TEXT,
    PRIMARY KEY (submission_id, attempt)
  ) STRICT;
  CREATE TABLE submission_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id TEXT NOT NULL,
    event_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (submission_id, event_key)
  ) STRICT;`);
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

function finalize(database: DatabaseSync): readonly number[] {
  database.exec("BEGIN IMMEDIATE");
  try {
    const submission = database.prepare(FINALIZE_SUBMISSION_SQL)
      .run("completed", "accepted", 100, 10, 1234, 4096, 1, NOW, NOW, SUBMISSION_ID, 1, SUBMISSION_ID, SUBMISSION_ID, 1, TOKEN_HASH);
    const attempt = database.prepare(FINALIZE_SUBMISSION_ATTEMPT_SQL)
      .run(NOW, SUBMISSION_ID, 1, TOKEN_HASH, AUDIT_KEY, AUDIT_KEY, SUBMISSION_ID, 1, "completed");
    const terminal = database.prepare("INSERT OR IGNORE INTO submission_events (submission_id, event_key, payload_json, created_at) SELECT ?, 'attempt:1:terminal', ?, ? WHERE EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='completed' AND effective_attempt=1)")
      .run(SUBMISSION_ID, JSON.stringify({ kind: "state", state: "completed" }), NOW, SUBMISSION_ID);
    database.exec("COMMIT");
    return [submission.changes, attempt.changes, terminal.changes].map(Number);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

describe("submission result finalization", () => {
  it("treats a response-loss replay as exact and preserves one terminal event", () => {
    const db = database();
    expect(finalize(db)).toEqual([1, 1, 1]);
    expect(finalize(db)).toEqual([0, 0, 0]);
    const record = db.prepare(`SELECT submissions.state, submissions.verdict, submissions.score, submissions.fully_passed_cases,
        submissions.deterministic_cost, submissions.peak_memory_bytes, submissions.effective_attempt,
        submission_attempts.state AS attempt_state, submission_attempts.token_hash, submission_attempts.audit_r2_key
      FROM submissions JOIN submission_attempts ON submission_attempts.submission_id=submissions.id
      WHERE submissions.id=? AND submission_attempts.attempt=1`).get(SUBMISSION_ID) as unknown as FinalizedSubmissionAttemptRecord;
    expect(finalizedSubmissionAttemptMatches(record, {
      state: "completed",
      verdict: "accepted",
      score: 100,
      fullyPassedCases: 10,
      deterministicCost: 1234,
      peakMemoryBytes: 4096,
      attempt: 1,
      tokenHash: TOKEN_HASH,
      auditR2Key: AUDIT_KEY,
    })).toBe(true);
    expect(db.prepare("SELECT event_key, payload_json FROM submission_events WHERE submission_id=?").all(SUBMISSION_ID)).toEqual([
      { event_key: "attempt:1:terminal", payload_json: JSON.stringify({ kind: "state", state: "completed" }) },
    ]);
    expect(record.audit_r2_key).toBe(AUDIT_KEY);
  });
});
