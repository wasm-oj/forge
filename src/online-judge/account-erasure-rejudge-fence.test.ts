import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANCEL_ERASURE_ATTEMPTS_SQL,
  CANCEL_ERASURE_REJUDGE_WORK_SQL,
  CANCEL_ERASURE_SUBMISSIONS_SQL,
  SCRUB_ERASURE_REJUDGE_RESULT_OUTBOX_SQL,
  SCRUB_ERASURE_SUBMISSION_OUTBOX_SQL,
  UPSERT_SUBMISSION_OWNER_ERASURE_FENCE_SQL,
} from "../../worker/account-erasure";
import {
  CLAIM_REJUDGE_JOB_SQL,
  CLAIM_REJUDGE_OUTBOX_SQL,
  erasureAdjustedExpectedCount,
  MATERIALIZE_REJUDGE_ATTEMPT_SQL,
  MATERIALIZE_REJUDGE_JOB_SQL,
  MATERIALIZE_REJUDGE_SUBMISSION_SQL,
  UPSERT_REJUDGE_VERIFIED_SOLVE_SQL,
} from "../../worker/rejudge";

const USER_ID = "0198dbd3-5c00-7000-8000-000000000001";
const ANONYMOUS_USER_ID = "erased-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORIGINAL_ID = "0198dbd3-5c00-7000-8000-000000000002";
const CHILD_ID = "0198dbd3-5c00-7000-8000-000000000003";
const BATCH_ID = "0198dbd3-5c00-7000-8000-000000000004";
const JOB_ID = "0198dbd3-5c00-7000-8000-000000000005";
const OLD_VERSION_ID = "0198dbd3-5c00-7000-8000-000000000006";
const NEW_VERSION_ID = "0198dbd3-5c00-7000-8000-000000000007";
const NOW = "2026-08-09T00:00:00.000Z";
const SHA256 = "a".repeat(64);

function database(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const migration of ["0001_initial.sql", "0002_rejudge_pipeline.sql", "0003_account_erasure_fence.sql"]) {
    database.exec(readFileSync(path.join(process.cwd(), "migrations", "submissions", migration), "utf8"));
  }
  return database;
}

function insertOriginal(database: DatabaseSync, state = "completed"): void {
  database.prepare(`INSERT INTO submissions (
    id, user_id, managed_problem_version_id, language, target, optimization,
    entry_path, source_r2_key, source_digest, forge_release_id,
    forge_manifest_sha256, state, visibility, created_at, updated_at, completed_at
  ) VALUES (?, ?, ?, 'c', 'wasip1', 'release', 'main.c', ?, ?, 'forge-release', ?, ?, 'private', ?, ?, ?)`)
    .run(ORIGINAL_ID, USER_ID, OLD_VERSION_ID, `formal-sources/${SHA256}`, SHA256, SHA256, state, NOW, NOW, state === "completed" ? NOW : null);
}

