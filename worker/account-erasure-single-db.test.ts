import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CANCEL_ERASURE_ATTEMPTS_SQL,
  CANCEL_ERASURE_REJUDGE_WORK_SQL,
  CANCEL_ERASURE_SUBMISSIONS_SQL,
  RECORD_ERASURE_CANCELLATION_EVENTS_SQL,
  SCRUB_ERASURE_OUTBOX_SQL,
} from "./account-erasure";

const USER_ID = "0198dbd3-5c00-7000-8000-000000000502";
const ANONYMOUS_ID = "erased-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SUBMISSION_ID = "0198dbd3-5c00-7000-8000-000000000501";
const NOW = "2026-08-09T00:00:00.000Z";

const ADMIT_SQL = `INSERT INTO submissions (id, user_id, state, updated_at)
  SELECT ?, ?, 'queued', ?
  WHERE EXISTS (SELECT 1 FROM users WHERE id=? AND status='active')
    AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=?)`;

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
    CREATE TABLE account_erasure_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE) STRICT;
    CREATE TABLE submissions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, state TEXT NOT NULL,
      updated_at TEXT NOT NULL, completed_at TEXT
    ) STRICT;
    CREATE TABLE submission_attempts (
      submission_id TEXT NOT NULL, attempt INTEGER NOT NULL, state TEXT NOT NULL,
      finished_at TEXT, PRIMARY KEY (submission_id, attempt)
    ) STRICT;
    CREATE TABLE submission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id TEXT NOT NULL,
      event_key TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (submission_id, event_key)
    ) STRICT;
    CREATE TABLE rejudge_jobs (
      old_submission_id TEXT NOT NULL, new_submission_id TEXT NOT NULL,
      state TEXT NOT NULL, result_state TEXT, erasure_excluded_at TEXT,
      workflow_payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, aggregate_id TEXT NOT NULL,
      payload_json TEXT NOT NULL, delivered_at TEXT, last_error TEXT
    ) STRICT;
    CREATE TABLE formal_risk_allowances (user_id TEXT NOT NULL) STRICT;`);
  db.prepare("INSERT INTO users (id, status) VALUES (?, 'active')").run(USER_ID);
  return db;
}

function admit(db: DatabaseSync): number {
  const inserted = db.prepare(ADMIT_SQL).run(SUBMISSION_ID, USER_ID, NOW, USER_ID, USER_ID);
  if (inserted.changes === 1) {
    db.prepare("INSERT INTO submission_attempts (submission_id, attempt, state) VALUES (?, 1, 'created')")
      .run(SUBMISSION_ID);
    db.prepare("INSERT INTO outbox (id, kind, aggregate_id, payload_json) VALUES ('workflow', 'start-submission-workflow', ?, '{\"secret\":true}')")
      .run(SUBMISSION_ID);
    db.prepare("INSERT INTO rejudge_jobs (old_submission_id, new_submission_id, state, workflow_payload_json, updated_at) VALUES (?, ?, 'dispatched', '{\"secret\":true}', ?)")
      .run(SUBMISSION_ID, SUBMISSION_ID, NOW);
    db.prepare("INSERT INTO formal_risk_allowances (user_id) VALUES (?)").run(USER_ID);
  }
  return Number(inserted.changes);
}

function erase(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO account_erasure_jobs (id, user_id) VALUES ('erasure', ?)").run(USER_ID);
    db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(USER_ID);
    db.prepare(CANCEL_ERASURE_SUBMISSIONS_SQL).run(NOW, NOW, USER_ID, ANONYMOUS_ID);
    db.prepare(CANCEL_ERASURE_ATTEMPTS_SQL).run(NOW, USER_ID, ANONYMOUS_ID);
    db.prepare(RECORD_ERASURE_CANCELLATION_EVENTS_SQL).run(NOW, USER_ID, ANONYMOUS_ID);
    db.prepare(CANCEL_ERASURE_REJUDGE_WORK_SQL)
      .run(NOW, NOW, USER_ID, ANONYMOUS_ID, USER_ID, ANONYMOUS_ID);
    db.prepare(SCRUB_ERASURE_OUTBOX_SQL).run(NOW, USER_ID, ANONYMOUS_ID);
    db.prepare("DELETE FROM formal_risk_allowances WHERE user_id IN (?, ?)").run(USER_ID, ANONYMOUS_ID);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("single-D1 submission / account-erasure ordering", () => {
  it("cancels and scrubs all owned work when admission commits first", () => {
    const db = database();
    expect(admit(db)).toBe(1);
    erase(db);

    expect(db.prepare("SELECT state, completed_at FROM submissions WHERE id=?").get(SUBMISSION_ID)).toEqual({
      state: "cancelled",
      completed_at: NOW,
    });
    expect(db.prepare("SELECT state, finished_at FROM submission_attempts WHERE submission_id=?").get(SUBMISSION_ID)).toEqual({
      state: "cancelled",
      finished_at: NOW,
    });
    expect(db.prepare("SELECT payload_json, delivered_at, last_error FROM outbox WHERE id='workflow'").get()).toEqual({
      payload_json: "{}",
      delivered_at: NOW,
      last_error: "account-erasure",
    });
    expect(db.prepare("SELECT state, result_state, erasure_excluded_at, workflow_payload_json FROM rejudge_jobs").get()).toEqual({
      state: "cancelled",
      result_state: "cancelled",
      erasure_excluded_at: NOW,
      workflow_payload_json: "{}",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM formal_risk_allowances").get()).toEqual({ count: 0 });
  });

  it("prevents admission when the erasure transaction commits first", () => {
    const db = database();
    erase(db);
    expect(admit(db)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM submissions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT status FROM users WHERE id=?").get(USER_ID)).toEqual({ status: "suspended" });
  });
});
