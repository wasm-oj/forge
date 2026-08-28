import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ERASURE_WORKFLOW_SUBMISSION_IDS_SQL,
  BEGIN_SOURCE_ERASURE_SQL,
  CANCEL_ERASURE_ATTEMPTS_SQL,
  CANCEL_ERASURE_OUTBOX_SQL,
  CANCEL_ERASURE_PROMPT_ATTEMPTS_SQL,
  CANCEL_ERASURE_REJUDGE_WORK_SQL,
  CANCEL_ERASURE_SUBMISSIONS_SQL,
  INVALIDATE_ERASURE_PROMPT_QUOTA_SQL,
  RECORD_ERASURE_CANCELLATION_EVENTS_SQL,
  RECORD_ERASURE_PROMPT_EVENTS_SQL,
  TOMBSTONE_ERASURE_PROMPTS_SQL,
} from "./account-erasure";

const USER_ID = "0198dbd3-5c00-7000-8000-000000000502";
const ANONYMOUS_ID = "erased-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SUBMISSION_ID = "0198dbd3-5c00-7000-8000-000000000501";
const SOURCE_ID = "0198dbd3-5c00-7000-8000-000000000503";
const ENTRANT_ID = "0198dbd3-5c00-7000-8000-000000000504";
const ACTIVE_PROMPT_ATTEMPT_ID = "0198dbd3-5c00-7000-8000-000000000505";
const TERMINAL_PROMPT_ATTEMPT_ID = "0198dbd3-5c00-7000-8000-000000000506";
const NOW = "2026-08-09T00:00:00.000Z";
const DIGEST = "a".repeat(64);
const GENERATED_SOURCE_DIGEST = "b".repeat(64);

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, erasure_epoch INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE account_erasure_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE) STRICT;
    CREATE TABLE submission_sources (
      id TEXT PRIMARY KEY, owner_user_id TEXT, admission_erasure_epoch INTEGER NOT NULL,
      content_sha256 TEXT, bytes INTEGER, state TEXT NOT NULL,
      erasure_requested_at TEXT, erasure_next_attempt_at TEXT, erasure_last_error TEXT
    ) STRICT;
    CREATE TABLE submissions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source_id TEXT NOT NULL,
      state TEXT NOT NULL, verdict TEXT, score REAL, fully_passed_cases INTEGER,
      updated_at TEXT NOT NULL, completed_at TEXT, visibility TEXT NOT NULL
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
      user_id TEXT NOT NULL, state TEXT NOT NULL, result_state TEXT, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE workflow_outbox (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, submission_id TEXT,
      last_error TEXT, updated_at TEXT NOT NULL, settled_at TEXT
    ) STRICT;
    CREATE TABLE contest_entrants (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE prompt_attempts (
      id TEXT PRIMARY KEY, entrant_id TEXT NOT NULL,
      state TEXT NOT NULL, failure_code TEXT, terminal_at TEXT,
      eligibility TEXT NOT NULL, invalidated_at TEXT, invalidation_reason TEXT,
      updated_at TEXT NOT NULL,
      prompt_text TEXT, prompt_bytes INTEGER, prompt_sha256 TEXT,
      generated_source_id TEXT, generated_source_sha256 TEXT, erased_at TEXT,
      CHECK (
        (erased_at IS NULL AND prompt_text IS NOT NULL AND prompt_bytes IS NOT NULL
          AND prompt_sha256 IS NOT NULL)
        OR (erased_at IS NOT NULL AND prompt_text IS NULL AND prompt_bytes IS NULL
          AND prompt_sha256 IS NULL)
      ),
      CHECK (
        (generated_source_id IS NULL AND generated_source_sha256 IS NULL)
        OR (generated_source_id IS NOT NULL AND generated_source_sha256 IS NOT NULL)
        OR (erased_at IS NOT NULL AND generated_source_id IS NOT NULL
          AND generated_source_sha256 IS NULL)
      )
    ) STRICT;
    CREATE TRIGGER prompt_attempt_erasure_guard
    BEFORE UPDATE OF prompt_text, prompt_bytes, prompt_sha256, erased_at ON prompt_attempts
    WHEN NOT (
      OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL
      AND NEW.prompt_text IS NULL AND NEW.prompt_bytes IS NULL AND NEW.prompt_sha256 IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'prompt contents may change only during one-way erasure');
    END;
    CREATE TRIGGER prompt_attempt_source_once
    BEFORE UPDATE OF generated_source_id, generated_source_sha256 ON prompt_attempts
    WHEN OLD.generated_source_id IS NOT NULL
      AND (NEW.generated_source_id IS NOT OLD.generated_source_id
        OR NEW.generated_source_sha256 IS NOT OLD.generated_source_sha256)
      AND NOT (NEW.erased_at IS NOT NULL AND NEW.generated_source_id IS OLD.generated_source_id
        AND NEW.generated_source_sha256 IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'prompt generated source is immutable');
    END;
    CREATE TABLE prompt_attempt_quota (
      prompt_attempt_id TEXT PRIMARY KEY, state TEXT NOT NULL,
      settled_at TEXT, settlement_reason TEXT
    ) STRICT;
    CREATE TABLE prompt_attempt_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, prompt_attempt_id TEXT NOT NULL,
      event_key TEXT NOT NULL, event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (prompt_attempt_id, event_key)
    ) STRICT;
    CREATE TABLE formal_risk_allowances (user_id TEXT NOT NULL) STRICT;`);
  db.prepare("INSERT INTO users (id, status, erasure_epoch) VALUES (?, 'active', 0)").run(USER_ID);
  db.prepare("INSERT INTO contest_entrants (id, owner_user_id) VALUES (?, ?)").run(ENTRANT_ID, USER_ID);
  db.prepare(`INSERT INTO prompt_attempts
      (id, entrant_id, state, eligibility, updated_at, prompt_text, prompt_bytes,
       prompt_sha256, generated_source_id, generated_source_sha256)
    VALUES (?, ?, 'generating', 'eligible', ?, 'private active prompt', 21, ?, NULL, NULL)`)
    .run(ACTIVE_PROMPT_ATTEMPT_ID, ENTRANT_ID, NOW, DIGEST);
  db.prepare(`INSERT INTO prompt_attempts
      (id, entrant_id, state, eligibility, updated_at, prompt_text, prompt_bytes,
       prompt_sha256, generated_source_id, generated_source_sha256)
    VALUES (?, ?, 'submitted', 'eligible', ?, 'private terminal prompt', 23, ?, ?, ?)`)
    .run(TERMINAL_PROMPT_ATTEMPT_ID, ENTRANT_ID, NOW, DIGEST, SOURCE_ID, GENERATED_SOURCE_DIGEST);
  db.prepare("INSERT INTO prompt_attempt_quota (prompt_attempt_id, state) VALUES (?, 'reserved')")
    .run(ACTIVE_PROMPT_ATTEMPT_ID);
  db.prepare(`INSERT INTO prompt_attempt_quota
      (prompt_attempt_id, state, settled_at, settlement_reason)
    VALUES (?, 'consumed', ?, 'response-received')`)
    .run(TERMINAL_PROMPT_ATTEMPT_ID, NOW);
  return db;
}

function admit(db: DatabaseSync): number {
  db.exec("BEGIN IMMEDIATE");
  try {
    const source = db.prepare(`INSERT INTO submission_sources
        (id, owner_user_id, admission_erasure_epoch, content_sha256, bytes, state)
      SELECT ?, id, erasure_epoch, ?, 12, 'ready' FROM users
       WHERE id=? AND status='active'
         AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=users.id)`)
      .run(SOURCE_ID, DIGEST, USER_ID);
    const submission = db.prepare(`INSERT INTO submissions
        (id, user_id, source_id, state, updated_at, visibility)
      SELECT ?, ?, ?, 'queued', ?, 'private'
       WHERE EXISTS (SELECT 1 FROM submission_sources WHERE id=? AND state='ready')`)
      .run(SUBMISSION_ID, USER_ID, SOURCE_ID, NOW, SOURCE_ID);
    if (submission.changes === 1) {
      db.prepare("INSERT INTO submission_attempts (submission_id, attempt, state) VALUES (?, 1, 'created')")
        .run(SUBMISSION_ID);
      db.prepare("INSERT INTO workflow_outbox (id, state, submission_id, updated_at) VALUES ('workflow', 'pending', ?, ?)")
        .run(SUBMISSION_ID, NOW);
      db.prepare("INSERT INTO rejudge_jobs (user_id, state, updated_at) VALUES (?, 'dispatched', ?)")
        .run(USER_ID, NOW);
      db.prepare("INSERT INTO formal_risk_allowances (user_id) VALUES (?)").run(USER_ID);
    }
    db.exec("COMMIT");
    return Number(source.changes && submission.changes);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function erase(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO account_erasure_jobs (id, user_id) VALUES ('erasure', ?)").run(USER_ID);
    db.prepare("UPDATE users SET status='suspended', erasure_epoch=erasure_epoch+1 WHERE id=?").run(USER_ID);
    db.prepare(CANCEL_ERASURE_SUBMISSIONS_SQL).run(NOW, NOW, USER_ID, ANONYMOUS_ID);
    db.prepare(CANCEL_ERASURE_ATTEMPTS_SQL).run(NOW, USER_ID, ANONYMOUS_ID);
    db.prepare(RECORD_ERASURE_CANCELLATION_EVENTS_SQL).run(NOW, USER_ID, ANONYMOUS_ID);
    db.prepare(CANCEL_ERASURE_REJUDGE_WORK_SQL).run(NOW, USER_ID, ANONYMOUS_ID);
    db.prepare(CANCEL_ERASURE_OUTBOX_SQL).run(NOW, NOW, USER_ID, ANONYMOUS_ID);
    db.prepare(CANCEL_ERASURE_PROMPT_ATTEMPTS_SQL)
      .run(NOW, NOW, NOW, USER_ID, ANONYMOUS_ID);
    db.prepare(INVALIDATE_ERASURE_PROMPT_QUOTA_SQL).run(NOW, USER_ID, ANONYMOUS_ID);
    db.prepare(TOMBSTONE_ERASURE_PROMPTS_SQL).run(NOW, NOW, USER_ID, ANONYMOUS_ID);
    db.prepare(RECORD_ERASURE_PROMPT_EVENTS_SQL).run(NOW, USER_ID, ANONYMOUS_ID);
    db.prepare("DELETE FROM formal_risk_allowances WHERE user_id IN (?, ?)").run(USER_ID, ANONYMOUS_ID);
    db.prepare(BEGIN_SOURCE_ERASURE_SQL).run(NOW, NOW, USER_ID);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("single-D1 submission / account-erasure ordering", () => {
  it("closes admission and clears source identity before the R2 tombstone when admission wins", () => {
    const db = database();
    expect(admit(db)).toBe(1);
    erase(db);

    expect(db.prepare("SELECT state, content_sha256, bytes, erasure_requested_at, erasure_next_attempt_at FROM submission_sources WHERE id=?").get(SOURCE_ID)).toEqual({
      state: "erasing",
      content_sha256: null,
      bytes: null,
      erasure_requested_at: NOW,
      erasure_next_attempt_at: NOW,
    });
    expect(db.prepare("SELECT state, verdict, completed_at FROM submissions WHERE id=?").get(SUBMISSION_ID)).toEqual({
      state: "cancelled",
      verdict: "cancelled",
      completed_at: NOW,
    });
    expect(db.prepare("SELECT state, failure_code FROM submission_attempts WHERE submission_id=?").get(SUBMISSION_ID)).toEqual({
      state: "cancelled",
      failure_code: "account-erasure",
    });
    expect(db.prepare("SELECT state, last_error FROM workflow_outbox WHERE id='workflow'").get()).toEqual({
      state: "cancelled",
      last_error: "account-erasure",
    });
    expect(db.prepare("SELECT state, result_state FROM rejudge_jobs").get()).toEqual({
      state: "cancelled",
      result_state: "cancelled",
    });
  });

  it("rejects a late source reservation when the erasure epoch transaction wins", () => {
    const db = database();
    erase(db);
    expect(admit(db)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM submission_sources").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT status, erasure_epoch FROM users WHERE id=?").get(USER_ID)).toEqual({
      status: "suspended",
      erasure_epoch: 1,
    });
  });

  it("looks up Workflows only for attempts that account erasure actively cancelled", () => {
    const db = database();
    expect(admit(db)).toBe(1);
    for (let index = 0; index < 1_000; index += 1) {
      const id = `terminal-${index.toString().padStart(4, "0")}`;
      db.prepare(`INSERT INTO submissions
          (id, user_id, source_id, state, verdict, score, fully_passed_cases, updated_at, completed_at, visibility)
        VALUES (?, ?, ?, 'completed', 'accepted', 100, 1, ?, ?, 'private')`)
        .run(id, USER_ID, SOURCE_ID, NOW, NOW);
      db.prepare(`INSERT INTO submission_attempts
          (submission_id, attempt, state, finished_at)
        VALUES (?, 1, 'succeeded', ?)`)
        .run(id, NOW);
    }

    erase(db);
    const rows = db.prepare(ACCOUNT_ERASURE_WORKFLOW_SUBMISSION_IDS_SQL)
      .all(USER_ID, ANONYMOUS_ID);
    expect(rows).toEqual([{ id: SUBMISSION_ID }]);
  });

  it("one-way tombstones every prompt and generated-source digest in the first transaction", () => {
    const db = database();
    erase(db);

    expect(db.prepare(`SELECT id, state, eligibility, failure_code, prompt_text,
        prompt_bytes, prompt_sha256, generated_source_id, generated_source_sha256, erased_at
      FROM prompt_attempts ORDER BY id`).all()).toEqual([
      {
        id: ACTIVE_PROMPT_ATTEMPT_ID,
        state: "cancelled",
        eligibility: "invalid",
        failure_code: "account-erasure",
        prompt_text: null,
        prompt_bytes: null,
        prompt_sha256: null,
        generated_source_id: null,
        generated_source_sha256: null,
        erased_at: NOW,
      },
      {
        id: TERMINAL_PROMPT_ATTEMPT_ID,
        state: "submitted",
        eligibility: "eligible",
        failure_code: null,
        prompt_text: null,
        prompt_bytes: null,
        prompt_sha256: null,
        generated_source_id: SOURCE_ID,
        generated_source_sha256: null,
        erased_at: NOW,
      },
    ]);
    expect(db.prepare(`SELECT prompt_attempt_id, state, settlement_reason
      FROM prompt_attempt_quota ORDER BY prompt_attempt_id`).all()).toEqual([
      {
        prompt_attempt_id: ACTIVE_PROMPT_ATTEMPT_ID,
        state: "invalid",
        settlement_reason: "account-erasure",
      },
      {
        prompt_attempt_id: TERMINAL_PROMPT_ATTEMPT_ID,
        state: "consumed",
        settlement_reason: "response-received",
      },
    ]);
    expect(db.prepare(`SELECT prompt_attempt_id, event_key, event_type, payload_json
      FROM prompt_attempt_events ORDER BY prompt_attempt_id`).all()).toEqual([
      {
        prompt_attempt_id: ACTIVE_PROMPT_ATTEMPT_ID,
        event_key: "privacy:erased",
        event_type: "erased",
        payload_json: "{}",
      },
      {
        prompt_attempt_id: TERMINAL_PROMPT_ATTEMPT_ID,
        event_key: "privacy:erased",
        event_type: "erased",
        payload_json: "{}",
      },
    ]);

    db.exec("BEGIN IMMEDIATE");
    db.prepare(TOMBSTONE_ERASURE_PROMPTS_SQL).run(NOW, NOW, USER_ID, ANONYMOUS_ID);
    db.prepare(RECORD_ERASURE_PROMPT_EVENTS_SQL).run(NOW, USER_ID, ANONYMOUS_ID);
    db.exec("COMMIT");
    expect(db.prepare("SELECT COUNT(*) AS count FROM prompt_attempt_events").get()).toEqual({ count: 2 });
  });
});
