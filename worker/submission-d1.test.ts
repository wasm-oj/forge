import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ForgeWorkerEnv } from "./env";
import {
  claimSubmissionExecutionSlot,
  MAX_EXECUTING_SUBMISSIONS,
  MAX_NONTERMINAL_SUBMISSIONS,
  MAX_QUEUED_SUBMISSIONS_PER_USER,
} from "./submission-capacity";
import {
  appendAuthorizedSubmissionEvent,
  latestSubmissionEventCursor,
  replaySubmissionEvents,
  terminalizeSubmissionWithEvent,
} from "./submission-events";
import { INSERT_OFFICIAL_SUBMISSION_SQL } from "./submissions";

const NOW = "2026-08-11T00:00:00.000Z";
const DIGEST = "a".repeat(64);
const TOKEN_HASH = "b".repeat(64);

class SqliteStatement {
  private bindings: readonly SQLInputValue[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...bindings: readonly SQLInputValue[]): this {
    this.bindings = bindings;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ readonly results: readonly T[] }> {
    return { results: this.statement.all(...this.bindings) as T[] };
  }

  async run(): Promise<{ readonly meta: { readonly changes: number } }> {
    return { meta: { changes: Number(this.statement.run(...this.bindings).changes) } };
  }
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database.prepare(sql));
  }

  async batch(statements: readonly SqliteStatement[]): Promise<readonly { readonly meta: { readonly changes: number } }[]> {
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

function database(): { readonly sqlite: DatabaseSync; readonly env: ForgeWorkerEnv } {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "0001_initial.sql",
    "0002_rejudge_pipeline.sql",
    "0003_account_erasure_fence.sql",
    "0004_projection_outbox_uniqueness.sql",
    "0005_formal_admission_claim.sql",
    "0006_d1_submission_events_capacity.sql",
  ]) {
    sqlite.exec(readFileSync(path.join(process.cwd(), "migrations/submissions", migration), "utf8"));
  }
  return {
    sqlite,
    env: { SUBMISSIONS_DB: new SqliteD1(sqlite) as unknown as D1Database } as unknown as ForgeWorkerEnv,
  };
}

function id(index: number): string {
  return `0198dbd3-5c00-7000-8000-${String(index).padStart(12, "0")}`;
}

function insertSubmission(
  sqlite: DatabaseSync,
  submissionId: string,
  userId: string,
  state = "admitting",
): void {
  sqlite.prepare(`INSERT INTO submissions
      (id, user_id, managed_problem_version_id, language, target, optimization, entry_path,
       source_r2_key, source_digest, forge_release_id, forge_manifest_sha256, state,
       visibility, created_at, updated_at)
    VALUES (?, ?, ?, 'c', 'wasip1', 'release', 'main.c', ?, ?, ?, ?, ?, 'private', ?, ?)`)
    .run(submissionId, userId, id(999), `sources/${userId}/${submissionId}.${DIGEST}.json`, DIGEST, id(998), DIGEST, state, NOW, NOW);
}

function insertAttempt(sqlite: DatabaseSync, submissionId: string, attempt = 1, tokenHash = TOKEN_HASH): void {
  sqlite.prepare("INSERT INTO submission_attempts (submission_id, attempt, token_hash, container_key, state) VALUES (?, ?, ?, ?, 'created')")
    .run(submissionId, attempt, tokenHash, `${submissionId}:${attempt}`);
}

