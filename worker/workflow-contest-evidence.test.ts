import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { prepareJudgeTerminalEvidenceUpdates } from "./contest-evidence";

class SqliteStatement {
  readonly #database: DatabaseSync;
  readonly #sql: string;
  readonly #bindings: readonly SQLInputValue[];

  constructor(database: DatabaseSync, sql: string, bindings: readonly SQLInputValue[] = []) {
    this.#database = database;
    this.#sql = sql;
    this.#bindings = bindings;
  }

  bind(...bindings: readonly unknown[]): D1PreparedStatement {
    return new SqliteStatement(this.#database, this.#sql, bindings as readonly SQLInputValue[]) as unknown as D1PreparedStatement;
  }

  run(): D1Result {
    const result = this.#database.prepare(this.#sql).run(...this.#bindings);
    return { meta: { changes: Number(result.changes) } } as D1Result;
  }
}

function database(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE contest_runtimes (
      contest_id TEXT PRIMARY KEY,
      active_rules_commit TEXT NOT NULL,
      active_rules_sha256 TEXT NOT NULL,
      state TEXT NOT NULL,
      wall_anchor_at TEXT,
      logical_anchor_seconds INTEGER NOT NULL
    );
    CREATE TABLE contest_rule_revisions (
      contest_id TEXT NOT NULL,
      rules_commit TEXT NOT NULL,
      rules_sha256 TEXT NOT NULL,
      clock_kind TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL
    );
    CREATE TABLE contest_rule_epochs (
      contest_id TEXT NOT NULL,
      rules_epoch INTEGER NOT NULL,
      rules_commit TEXT NOT NULL,
      rules_sha256 TEXT NOT NULL
    );
    CREATE TABLE contest_rule_problems (
      contest_id TEXT NOT NULL,
      rules_commit TEXT NOT NULL,
      problem_id TEXT NOT NULL,
      submission_closes_after_seconds INTEGER NOT NULL
    );
    CREATE TABLE contest_entrants (
      id TEXT PRIMARY KEY,
      contest_id TEXT NOT NULL,
      individual_wall_anchor_at TEXT,
      individual_logical_anchor_seconds INTEGER NOT NULL
    );
    CREATE TABLE submissions (
      id TEXT PRIMARY KEY,
      problem_id TEXT NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE contest_submission_records (
      submission_id TEXT PRIMARY KEY,
      contest_id TEXT NOT NULL,
      entrant_id TEXT NOT NULL,
      rules_epoch INTEGER NOT NULL,
      evidence_at TEXT NOT NULL,
      evidence_logical_seconds INTEGER,
      eligibility TEXT NOT NULL,
      invalidated_at TEXT,
      invalidation_reason TEXT
    );
    CREATE TABLE prompt_attempts (
      id TEXT PRIMARY KEY,
      submission_id TEXT,
      evidence_logical_seconds INTEGER,
      eligibility TEXT NOT NULL,
      invalidated_at TEXT,
      invalidation_reason TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  database.prepare(`INSERT INTO contest_runtimes VALUES
      ('contest', 'a', 'digest', 'running', '2026-01-01T00:00:00.000Z', 0)`).run();
  database.prepare(`INSERT INTO contest_rule_revisions VALUES
      ('contest', 'a', 'digest', 'global', 1000)`).run();
  database.prepare(`INSERT INTO contest_rule_epochs VALUES
      ('contest', 1, 'a', 'digest')`).run();
  database.prepare(`INSERT INTO contest_rule_problems VALUES
      ('contest', 'a', 'problem', 600)`).run();
  database.prepare(`INSERT INTO contest_entrants VALUES
      ('entrant', 'contest', NULL, 0)`).run();
  return database;
}

function seed(database: DatabaseSync, eligibility = "eligible"): void {
  database.prepare("INSERT INTO submissions VALUES ('submission', 'problem', 'completed')").run();
  database.prepare(`INSERT INTO contest_submission_records VALUES
      ('submission', 'contest', 'entrant', 1, 'judge-terminal', NULL, ?, NULL, NULL)`).run(eligibility);
  database.prepare(`INSERT INTO prompt_attempts VALUES
      ('attempt', 'submission', NULL, ?, NULL, NULL, '2026-01-01T00:00:00.000Z')`).run(eligibility);
}

function settle(database: DatabaseSync, terminalAt: string): void {
  const d1 = { prepare: (sql: string) => new SqliteStatement(database, sql) } as unknown as D1Database;
  for (const statement of prepareJudgeTerminalEvidenceUpdates(d1, "submission", terminalAt)) statement.run();
}

describe("judge-terminal contest evidence", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => { sqlite = database(); });

  it("invalidates a result and its prompt provenance when terminal evidence reaches the close boundary", () => {
    seed(sqlite);
    settle(sqlite, "2026-01-01T00:15:00.000Z");
    expect(sqlite.prepare(`SELECT evidence_logical_seconds, eligibility,
      invalidation_reason FROM contest_submission_records`).get()).toEqual({
      evidence_logical_seconds: 900,
      eligibility: "invalid",
      invalidation_reason: "judge-terminal-after-close",
    });
    expect(sqlite.prepare(`SELECT evidence_logical_seconds, eligibility,
      invalidation_reason FROM prompt_attempts`).get()).toEqual({
      evidence_logical_seconds: 900,
      eligibility: "invalid",
      invalidation_reason: "judge-terminal-after-close",
    });
  });

  it("keeps a result eligible when terminal evidence is before close", () => {
    seed(sqlite);
    settle(sqlite, "2026-01-01T00:09:59.000Z");
    expect(sqlite.prepare(`SELECT evidence_logical_seconds, eligibility,
      invalidation_reason FROM contest_submission_records`).get()).toEqual({
      evidence_logical_seconds: 599,
      eligibility: "eligible",
      invalidation_reason: null,
    });
  });

  it("uses the submission rule epoch after a monotonic rule activation", () => {
    seed(sqlite);
    sqlite.prepare(`INSERT INTO contest_rule_revisions VALUES
      ('contest', 'b', 'new-digest', 'global', 2000)`).run();
    sqlite.prepare(`INSERT INTO contest_rule_epochs VALUES
      ('contest', 2, 'b', 'new-digest')`).run();
    sqlite.prepare(`INSERT INTO contest_rule_problems VALUES
      ('contest', 'b', 'problem', 1800)`).run();
    sqlite.prepare(`UPDATE contest_runtimes
      SET active_rules_commit='b', active_rules_sha256='new-digest'`).run();

    settle(sqlite, "2026-01-01T00:25:00.000Z");

    expect(sqlite.prepare(`SELECT evidence_logical_seconds, eligibility,
      invalidation_reason FROM contest_submission_records`).get()).toEqual({
      evidence_logical_seconds: 1000,
      eligibility: "invalid",
      invalidation_reason: "judge-terminal-after-close",
    });
  });

  it("freezes completion evidence at the paused logical timestamp", () => {
    seed(sqlite);
    sqlite.prepare(`UPDATE contest_runtimes
      SET state='paused', wall_anchor_at=NULL, logical_anchor_seconds=550`).run();
    settle(sqlite, "2026-01-01T01:00:00.000Z");
    expect(sqlite.prepare(`SELECT evidence_logical_seconds, eligibility
      FROM contest_submission_records`).get()).toEqual({
      evidence_logical_seconds: 550,
      eligibility: "eligible",
    });
  });

  it("does not resurrect evidence invalidated by a rewind while judging", () => {
    seed(sqlite, "invalid");
    settle(sqlite, "2026-01-01T00:05:00.000Z");
    expect(sqlite.prepare(`SELECT evidence_logical_seconds, eligibility
      FROM contest_submission_records`).get()).toEqual({
      evidence_logical_seconds: null,
      eligibility: "invalid",
    });
  });
});
