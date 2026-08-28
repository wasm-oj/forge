import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  prepareContestJudgeRolloutPromptAttemptSnapshot,
  reconcileContestJudgeRolloutSnapshots,
} from "./contest-judge-rollout";
import type { WasmOjWorkerEnv } from "./env";
import {
  materializeRejudgeBatch,
  refreshRejudgeBatches,
  settleTerminalRejudgeJobs,
} from "./rejudge";

class Statement {
  private bindings: SQLInputValue[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]) { this.bindings = values as SQLInputValue[]; return this; }
  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null;
  }
  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.database.prepare(this.sql).all(...this.bindings) as T[],
      meta: {},
    } as D1Result<T>;
  }
  async run(): Promise<D1Result> {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string): Statement { return new Statement(this.database, sql); }
  async batch(statements: readonly Statement[]): Promise<D1Result[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const NOW = new Date("2026-08-26T00:00:00.000Z");

function fixture(): { readonly database: DatabaseSync; readonly env: WasmOjWorkerEnv } {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE rejudge_batches (
      id TEXT PRIMARY KEY, problem_id TEXT NOT NULL, from_commit TEXT NOT NULL,
      to_commit TEXT NOT NULL, contest_id TEXT, requested_by TEXT NOT NULL,
      state TEXT NOT NULL, expected_count INTEGER NOT NULL, failure_code TEXT,
      cancel_requested_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      effective_at TEXT, purpose TEXT NOT NULL, rollout_attempt INTEGER,
      snapshot_timeline_generation INTEGER
    ) STRICT;
    CREATE TABLE contest_judge_rollout_origins (
      rejudge_batch_id TEXT NOT NULL, origin_submission_id TEXT NOT NULL,
      state TEXT NOT NULL, exclusion_reason TEXT, snapshotted_at TEXT NOT NULL,
      excluded_at TEXT, PRIMARY KEY (rejudge_batch_id, origin_submission_id)
    ) STRICT;
    CREATE TABLE contest_submission_records (
      submission_id TEXT PRIMARY KEY, contest_id TEXT NOT NULL,
      timeline_generation INTEGER NOT NULL, eligibility TEXT NOT NULL,
      prompt_attempt_id TEXT
    ) STRICT;
    CREATE TABLE submissions (
      id TEXT PRIMARY KEY, origin_submission_id TEXT NOT NULL,
      origin_submitted_at TEXT NOT NULL, user_id TEXT NOT NULL,
      problem_id TEXT NOT NULL, catalog_commit TEXT NOT NULL,
      judge_digest TEXT NOT NULL, contest_id TEXT, source_id TEXT NOT NULL,
      language TEXT NOT NULL, target TEXT NOT NULL, optimization TEXT NOT NULL,
      entry_path TEXT, state TEXT NOT NULL, visibility TEXT NOT NULL,
      admitted_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      verdict TEXT, completed_at TEXT
    ) STRICT;
    CREATE TABLE submission_sources (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, owner_user_id TEXT,
      admission_erasure_epoch INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL, erasure_epoch INTEGER NOT NULL) STRICT;
    CREATE TABLE account_erasure_jobs (user_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE rejudge_jobs (
      id TEXT PRIMARY KEY, rejudge_batch_id TEXT NOT NULL, problem_id TEXT NOT NULL,
      origin_submission_id TEXT NOT NULL, old_submission_id TEXT NOT NULL,
      new_submission_id TEXT NOT NULL, from_commit TEXT NOT NULL, to_commit TEXT NOT NULL,
      source_id TEXT NOT NULL, user_id TEXT NOT NULL, state TEXT NOT NULL,
      result_state TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (rejudge_batch_id, origin_submission_id)
    ) STRICT;
    CREATE TABLE problem_revisions (
      problem_id TEXT NOT NULL, commit_sha TEXT NOT NULL, judge_digest TEXT NOT NULL,
      PRIMARY KEY (problem_id, commit_sha)
    ) STRICT;
    CREATE TABLE prompt_attempts (
      id TEXT PRIMARY KEY, contest_id TEXT NOT NULL, problem_id TEXT NOT NULL,
      timeline_generation INTEGER NOT NULL, judge_epoch INTEGER NOT NULL,
      state TEXT NOT NULL, eligibility TEXT NOT NULL, erased_at TEXT,
      submission_id TEXT
    ) STRICT;
    CREATE TABLE prompt_attempt_quota (
      prompt_attempt_id TEXT PRIMARY KEY, state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE contest_judge_rollout_prompt_attempts (
      rejudge_batch_id TEXT NOT NULL, prompt_attempt_id TEXT NOT NULL,
      target_judge_epoch INTEGER NOT NULL, state TEXT NOT NULL,
      origin_submission_id TEXT, resolution_reason TEXT,
      snapshotted_at TEXT NOT NULL, resolved_at TEXT,
      PRIMARY KEY (rejudge_batch_id, prompt_attempt_id),
      UNIQUE (rejudge_batch_id, origin_submission_id)
    ) STRICT;
    CREATE TABLE effective_rejudges (
      origin_submission_id TEXT PRIMARY KEY, effective_submission_id TEXT NOT NULL UNIQUE,
      rejudge_batch_id TEXT NOT NULL, became_effective_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE contest_runtimes (
      contest_id TEXT PRIMARY KEY, timeline_generation INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE catalog_sync_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
    CREATE TABLE contest_problem_epochs (
      contest_id TEXT NOT NULL, problem_id TEXT NOT NULL, judge_epoch INTEGER NOT NULL,
      rollout_batch_id TEXT, state TEXT NOT NULL, judge_commit TEXT NOT NULL,
      judge_digest TEXT NOT NULL
    ) STRICT;
    CREATE TABLE effective_submission_results (
      origin_submission_id TEXT, effective_submission_id TEXT, problem_id TEXT,
      judged_commit TEXT, judged_digest TEXT
    ) STRICT;
    CREATE TABLE submission_attempts (
      submission_id TEXT NOT NULL, attempt INTEGER NOT NULL, token_hash TEXT NOT NULL,
      state TEXT NOT NULL, PRIMARY KEY (submission_id, attempt)
    ) STRICT;
    CREATE TABLE workflow_outbox (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, submission_id TEXT NOT NULL,
      attempts INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO users VALUES ('user', 'active', 0);
    INSERT INTO submission_sources VALUES ('source', 'ready', 'user', 0);
    INSERT INTO problem_revisions VALUES ('problem', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'digest');
    INSERT INTO problem_revisions VALUES ('problem', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'target-digest');
    INSERT INTO contest_runtimes VALUES ('contest', 4);
    INSERT INTO catalog_sync_jobs VALUES ('sync', 'running');
    INSERT INTO submissions VALUES (
      'origin', 'origin', '${NOW.toISOString()}', 'user', 'problem',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'digest', 'contest', 'source',
      'c', 'wasip1', 'release', 'main.c', 'completed', 'private',
      '${NOW.toISOString()}', '${NOW.toISOString()}', '${NOW.toISOString()}',
      'accepted', '${NOW.toISOString()}'
    );
    INSERT INTO rejudge_batches VALUES (
      'batch', 'problem', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'contest', 'organizer',
      'queued', 1, NULL, NULL, '${NOW.toISOString()}', '${NOW.toISOString()}',
      NULL, 'contest-judge-rollout', 1, 4
    );
    INSERT INTO contest_problem_epochs VALUES (
      'contest', 'problem', 2, 'batch', 'effective',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'target-digest'
    );
    INSERT INTO contest_judge_rollout_origins VALUES ('batch', 'origin', 'included', NULL, '${NOW.toISOString()}', NULL);
    INSERT INTO contest_submission_records VALUES ('origin', 'contest', 4, 'eligible', NULL);
  `);
  return {
    database,
    env: {
      DB: new SqliteD1(database) as unknown as D1Database,
      ACCOUNT_ERASURE_HMAC_SECRET: "contest-rollout-test-secret-000000000000000000000000",
    } as WasmOjWorkerEnv,
  };
}

describe("contest judge rollout source snapshot", () => {
  it("drops a rewound source and lowers the bounded batch count", async () => {
    const value = fixture();
    value.database.prepare("UPDATE contest_submission_records SET eligibility='invalid'").run();

    await expect(reconcileContestJudgeRolloutSnapshots(value.env, NOW)).resolves.toBe(1);

    expect(value.database.prepare(`SELECT state, exclusion_reason FROM contest_judge_rollout_origins`).get())
      .toEqual({ state: "excluded", exclusion_reason: "timeline-ineligible" });
    expect(value.database.prepare("SELECT expected_count FROM rejudge_batches").get())
      .toEqual({ expected_count: 0 });
  });

  it("never shrinks expected count after a child job owns the snapshot member", async () => {
    const value = fixture();
    value.database.prepare(`INSERT INTO rejudge_jobs
      (id, rejudge_batch_id, problem_id, origin_submission_id, old_submission_id,
       new_submission_id, from_commit, to_commit, source_id, user_id, state,
       result_state, created_at, updated_at)
      VALUES ('job', 'batch', 'problem', 'origin', 'origin', 'child',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'source', 'user', 'dispatched', NULL, ?, ?)`)
      .run(NOW.toISOString(), NOW.toISOString());
    value.database.prepare("UPDATE submission_sources SET state='erased', owner_user_id=NULL").run();

    await expect(reconcileContestJudgeRolloutSnapshots(value.env, NOW)).resolves.toBe(0);

    expect(value.database.prepare(`SELECT state, exclusion_reason FROM contest_judge_rollout_origins`).get())
      .toEqual({ state: "included", exclusion_reason: null });
    expect(value.database.prepare("SELECT expected_count FROM rejudge_batches").get())
      .toEqual({ expected_count: 1 });
  });

  it("reuses a generating-at-snapshot Prompt source in a target-epoch submission before atomic rollout", async () => {
    const value = fixture();
    value.database.exec(`
      DELETE FROM contest_judge_rollout_origins;
      DELETE FROM contest_submission_records;
      DELETE FROM submissions;
      DELETE FROM submission_sources;
      INSERT INTO prompt_attempts VALUES (
        'prompt-attempt', 'contest', 'problem', 4, 1,
        'generating', 'eligible', NULL, NULL
      );
      INSERT INTO prompt_attempt_quota VALUES ('prompt-attempt', 'consumed');
      UPDATE rejudge_batches SET expected_count=0 WHERE id='batch';
    `);

    await prepareContestJudgeRolloutPromptAttemptSnapshot(value.env, {
      jobId: "sync",
      batchId: "batch",
      contestId: "contest",
      problemId: "problem",
      timelineGeneration: 4,
      targetJudgeEpoch: 2,
      now: NOW.toISOString(),
    }).run();
    value.database.prepare(`UPDATE rejudge_batches
      SET expected_count=(SELECT COUNT(*) FROM contest_judge_rollout_prompt_attempts
        WHERE rejudge_batch_id='batch' AND state='included')
      WHERE id='batch'`).run();
    value.database.exec(`
      INSERT INTO prompt_attempts VALUES (
        'late-prompt-attempt', 'contest', 'problem', 4, 1,
        'generating', 'eligible', NULL, NULL
      );
      INSERT INTO prompt_attempt_quota VALUES ('late-prompt-attempt', 'consumed');
    `);
    await prepareContestJudgeRolloutPromptAttemptSnapshot(value.env, {
      jobId: "sync",
      batchId: "batch",
      contestId: "contest",
      problemId: "problem",
      timelineGeneration: 4,
      targetJudgeEpoch: 2,
      now: NOW.toISOString(),
    }).run();
    expect(value.database.prepare(`SELECT COUNT(*) AS count
      FROM contest_judge_rollout_prompt_attempts`).get()).toEqual({ count: 1 });

    await expect(reconcileContestJudgeRolloutSnapshots(value.env, NOW)).resolves.toBe(0);
    expect(value.database.prepare(`SELECT state FROM contest_judge_rollout_prompt_attempts`).get())
      .toEqual({ state: "included" });
    expect(value.database.prepare("SELECT expected_count FROM rejudge_batches").get())
      .toEqual({ expected_count: 1 });

    value.database.exec(`
      INSERT INTO submission_sources VALUES ('prompt-source', 'ready', 'user', 0);
      INSERT INTO submissions VALUES (
        'prompt-origin', 'prompt-origin', '${NOW.toISOString()}', 'user', 'problem',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'digest', 'contest', 'prompt-source',
        'c', 'wasip1', 'release', 'main.c', 'queued', 'private',
        '${NOW.toISOString()}', '${NOW.toISOString()}', '${NOW.toISOString()}',
        NULL, NULL
      );
      INSERT INTO contest_submission_records VALUES (
        'prompt-origin', 'contest', 4, 'eligible', 'prompt-attempt'
      );
      UPDATE prompt_attempts
      SET state='submitted', submission_id='prompt-origin'
      WHERE id='prompt-attempt';
    `);

    value.database.prepare(`UPDATE contest_problem_epochs
      SET judge_digest='corrupt-target-digest' WHERE rollout_batch_id='batch'`).run();
    await expect(reconcileContestJudgeRolloutSnapshots(value.env, NOW)).resolves.toBe(0);
    expect(value.database.prepare(`SELECT state FROM contest_judge_rollout_prompt_attempts`).get())
      .toEqual({ state: "included" });
    value.database.prepare(`UPDATE contest_problem_epochs
      SET judge_digest='target-digest' WHERE rollout_batch_id='batch'`).run();

    await expect(reconcileContestJudgeRolloutSnapshots(value.env, NOW)).resolves.toBe(1);
    expect(value.database.prepare(`SELECT state, origin_submission_id, resolution_reason
      FROM contest_judge_rollout_prompt_attempts`).get()).toEqual({
      state: "promoted",
      origin_submission_id: "prompt-origin",
      resolution_reason: "official-submission-created",
    });
    expect(value.database.prepare(`SELECT origin_submission_id, state
      FROM contest_judge_rollout_origins`).get())
      .toEqual({ origin_submission_id: "prompt-origin", state: "included" });
    expect(value.database.prepare("SELECT expected_count FROM rejudge_batches").get())
      .toEqual({ expected_count: 1 });

    await expect(materializeRejudgeBatch(value.env, "batch")).resolves.toBe(true);
    const child = value.database.prepare(`SELECT child.id, child.catalog_commit,
      child.judge_digest, child.source_id, child.state
      FROM rejudge_jobs AS jobs
      JOIN submissions AS child ON child.id=jobs.new_submission_id
      WHERE jobs.rejudge_batch_id='batch'`).get()!;
    expect(child).toMatchObject({
      catalog_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      judge_digest: "target-digest",
      source_id: "prompt-source",
      state: "queued",
    });
    expect(value.database.prepare("SELECT state FROM rejudge_batches").get())
      .toEqual({ state: "running" });
    expect(value.database.prepare("SELECT * FROM effective_rejudges").get()).toBeUndefined();

    value.database.prepare(`UPDATE submissions SET state='completed', verdict='accepted',
      completed_at=?, updated_at=? WHERE id=?`).run(NOW.toISOString(), NOW.toISOString(), child.id);
    await expect(settleTerminalRejudgeJobs(value.env)).resolves.toBe(1);
    await expect(refreshRejudgeBatches(value.env)).resolves.toBe(1);
    expect(value.database.prepare("SELECT state FROM rejudge_batches").get())
      .toEqual({ state: "effective" });
    expect(value.database.prepare(`SELECT origin_submission_id, effective_submission_id
      FROM effective_rejudges`).get()).toEqual({
      origin_submission_id: "prompt-origin",
      effective_submission_id: child.id,
    });
  });

  it("excludes a provider failure and lets an otherwise empty rollout become effective", async () => {
    const value = fixture();
    value.database.exec(`
      DELETE FROM contest_judge_rollout_origins;
      DELETE FROM contest_submission_records;
      DELETE FROM submissions;
      DELETE FROM submission_sources;
      INSERT INTO prompt_attempts VALUES (
        'prompt-attempt', 'contest', 'problem', 4, 1,
        'generating', 'eligible', NULL, NULL
      );
      INSERT INTO prompt_attempt_quota VALUES ('prompt-attempt', 'reserved');
      INSERT INTO contest_judge_rollout_prompt_attempts VALUES (
        'batch', 'prompt-attempt', 2, 'included', NULL, NULL, '${NOW.toISOString()}', NULL
      );
      UPDATE prompt_attempts SET state='failed' WHERE id='prompt-attempt';
      UPDATE prompt_attempt_quota SET state='released' WHERE prompt_attempt_id='prompt-attempt';
    `);

    await expect(reconcileContestJudgeRolloutSnapshots(value.env, NOW)).resolves.toBe(1);
    expect(value.database.prepare(`SELECT state, resolution_reason
      FROM contest_judge_rollout_prompt_attempts`).get())
      .toEqual({ state: "excluded", resolution_reason: "quota-released" });
    expect(value.database.prepare("SELECT expected_count FROM rejudge_batches").get())
      .toEqual({ expected_count: 0 });

    value.database.prepare("UPDATE rejudge_batches SET state='running' WHERE id='batch'").run();
    await expect(refreshRejudgeBatches(value.env)).resolves.toBe(1);
    expect(value.database.prepare("SELECT state FROM rejudge_batches").get())
      .toEqual({ state: "effective" });
  });

  it("unblocks an erased promoted Prompt member without publishing its cancelled target child", async () => {
    const value = fixture();
    value.database.exec(`
      UPDATE contest_submission_records SET prompt_attempt_id='prompt-attempt';
      INSERT INTO prompt_attempts VALUES (
        'prompt-attempt', 'contest', 'problem', 4, 1,
        'submitted', 'invalid', '${NOW.toISOString()}', 'origin'
      );
      INSERT INTO prompt_attempt_quota VALUES ('prompt-attempt', 'invalid');
      INSERT INTO contest_judge_rollout_prompt_attempts VALUES (
        'batch', 'prompt-attempt', 2, 'promoted', 'origin',
        'official-submission-created', '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
      INSERT INTO submissions VALUES (
        'child', 'origin', '${NOW.toISOString()}', 'user', 'problem',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'target-digest', 'contest', 'source',
        'c', 'wasip1', 'release', 'main.c', 'cancelled', 'private',
        '${NOW.toISOString()}', '${NOW.toISOString()}', '${NOW.toISOString()}',
        'cancelled', '${NOW.toISOString()}'
      );
      INSERT INTO rejudge_jobs VALUES (
        'job', 'batch', 'problem', 'origin', 'origin', 'child',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'source', 'user', 'cancelled', 'cancelled',
        '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
    `);

    await expect(reconcileContestJudgeRolloutSnapshots(value.env, NOW)).resolves.toBe(1);
    expect(value.database.prepare(`SELECT state, exclusion_reason
      FROM contest_judge_rollout_origins`).get())
      .toEqual({ state: "excluded", exclusion_reason: "attempt-erased" });
    expect(value.database.prepare("SELECT expected_count FROM rejudge_batches").get())
      .toEqual({ expected_count: 0 });

    value.database.prepare("UPDATE rejudge_batches SET state='running' WHERE id='batch'").run();
    await expect(refreshRejudgeBatches(value.env)).resolves.toBe(1);
    expect(value.database.prepare("SELECT state FROM rejudge_batches").get())
      .toEqual({ state: "effective" });
    expect(value.database.prepare("SELECT * FROM effective_rejudges").get()).toBeUndefined();
  });
});