function materializeCapturedSource(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(MATERIALIZE_REJUDGE_SUBMISSION_SQL).run(
      CHILD_ID,
      NEW_VERSION_ID,
      "forge-release",
      SHA256,
      NOW,
      NOW,
      BATCH_ID,
      ORIGINAL_ID,
      USER_ID,
      OLD_VERSION_ID,
      `formal-sources/${SHA256}`,
      SHA256,
    );
    database.prepare(MATERIALIZE_REJUDGE_ATTEMPT_SQL).run(SHA256, `${CHILD_ID}:1`, CHILD_ID, BATCH_ID);
    database.prepare(MATERIALIZE_REJUDGE_JOB_SQL).run(
      BATCH_ID,
      OLD_VERSION_ID,
      NEW_VERSION_ID,
      JSON.stringify({ initialize: { ownerUserId: USER_ID }, parameters: { userId: USER_ID } }),
      NOW,
      NOW,
      CHILD_ID,
      BATCH_ID,
      ORIGINAL_ID,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function fenceAndCancel(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(UPSERT_SUBMISSION_OWNER_ERASURE_FENCE_SQL).run(USER_ID, JOB_ID, ANONYMOUS_USER_ID, NOW);
    database.prepare(UPSERT_SUBMISSION_OWNER_ERASURE_FENCE_SQL).run(ANONYMOUS_USER_ID, JOB_ID, ANONYMOUS_USER_ID, NOW);
    database.prepare(CANCEL_ERASURE_SUBMISSIONS_SQL).run(NOW, NOW, USER_ID, ANONYMOUS_USER_ID);
    database.prepare(CANCEL_ERASURE_ATTEMPTS_SQL).run(NOW, USER_ID, ANONYMOUS_USER_ID);
    database.prepare(CANCEL_ERASURE_REJUDGE_WORK_SQL).run(NOW, NOW, USER_ID, ANONYMOUS_USER_ID, USER_ID, ANONYMOUS_USER_ID);
    database.prepare(SCRUB_ERASURE_SUBMISSION_OUTBOX_SQL).run(NOW, USER_ID, ANONYMOUS_USER_ID);
    database.prepare(SCRUB_ERASURE_REJUDGE_RESULT_OUTBOX_SQL).run(NOW, USER_ID, ANONYMOUS_USER_ID, USER_ID, ANONYMOUS_USER_ID);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function coreProjectionDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
    CREATE TABLE account_erasure_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL) STRICT;
    CREATE TABLE rejudge_verified_solves (
      rejudge_batch_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      managed_problem_version_id TEXT NOT NULL,
      effective_submission_id TEXT NOT NULL,
      score REAL NOT NULL CHECK (score=100),
      solved_at TEXT NOT NULL,
      PRIMARY KEY (rejudge_batch_id, user_id)
    ) STRICT;`);
  db.prepare("INSERT INTO users (id, status) VALUES (?, 'active')").run(USER_ID);
  return db;
}

function projectVerifiedSolve(db: DatabaseSync): number {
  return Number(db.prepare(UPSERT_REJUDGE_VERIFIED_SOLVE_SQL).run(
    BATCH_ID,
    USER_ID,
    NEW_VERSION_ID,
    CHILD_ID,
    NOW,
    USER_ID,
    USER_ID,
  ).changes);
}

function commitCoreErasure(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO account_erasure_jobs (id, user_id) VALUES (?, ?)").run(JOB_ID, USER_ID);
  db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(USER_ID);
  db.prepare("DELETE FROM rejudge_verified_solves WHERE user_id=?").run(USER_ID);
  db.exec("COMMIT");
}

describe("account erasure / rejudge D1 fence", () => {
  it("prevents a source captured before erasure from materializing after the fence commits", () => {
    const db = database();
    insertOriginal(db);

    // Interleaving: materializer reads a valid source, then erasure wins the
    // write transaction before the materializer executes its own transaction.
    const captured = db.prepare("SELECT id, user_id, source_r2_key FROM submissions WHERE id=? AND source_erased_at IS NULL")
      .get(ORIGINAL_ID);
    expect(captured).toBeTruthy();
    fenceAndCancel(db);
    materializeCapturedSource(db);

    expect(db.prepare("SELECT 1 FROM submissions WHERE id=?").get(CHILD_ID)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM submission_attempts WHERE submission_id=?").get(CHILD_ID)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM rejudge_jobs WHERE rejudge_batch_id=?").get(BATCH_ID)).toBeUndefined();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("cancels a materialized child and prevents a dispatch captured before erasure from claiming an outbox", () => {
    const db = database();
    insertOriginal(db);
    materializeCapturedSource(db);
    const captured = db.prepare("SELECT old_submission_id, new_submission_id FROM rejudge_jobs WHERE rejudge_batch_id=? AND state='pending'")
      .get(BATCH_ID);
    expect(captured).toBeTruthy();

    // Interleaving: dispatcher has already selected the pending job and may
    // have reserved global capacity, but erasure commits before its claim.
    fenceAndCancel(db);
    db.exec("BEGIN IMMEDIATE");
    db.prepare(CLAIM_REJUDGE_OUTBOX_SQL).run("outbox-1", "sensitive-payload", NOW, BATCH_ID, ORIGINAL_ID);
    db.prepare(CLAIM_REJUDGE_JOB_SQL).run(NOW, BATCH_ID, ORIGINAL_ID);
    db.exec("COMMIT");

    expect(db.prepare("SELECT 1 FROM submission_outbox WHERE id='outbox-1'").get()).toBeUndefined();
    expect(db.prepare("SELECT state, result_state, erasure_excluded_at, workflow_payload_json FROM rejudge_jobs WHERE rejudge_batch_id=?").get(BATCH_ID)).toEqual({
      state: "cancelled",
      result_state: "cancelled",
      erasure_excluded_at: NOW,
      workflow_payload_json: "{}",
    });
    expect(db.prepare("SELECT state FROM submissions WHERE id=?").get(CHILD_ID)).toEqual({ state: "cancelled" });
  });

  it("scrubs every owner outbox and permanently excludes anonymized source history", () => {
    const db = database();
    insertOriginal(db);
    materializeCapturedSource(db);
    db.prepare("INSERT INTO submission_outbox (id, submission_id, kind, payload_json, created_at, delivered_at) VALUES ('delivered', ?, 'start-workflow', 'sensitive-delivered', ?, ?), ('pending', ?, 'start-workflow', 'sensitive-pending', ?, NULL)")
      .run(CHILD_ID, NOW, NOW, CHILD_ID, NOW);
    db.prepare("INSERT INTO rejudge_result_outbox (id, rejudge_batch_id, old_submission_id, new_submission_id, created_at) VALUES ('result', ?, ?, ?, ?)")
      .run(BATCH_ID, ORIGINAL_ID, CHILD_ID, NOW);

    fenceAndCancel(db);
    expect(db.prepare("SELECT id, payload_json, delivered_at FROM submission_outbox ORDER BY id").all()).toEqual([
      { id: "delivered", payload_json: "{}", delivered_at: NOW },
      { id: "pending", payload_json: "{}", delivered_at: NOW },
    ]);
    expect(db.prepare("SELECT delivered_at FROM rejudge_result_outbox WHERE id='result'").get()).toEqual({ delivered_at: NOW });

    // Final erasure re-parents both rows, records source deletion, and retains
    // only the anonymous owner fence. Neither the deleted source nor its
    // anonymous history can become a source for a later rejudge.
    db.prepare("UPDATE submissions SET user_id=?, source_r2_key='erased-source-tombstone', source_erased_at=? WHERE user_id=?")
      .run(ANONYMOUS_USER_ID, NOW, USER_ID);
    db.prepare("DELETE FROM submission_owner_erasure_fences WHERE owner_user_id=?").run(USER_ID);
    expect(db.prepare("SELECT owner_user_id FROM submission_owner_erasure_fences ORDER BY owner_user_id").all()).toEqual([
      { owner_user_id: ANONYMOUS_USER_ID },
    ]);
    expect(db.prepare("SELECT 1 FROM submissions WHERE state IN ('completed','compile-error') AND source_erased_at IS NULL AND NOT EXISTS (SELECT 1 FROM submission_owner_erasure_fences WHERE owner_user_id=submissions.user_id)").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("drains workflow and projection outboxes that arrive after the first cancellation pass", () => {
    const db = database();
    insertOriginal(db);
    materializeCapturedSource(db);
    db.prepare(CLAIM_REJUDGE_OUTBOX_SQL).run("workflow", "workflow-payload", NOW, BATCH_ID, ORIGINAL_ID);
    db.prepare(CLAIM_REJUDGE_JOB_SQL).run(NOW, BATCH_ID, ORIGINAL_ID);

    // First erasure transaction excludes the dispatched child. A workflow that
    // had already crossed its external start boundary then reports completion
    // and creates projection work. The second erasure pass must drain all of it
    // before source deletion can be declared stable.
    fenceAndCancel(db);
    db.prepare("UPDATE submissions SET state='completed', score=100, updated_at=?, completed_at=? WHERE id=?")
      .run(NOW, NOW, CHILD_ID);
    db.prepare("INSERT INTO submission_outbox (id, submission_id, kind, payload_json, created_at) VALUES ('late-profile', ?, 'update-profile', 'late-sensitive-payload', ?)")
      .run(CHILD_ID, NOW);
    db.prepare("INSERT INTO rejudge_result_outbox (id, rejudge_batch_id, old_submission_id, new_submission_id, created_at) VALUES ('late-result', ?, ?, ?, ?)")
      .run(BATCH_ID, ORIGINAL_ID, CHILD_ID, NOW);

    fenceAndCancel(db);
    expect(db.prepare("SELECT delivered_at, payload_json FROM submission_outbox WHERE id='late-profile'").get()).toEqual({
      delivered_at: NOW,
      payload_json: "{}",
    });
    expect(db.prepare("SELECT delivered_at FROM rejudge_result_outbox WHERE id='late-result'").get()).toEqual({ delivered_at: NOW });
    expect(db.prepare("SELECT state, erasure_excluded_at FROM rejudge_jobs WHERE rejudge_batch_id=?").get(BATCH_ID)).toEqual({
      state: "cancelled",
      erasure_excluded_at: NOW,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM rejudge_jobs WHERE rejudge_batch_id=? AND erasure_excluded_at IS NULL").get(BATCH_ID)).toEqual({ count: 0 });
    expect(erasureAdjustedExpectedCount(1, 0, true)).toBe(0);
    expect(erasureAdjustedExpectedCount(1, 0, false)).toBe(1);
  });

  it("cannot resurrect a CORE verified solve across either erasure transaction ordering", () => {
    const erasureFirst = coreProjectionDatabase();
    // A result delivery performed its final SUBMISSIONS_DB read, but the CORE
    // erasure transaction wins before its conditional projection statement.
    commitCoreErasure(erasureFirst);
    expect(projectVerifiedSolve(erasureFirst)).toBe(0);
    expect(erasureFirst.prepare("SELECT * FROM rejudge_verified_solves").all()).toEqual([]);

    const projectionFirst = coreProjectionDatabase();
    // If projection wins the serialized CORE write first, the same erasure
    // transaction necessarily sees and deletes it before account completion.
    expect(projectVerifiedSolve(projectionFirst)).toBe(1);
    commitCoreErasure(projectionFirst);
    expect(projectionFirst.prepare("SELECT * FROM rejudge_verified_solves").all()).toEqual([]);
  });
});