describe("D1 submission events and capacity", () => {
  it("applies the canonical migration and removes reservation/event-projection storage", () => {
    const { sqlite } = database();
    const submissionColumns = sqlite.prepare("PRAGMA table_info(submissions)").all().map((row) => row.name);
    const rejudgeColumns = sqlite.prepare("PRAGMA table_info(rejudge_jobs)").all().map((row) => row.name);
    expect(submissionColumns).not.toContain("reservation_released_at");
    expect(rejudgeColumns).not.toContain("reservation_released_at");
    expect(sqlite.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='submission_events'").get()).toBeTruthy();
    expect(sqlite.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='submission_outbox'").get()).toMatchObject({
      sql: expect.not.stringContaining("reconcile-terminal-event"),
    });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("admits only three queued submissions for one account", () => {
    const { sqlite } = database();
    const userId = id(10);
    const insert = (submissionId: string) => sqlite.prepare(INSERT_OFFICIAL_SUBMISSION_SQL).run(
      submissionId,
      userId,
      id(20),
      null,
      NOW,
      DIGEST,
      "c",
      "wasip1",
      "release",
      "main.c",
      `sources/${userId}/${submissionId}.${DIGEST}.json`,
      DIGEST,
      id(30),
      DIGEST,
      NOW,
      NOW,
      userId,
    );
    expect([insert(id(1)), insert(id(2)), insert(id(3))].map((result) => Number(result.changes))).toEqual([1, 1, 1]);
    expect(Number(insert(id(4)).changes)).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get()).toEqual({ count: MAX_QUEUED_SUBMISSIONS_PER_USER });
  });

  it("enforces one executing submission per account and fifty globally", async () => {
    const { sqlite, env } = database();
    const firstUser = id(100);
    insertSubmission(sqlite, id(1), firstUser, "queued");
    insertSubmission(sqlite, id(2), firstUser, "queued");
    insertAttempt(sqlite, id(1));
    insertAttempt(sqlite, id(2));
    expect(await claimSubmissionExecutionSlot(env, id(1), new Date(NOW))).toBe(true);
    expect(await claimSubmissionExecutionSlot(env, id(2), new Date(NOW))).toBe(false);

    for (let index = 3; index <= MAX_EXECUTING_SUBMISSIONS + 1; index += 1) {
      insertSubmission(sqlite, id(index), id(100 + index), "queued");
      insertAttempt(sqlite, id(index));
      expect(await claimSubmissionExecutionSlot(env, id(index), new Date(NOW))).toBe(true);
    }
    insertSubmission(sqlite, id(900), id(901), "queued");
    insertAttempt(sqlite, id(900));
    expect(await claimSubmissionExecutionSlot(env, id(900), new Date(NOW))).toBe(false);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions WHERE state='preparing'").get()).toEqual({ count: MAX_EXECUTING_SUBMISSIONS });
  });

  it("deduplicates retry events, permits global cursor gaps, and never revives terminal state", async () => {
    const { sqlite, env } = database();
    insertSubmission(sqlite, id(1), id(101), "queued");
    insertAttempt(sqlite, id(1));
    insertSubmission(sqlite, id(2), id(102), "queued");
    insertAttempt(sqlite, id(2));

    const first = await appendAuthorizedSubmissionEvent(env, {
      submissionId: id(1),
      attempt: 1,
      attemptTokenHash: TOKEN_HASH,
      eventKey: "container:1:compile",
      event: { kind: "compile-progress", phase: "compile" },
      now: new Date(NOW),
    });
    const duplicate = await appendAuthorizedSubmissionEvent(env, {
      submissionId: id(1),
      attempt: 1,
      attemptTokenHash: TOKEN_HASH,
      eventKey: "container:1:compile",
      event: { kind: "compile-progress", phase: "compile" },
      now: new Date(NOW),
    });
    await appendAuthorizedSubmissionEvent(env, {
      submissionId: id(2),
      attempt: 1,
      attemptTokenHash: TOKEN_HASH,
      eventKey: "container:1:other",
      event: { kind: "compile-progress", phase: "compile" },
      now: new Date(NOW),
    });
    await appendAuthorizedSubmissionEvent(env, {
      submissionId: id(1),
      attempt: 1,
      attemptTokenHash: TOKEN_HASH,
      eventKey: "container:1:progress",
      event: { kind: "case-progress", completedCases: 1, totalCases: 2 },
      now: new Date(NOW),
    });
    await expect(appendAuthorizedSubmissionEvent(env, {
      submissionId: id(1),
      attempt: 1,
      attemptTokenHash: TOKEN_HASH,
      eventKey: "container:1:private-output",
      event: { kind: "case-progress", completedCases: 1, totalCases: 2, stdout: "hidden" },
      now: new Date(NOW),
    })).rejects.toThrow("shape");
    expect(first.duplicate).toBe(false);
    expect(duplicate).toEqual({ ...first, duplicate: true });
    const replay = await replaySubmissionEvents(env, id(1), first.event.sequence, 100);
    expect(replay).toHaveLength(1);
    expect(replay[0]!.sequence).toBeGreaterThan(first.event.sequence + 1);
    expect(await latestSubmissionEventCursor(env, id(1))).toBe(replay[0]!.sequence);

    expect(await terminalizeSubmissionWithEvent(env, {
      submissionId: id(1),
      state: "cancelled",
      eventKey: "api:cancelled",
      ownerUserId: id(101),
      now: new Date(NOW),
    })).toMatchObject({ changed: true });
    await expect(appendAuthorizedSubmissionEvent(env, {
      submissionId: id(1),
      attempt: 1,
      attemptTokenHash: TOKEN_HASH,
      eventKey: "container:1:late",
      event: { kind: "state", state: "running" },
      now: new Date(NOW),
    })).rejects.toMatchObject({ status: 409 });
    expect(sqlite.prepare("SELECT state FROM submissions WHERE id=?").get(id(1))).toEqual({ state: "cancelled" });
  });

  it("rejects admission after five hundred nonterminal submissions", () => {
    const { sqlite } = database();
    for (let index = 0; index < MAX_NONTERMINAL_SUBMISSIONS; index += 1) {
      insertSubmission(sqlite, id(10_000 + index), id(20_000 + index), "queued");
    }
    const submissionId = id(30_000);
    const userId = id(30_001);
    const result = sqlite.prepare(INSERT_OFFICIAL_SUBMISSION_SQL).run(
      submissionId,
      userId,
      id(30_002),
      null,
      NOW,
      DIGEST,
      "c",
      "wasip1",
      "release",
      "main.c",
      `sources/${userId}/${submissionId}.${DIGEST}.json`,
      DIGEST,
      id(30_003),
      DIGEST,
      NOW,
      NOW,
      userId,
    );
    expect(Number(result.changes)).toBe(0);
  });
});
