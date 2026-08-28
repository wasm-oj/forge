import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RepositoryContest } from "../src/online-judge/repository-contract";
import {
  failCatalogSync,
  persistCatalogSync,
  type CatalogSyncContext,
  type ValidatedCatalogProblem,
} from "./catalog-persistence";
import type { WasmOjWorkerEnv } from "./env";
import { queryContestLeaderboard } from "./leaderboards";
import { queryPerformanceFrontier } from "./performance";
import {
  materializeRejudgeBatch,
  refreshRejudgeBatches,
  settleTerminalRejudgeJobs,
} from "./rejudge";
import { loadSubmissionProblemRevisionForAdmission } from "./submissions";

class Statement {
  private bindings: SQLInputValue[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]) { this.bindings = values as SQLInputValue[]; return this; }
  async first<T>(): Promise<T | null> { return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null; }
  async all<T>(): Promise<D1Result<T>> {
    return { success: true, results: this.database.prepare(this.sql).all(...this.bindings) as T[], meta: {} } as D1Result<T>;
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

const CATALOG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_JOB = "33333333-3333-4333-8333-333333333333";
const SECOND_JOB = "44444444-4444-4444-8444-444444444444";
const FAILED_JOB = "55555555-5555-4555-8555-555555555555";
const RUNNING_FAILURE_JOB = "66666666-6666-4666-8666-666666666666";
const UPDATED_JOB = "99999999-9999-4999-8999-999999999999";
const ROLLOUT_RETRY_JOB = "aaaaaaaa-1111-4111-8111-111111111111";
const COMMIT = "a".repeat(40);
const NOW = "2026-08-26T00:00:00.000Z";

function applyCoreMigrations(database: DatabaseSync, maximum = "9999"): void {
  const directory = join(process.cwd(), "migrations/core");
  for (const filename of readdirSync(directory)
    .filter((candidate) => candidate.endsWith(".sql") && candidate.slice(0, 4) <= maximum)
    .sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function insertSyncJob(
  database: DatabaseSync,
  id: string,
  state: "running" | "failed",
  commitSha = COMMIT,
): void {
  const failed = state === "failed";
  database.prepare(`INSERT INTO catalog_sync_jobs
    (id, catalog_id, requested_ref, commit_sha, state, requested_by,
     idempotency_key, request_digest, error_code, summary_json,
     created_at, updated_at, started_at, finished_at)
    VALUES (?, ?, 'main', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
    .run(
      id, CATALOG_ID, commitSha, state, USER_ID, id,
      createHash("sha256").update(id).digest("hex"), failed ? "prior-failure" : null,
      NOW, NOW, NOW, failed ? NOW : null,
    );
}

function seedCatalogAuthority(database: DatabaseSync): void {
  database.prepare("INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'active')")
    .run(USER_ID, NOW, NOW);
  database.prepare(`INSERT INTO github_installations
    (installation_id, account_github_id, account_login, installed_by_user_id,
     status, permissions_json, repository_selection, created_at, updated_at)
    VALUES (1, 42, 'wasm-oj', ?, 'active', '{}', 'all', ?, ?)`)
    .run(USER_ID, NOW, NOW);
  database.prepare(`INSERT INTO github_repositories
    (github_repository_id, installation_id, owner_login, name, is_private,
     authorization_status, updated_at)
    VALUES (42, 1, 'wasm-oj', 'problems', 0, 'authorized', ?)`)
    .run(NOW);
  database.prepare(`INSERT INTO catalogs
    (id, organizer_user_id, github_repository_id, active_commit_sha, created_at, updated_at)
    VALUES (?, ?, 42, NULL, ?, ?)`)
    .run(CATALOG_ID, USER_ID, NOW, NOW);
}

function databaseFixture(): { database: DatabaseSync; env: WasmOjWorkerEnv } {
  const database = new DatabaseSync(":memory:");
  applyCoreMigrations(database);
  seedCatalogAuthority(database);
  database.prepare(`UPDATE contest_v2_cutover_state SET state='applying',
    started_at=?, updated_at=? WHERE singleton=1 AND state='pending'`).run(NOW, NOW);
  database.prepare(`UPDATE contest_v2_cutover_state SET state='completed',
    completed_at=?, completed_contest_count=legacy_contest_count,
    updated_at=? WHERE singleton=1 AND state='applying'`).run(NOW, NOW);
  insertSyncJob(database, FIRST_JOB, "running");
  return {
    database,
    env: {
      DB: new SqliteD1(database) as unknown as D1Database,
      ACCOUNT_ERASURE_HMAC_SECRET: "test-contest-rollout-hmac-secret-0000000000000000",
    } as WasmOjWorkerEnv,
  };
}

function context(jobId: string, commitSha = COMMIT): CatalogSyncContext {
  return { jobId, catalogId: CATALOG_ID, githubRepositoryId: 42, commitSha, requestedBy: USER_ID, state: "running" };
}

function problem(): ValidatedCatalogProblem {
  return {
    source: {
      slug: "sum", order: 1, title: { "zh-TW": "加總", en: "Sum" },
      summary: { "zh-TW": "計算", en: "Compute" }, practiceEnabled: true,
      practiceBundle: { path: "collection/sum.practice.json", bytes: 10, sha256: "1".repeat(64) },
      contestBundle: { path: "collection/sum.contest.json", bytes: 9, sha256: "2".repeat(64) },
      judgePackage: { path: "collection/sum.wasmojjudge", bytes: 20, sha256: "3".repeat(64) },
    },
    allowedProfilesJson: JSON.stringify({ c: { target: "wasip1", optimization: "release" } }),
  };
}

const contest = {
  slug: "weekly", status: "published", title: "Weekly", description: "",
  accessMode: "invite",
  rules: {
    clock: {
      kind: "global",
      registrationOpensAt: "2026-08-25T00:00:00Z",
      registrationClosesAt: "2026-08-26T00:00:00Z",
      startsAt: "2026-08-26T00:00:00Z",
      durationSeconds: 3_600,
    },
    officialTrack: { kind: "code", aiAssist: "allowed" },
    evidenceAt: "judge-terminal",
    problems: [{
      slug: "sum", batch: 1, releaseAfterSeconds: 0,
      submissionClosesAfterSeconds: 3_600, points: 250, attemptLimit: 8,
    }],
    scoring: { kind: "score", tieBreaks: ["fully-passed-cases", "final-best-achieved-at"] },
    checkpoints: [{
      id: "halfway", atSeconds: 1_800, scope: { kind: "all-released" },
      threshold: { minimumSolved: null, minimumScore: 50 },
      ranking: { kind: "top-percent", percent: 50 }, settlement: "provisional",
    }],
    leaderboard: { kind: "freeze", atSeconds: 3_000 },
  },
} satisfies RepositoryContest;

const promptContest = {
  slug: "prompt-sprint", status: "published", title: "Prompt Sprint", description: "",
  accessMode: "public",
  rules: {
    clock: {
      kind: "individual",
      enrollmentOpensAt: "2026-08-25T00:00:00Z",
      enrollmentClosesAt: "2026-08-27T00:00:00Z",
      durationSeconds: 900,
    },
    officialTrack: {
      kind: "prompt-program",
      compiler: { configId: "fake-v1", configDigest: "4".repeat(64) },
      limits: {
        promptBytes: 16_384, inputTokens: 4_096, outputTokens: 8_192,
        generatedSourceBytes: 1_048_576, timeoutSeconds: 120,
      },
      attemptPolicy: {
        consumeOn: "model-response-received",
        terminalInfrastructureFailure: "release-reservation",
      },
      disclosure: "best-after-end",
    },
    evidenceAt: "generated-source-ready",
    problems: [{
      slug: "sum", batch: 1, releaseAfterSeconds: 0,
      submissionClosesAfterSeconds: 900, points: 100, attemptLimit: 3,
      output: { language: "c", target: "wasip1", optimization: "release", entry: "main.c" },
    }],
    scoring: { kind: "progress", tieBreaks: ["fully-passed-cases", "final-best-achieved-at"] },
    checkpoints: [],
    leaderboard: { kind: "hidden-until-end" },
  },
} satisfies RepositoryContest;

describe("catalog projection persistence", () => {
  it("atomically clears the active-catalog contests/v2 resync gate on strict v2 sync", async () => {
    const database = new DatabaseSync(":memory:");
    applyCoreMigrations(database, "0019");
    seedCatalogAuthority(database);
    database.prepare("UPDATE catalogs SET active_commit_sha=? WHERE id=?").run("f".repeat(40), CATALOG_ID);
    database.exec(readFileSync(join(process.cwd(), "migrations/core/0020_contest_v2_runtime.sql"), "utf8"));
    insertSyncJob(database, FIRST_JOB, "running");
    const env = {
      DB: new SqliteD1(database) as unknown as D1Database,
      ACCOUNT_ERASURE_HMAC_SECRET: "test-contest-rollout-hmac-secret-0000000000000000",
    } as WasmOjWorkerEnv;

    expect(database.prepare(`SELECT state, legacy_active_commit, resynced_commit
      FROM catalog_contest_v2_resync_requirements WHERE catalog_id=?`).get(CATALOG_ID)).toEqual({
      state: "pending", legacy_active_commit: "f".repeat(40), resynced_commit: null,
    });
    await persistCatalogSync(env, context(FIRST_JOB), [problem()], [contest]);
    expect(database.prepare(`SELECT state, resynced_commit, resynced_at IS NOT NULL AS resynced
      FROM catalog_contest_v2_resync_requirements WHERE catalog_id=?`).get(CATALOG_ID)).toEqual({
      state: "ready", resynced_commit: COMMIT, resynced: 1,
    });
  });

  it("replays the same commit idempotently without overwriting invite operational state", async () => {
    const { database, env } = databaseFixture();
    await persistCatalogSync(env, context(FIRST_JOB), [problem()], [contest]);
    const contestId = database.prepare("SELECT id FROM contest_series WHERE slug='weekly'").get()!.id as string;
    database.prepare("UPDATE contest_series SET invite_code_hash='operational-hmac' WHERE id=?").run(contestId);
    insertSyncJob(database, SECOND_JOB, "running");

    await persistCatalogSync(env, context(SECOND_JOB), [problem()], [contest]);

    expect(database.prepare("SELECT active_commit_sha FROM catalogs WHERE id=?").get(CATALOG_ID)).toEqual({ active_commit_sha: COMMIT });
    expect(database.prepare("SELECT COUNT(*) AS count FROM problem_revisions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM contest_rule_revisions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM contest_rule_problems").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM contest_rule_checkpoints").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM contest_revisions").get()).toEqual({ count: 0 });
    expect(database.prepare(`SELECT active_rules_commit, pending_rules_commit, rules_epoch,
      timeline_generation, state FROM contest_runtimes WHERE contest_id=?`).get(contestId)).toEqual({
      active_rules_commit: COMMIT, pending_rules_commit: null,
      rules_epoch: 1, timeline_generation: 1, state: "scheduled",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM contest_rule_epochs WHERE contest_id=?").get(contestId))
      .toEqual({ count: 1 });
    expect(database.prepare(`SELECT content_epoch, judge_epoch, content_commit, judge_commit, state
      FROM contest_problem_epochs WHERE contest_id=?`).get(contestId)).toEqual({
      content_epoch: 1, judge_epoch: 1, content_commit: COMMIT, judge_commit: COMMIT, state: "effective",
    });
    expect(database.prepare("SELECT invite_code_hash FROM contest_series WHERE id=?").get(contestId)).toEqual({ invite_code_hash: "operational-hmac" });
    expect(database.prepare(`SELECT clock_kind, official_track, evidence_at, scoring_kind,
      leaderboard_kind, leaderboard_freeze_after_seconds, ai_assist
      FROM contest_rule_revisions WHERE contest_id=?`).get(contestId)).toEqual({
      clock_kind: "global", official_track: "code", evidence_at: "judge-terminal",
      scoring_kind: "score", leaderboard_kind: "freeze",
      leaderboard_freeze_after_seconds: 3_000, ai_assist: "allowed",
    });
    expect(database.prepare(`SELECT batch, release_after_seconds, submission_closes_after_seconds,
      points, attempt_limit FROM contest_rule_problems WHERE contest_id=?`).get(contestId)).toEqual({
      batch: 1, release_after_seconds: 0, submission_closes_after_seconds: 3_600,
      points: 250, attempt_limit: 8,
    });
    expect(database.prepare("SELECT sync_job_id FROM catalog_deployments WHERE catalog_id=? AND commit_sha=?").get(CATALOG_ID, COMMIT))
      .toEqual({ sync_job_id: SECOND_JOB });
  });

  it("persists individual Prompt Program admission gates without a provider fallback", async () => {
    const { database, env } = databaseFixture();
    await persistCatalogSync(env, context(FIRST_JOB), [problem()], [promptContest]);
    const row = database.prepare(`SELECT clock_kind, global_starts_at, official_track,
      evidence_at, ai_assist, prompt_compiler_config_id, prompt_compiler_config_sha256,
      prompt_max_bytes, prompt_input_tokens, prompt_output_tokens,
      prompt_generated_source_bytes, prompt_timeout_seconds, prompt_disclosure
      FROM contest_rule_revisions`).get();
    expect(row).toEqual({
      clock_kind: "individual", global_starts_at: null, official_track: "prompt-program",
      evidence_at: "generated-source-ready", ai_assist: null,
      prompt_compiler_config_id: "fake-v1", prompt_compiler_config_sha256: "4".repeat(64),
      prompt_max_bytes: 16_384, prompt_input_tokens: 4_096, prompt_output_tokens: 8_192,
      prompt_generated_source_bytes: 1_048_576, prompt_timeout_seconds: 120,
      prompt_disclosure: "best-after-end",
    });
    expect(database.prepare(`SELECT output_language, output_target,
      output_optimization, output_entry_path FROM contest_rule_problems`).get()).toEqual({
      output_language: "c", output_target: "wasip1",
      output_optimization: "release", output_entry_path: "main.c",
    });
    const problemId = database.prepare("SELECT id FROM problem_series WHERE slug='sum'").get()!.id as string;
    const contestId = database.prepare("SELECT id FROM contest_series WHERE slug='prompt-sprint'").get()!.id as string;
    expect(database.prepare(`SELECT sha256, bytes, storage_key
      FROM prompt_public_contexts ORDER BY sha256`).all()).toEqual([
      {
        sha256: "1".repeat(64),
        bytes: 10,
        storage_key: `prompt-contexts/v1/${"1".repeat(64)}`,
      },
      {
        sha256: "2".repeat(64),
        bytes: 9,
        storage_key: `prompt-contexts/v1/${"2".repeat(64)}`,
      },
    ]);
    expect(database.prepare(`SELECT contest_id, problem_id, content_epoch, public_context_sha256
      FROM contest_problem_prompt_contexts`).get()).toEqual({
      contest_id: contestId,
      problem_id: problemId,
      content_epoch: 1,
      public_context_sha256: "2".repeat(64),
    });
  });

  it("rejects a persisted prompt-context descriptor conflict instead of trusting ON CONFLICT", async () => {
    const { database, env } = databaseFixture();
    database.prepare(`INSERT INTO prompt_public_contexts (sha256, bytes, storage_key, created_at)
      VALUES (?, 999, 'prompt-contexts/v1/corrupt', ?)`)
      .run("1".repeat(64), NOW);

    await expect(persistCatalogSync(env, context(FIRST_JOB), [problem()], [contest]))
      .rejects.toThrow(/conflicts with its persisted descriptor/);
    expect(database.prepare("SELECT active_commit_sha FROM catalogs WHERE id=?").get(CATALOG_ID))
      .toEqual({ active_commit_sha: null });
  });

  it("advances live content and judge epochs while snapshotting the official timeline for atomic rejudge", async () => {
    const { database, env } = databaseFixture();
    await persistCatalogSync(env, context(FIRST_JOB), [problem()], [contest]);
    const contestId = database.prepare("SELECT id FROM contest_series WHERE slug='weekly'").get()!.id as string;
    const problemId = database.prepare("SELECT id FROM problem_series WHERE slug='sum'").get()!.id as string;
    const entrantId = "bbbbbbbb-1111-4111-8111-111111111111";
    const sourceId = "cccccccc-1111-4111-8111-111111111111";
    const submissionId = "dddddddd-1111-4111-8111-111111111111";
    database.prepare(`UPDATE contest_runtimes
      SET state='running', wall_anchor_at=?, first_started_at=?, updated_at=?
      WHERE contest_id=?`).run(NOW, NOW, NOW, contestId);
    database.prepare(`INSERT INTO contest_entrants
      (id, contest_id, kind, subject_key, account_user_id, owner_user_id,
       joined_at, started_at, start_timeline_generation, individual_wall_anchor_at,
       individual_logical_anchor_seconds, state, state_timeline_generation,
       created_at, updated_at)
      VALUES (?, ?, 'account', ?, ?, ?, ?, ?, 1, NULL, 0, 'active', 1, ?, ?)`)
      .run(entrantId, contestId, USER_ID, USER_ID, USER_ID, NOW, NOW, NOW, NOW);
    database.prepare(`INSERT INTO submission_sources
      (id, owner_user_id, admission_erasure_epoch, content_sha256, bytes, state,
       source_kind, created_at, ready_at)
      VALUES (?, ?, 0, ?, 10, 'ready', 'prompt-generated', ?, ?)`)
      .run(sourceId, USER_ID, "7".repeat(64), NOW, NOW);
    database.prepare(`INSERT INTO submissions
      (id, origin_submission_id, origin_submitted_at, user_id, problem_id,
       catalog_commit, judge_digest, contest_id, source_id, language, target,
       optimization, entry_path, state, verdict, visibility, score,
       fully_passed_cases, deterministic_cost, peak_memory_bytes,
       policy_summary_json, effective_attempt, admitted_at, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'c', 'wasip1', 'release', 'main.c',
        'completed', 'wrong-answer', 'private', 40, 1, 10, 1024, '{}', 1, ?, ?, ?, ?)`)
      .run(
        submissionId, submissionId, NOW, USER_ID, problemId, COMMIT,
        "3".repeat(64), contestId, sourceId, NOW, NOW, NOW, NOW,
      );
    database.prepare(`INSERT INTO contest_submission_records
      (submission_id, contest_id, entrant_id, timeline_generation, rules_epoch,
       content_epoch, judge_epoch, admitted_logical_seconds, evidence_at,
       evidence_logical_seconds, eligibility, created_at)
      VALUES (?, ?, ?, 1, 1, 1, 1, 10, 'judge-terminal', 10, 'eligible', ?)`)
      .run(submissionId, contestId, entrantId, NOW);

    const updatedCommit = "b".repeat(40);
    insertSyncJob(database, UPDATED_JOB, "running", updatedCommit);
    const updatedProblem: ValidatedCatalogProblem = {
      ...problem(),
      source: {
        ...problem().source,
        contestBundle: { path: "collection/sum.contest.json", bytes: 11, sha256: "5".repeat(64) },
        judgePackage: { path: "collection/sum.wasmojjudge", bytes: 21, sha256: "6".repeat(64) },
      },
    };
    await persistCatalogSync(env, context(UPDATED_JOB, updatedCommit), [updatedProblem], [contest]);

    expect(database.prepare(`SELECT problem_epoch, content_epoch, judge_epoch,
      content_commit, judge_commit, judge_digest, state, rollout_batch_id
      FROM contest_problem_epochs WHERE contest_id=? AND state='effective'`).get(contestId))
      .toMatchObject({
        problem_epoch: 2,
        content_epoch: 2,
        judge_epoch: 2,
        content_commit: updatedCommit,
        judge_commit: updatedCommit,
        judge_digest: "6".repeat(64),
        state: "effective",
      });
    const batch = database.prepare(`SELECT id, from_commit, to_commit, state,
      expected_count, purpose, rollout_attempt, snapshot_timeline_generation
      FROM rejudge_batches WHERE purpose='contest-judge-rollout'`).get()!;
    expect(batch).toMatchObject({
      from_commit: COMMIT,
      to_commit: updatedCommit,
      state: "queued",
      expected_count: 1,
      purpose: "contest-judge-rollout",
      rollout_attempt: 1,
      snapshot_timeline_generation: 1,
    });
    expect(database.prepare(`SELECT origin_submission_id, state
      FROM contest_judge_rollout_origins WHERE rejudge_batch_id=?`).get(batch.id))
      .toEqual({ origin_submission_id: submissionId, state: "included" });
    expect(database.prepare(`SELECT public_context_sha256 FROM contest_problem_prompt_contexts
      WHERE contest_id=? AND problem_id=? AND content_epoch=2`).get(contestId, problemId))
      .toEqual({ public_context_sha256: "5".repeat(64) });

    database.prepare(`UPDATE rejudge_batches
      SET state='failed', failure_code='rejudge-child-failed', updated_at=?
      WHERE id=?`).run(NOW, batch.id);
    insertSyncJob(database, ROLLOUT_RETRY_JOB, "running", updatedCommit);
    await persistCatalogSync(env, context(ROLLOUT_RETRY_JOB, updatedCommit), [updatedProblem], [contest]);
    const retries = database.prepare(`SELECT id, state, rollout_attempt, expected_count
      FROM rejudge_batches WHERE purpose='contest-judge-rollout' ORDER BY rollout_attempt`).all();
    expect(retries).toHaveLength(2);
    expect(retries[1]).toMatchObject({ state: "queued", rollout_attempt: 2, expected_count: 1 });
    expect(database.prepare(`SELECT rollout_batch_id FROM contest_problem_epochs
      WHERE contest_id=? AND problem_id=? AND state='effective'`).get(contestId, problemId))
      .toEqual({ rollout_batch_id: retries[1]!.id });

    const directSourceId = "eeeeeeee-1111-4111-8111-111111111111";
    const directSubmissionId = "ffffffff-1111-4111-8111-111111111111";
    database.prepare(`INSERT INTO submission_sources
      (id, owner_user_id, admission_erasure_epoch, content_sha256, bytes, state,
       source_kind, created_at, ready_at)
      VALUES (?, ?, 0, ?, 10, 'ready', 'user-code', ?, ?)`)
      .run(directSourceId, USER_ID, "8".repeat(64), NOW, NOW);
    database.prepare(`INSERT INTO submissions
      (id, origin_submission_id, origin_submitted_at, user_id, problem_id,
       catalog_commit, judge_digest, contest_id, source_id, language, target,
       optimization, entry_path, state, verdict, visibility, score,
       fully_passed_cases, deterministic_cost, peak_memory_bytes,
       policy_summary_json, effective_attempt, admitted_at, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'c', 'wasip1', 'release', 'main.c',
        'completed', 'accepted', 'private', 100, 1, 5, 512, '{}', 1, ?, ?, ?, ?)`)
      .run(
        directSubmissionId, directSubmissionId, NOW, USER_ID, problemId,
        updatedCommit, "6".repeat(64), contestId, directSourceId,
        NOW, NOW, NOW, NOW,
      );
    database.prepare(`INSERT INTO contest_submission_records
      (submission_id, contest_id, entrant_id, timeline_generation, rules_epoch,
       content_epoch, judge_epoch, admitted_logical_seconds, evidence_at,
       evidence_logical_seconds, eligibility, created_at)
      VALUES (?, ?, ?, 1, 1, 2, 2, 20, 'judge-terminal', 20, 'eligible', ?)`)
      .run(directSubmissionId, contestId, entrantId, NOW);

    const before = await queryContestLeaderboard(env.DB, { contestId, limit: 10 });
    expect(before[0]).toMatchObject({ provisional: true });
    expect(before[0]!.problemResults).toEqual([{ problemId, score: 40, fullyPassedCases: 1 }]);
    const frontierBefore = await queryPerformanceFrontier(env.DB, { contestId, problemId });
    expect(frontierBefore).toHaveLength(1);
    expect(frontierBefore[0]).toMatchObject({ score: 40 });

    await expect(materializeRejudgeBatch(env, retries[1]!.id as string)).resolves.toBe(true);
    const child = database.prepare(`SELECT child.id, child.source_id, child.catalog_commit,
      source.source_kind
      FROM rejudge_jobs AS jobs
      JOIN submissions AS child ON child.id=jobs.new_submission_id
      JOIN submission_sources AS source ON source.id=child.source_id
      WHERE jobs.rejudge_batch_id=?`).get(retries[1]!.id)!;
    expect(child).toMatchObject({
      source_id: sourceId,
      catalog_commit: updatedCommit,
      source_kind: "prompt-generated",
    });
    database.prepare(`UPDATE submissions SET state='completed', verdict='wrong-answer',
      score=60, fully_passed_cases=1, deterministic_cost=8, peak_memory_bytes=800,
      policy_summary_json='{}', effective_attempt=1, completed_at=?, updated_at=?
      WHERE id=?`).run(NOW, NOW, child.id);
    await expect(settleTerminalRejudgeJobs(env)).resolves.toBe(1);
    await expect(refreshRejudgeBatches(env)).resolves.toBe(1);

    expect(database.prepare(`SELECT state FROM rejudge_batches WHERE id=?`).get(retries[1]!.id))
      .toEqual({ state: "effective" });
    expect(database.prepare(`SELECT effective_submission_id FROM effective_rejudges
      WHERE origin_submission_id=?`).get(submissionId))
      .toEqual({ effective_submission_id: child.id });
    const after = await queryContestLeaderboard(env.DB, { contestId, limit: 10 });
    expect(after[0]).toMatchObject({ provisional: false });
    expect(after[0]!.problemResults).toEqual([{ problemId, score: 100, fullyPassedCases: 1 }]);
    const frontierAfter = await queryPerformanceFrontier(env.DB, { contestId, problemId });
    expect(frontierAfter).toHaveLength(1);
    expect(frontierAfter[0]).toMatchObject({ score: 100 });
  });

  it("stages later operational rules without replacing the active runtime epoch", async () => {
    const { database, env } = databaseFixture();
    await persistCatalogSync(env, context(FIRST_JOB), [problem()], [contest]);
    const updatedCommit = "b".repeat(40);
    insertSyncJob(database, UPDATED_JOB, "running", updatedCommit);
    const updatedContest: RepositoryContest = {
      ...contest,
      rules: {
        ...contest.rules,
        clock: { ...contest.rules.clock, durationSeconds: 7_200 },
        problems: contest.rules.problems.map((rule) => ({
          ...rule,
          submissionClosesAfterSeconds: 7_200,
        })),
        leaderboard: { kind: "freeze", atSeconds: 6_000 },
      },
    };

    await persistCatalogSync(env, context(UPDATED_JOB, updatedCommit), [problem()], [updatedContest]);

    const contestId = database.prepare("SELECT id FROM contest_series WHERE slug='weekly'").get()!.id as string;
    const runtime = database.prepare(`SELECT active_rules_commit, pending_rules_commit,
      rules_epoch, timeline_generation FROM contest_runtimes WHERE contest_id=?`).get(contestId);
    expect(runtime).toEqual({
      active_rules_commit: COMMIT,
      pending_rules_commit: updatedCommit,
      rules_epoch: 1,
      timeline_generation: 1,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM contest_rule_epochs WHERE contest_id=?").get(contestId))
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM contest_problem_epochs WHERE contest_id=?").get(contestId))
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT active_commit_sha FROM catalogs WHERE id=?").get(CATALOG_ID))
      .toEqual({ active_commit_sha: updatedCommit });
    const problemId = database.prepare("SELECT id FROM problem_series WHERE slug='sum'").get()!.id as string;
    await expect(loadSubmissionProblemRevisionForAdmission(env, problemId, COMMIT, "contest"))
      .resolves.toMatchObject({ commit_sha: COMMIT, active_commit_sha: updatedCommit });
    await expect(loadSubmissionProblemRevisionForAdmission(env, problemId, COMMIT, "practice"))
      .rejects.toMatchObject({ status: 409, code: "problem-revision-stale" });
  });

  it("cannot write projections or move the active commit after losing the running-state fence", async () => {
    const { database, env } = databaseFixture();
    await persistCatalogSync(env, context(FIRST_JOB), [problem()], [contest]);
    insertSyncJob(database, FAILED_JOB, "failed", "b".repeat(40));

    await expect(persistCatalogSync(env, context(FAILED_JOB, "b".repeat(40)), [problem()], [contest]))
      .rejects.toThrow("running-state fence");
    expect(database.prepare("SELECT active_commit_sha FROM catalogs WHERE id=?").get(CATALOG_ID)).toEqual({ active_commit_sha: COMMIT });
    expect(database.prepare("SELECT COUNT(*) AS count FROM problem_revisions WHERE commit_sha=?").get("b".repeat(40))).toEqual({ count: 0 });

    insertSyncJob(database, RUNNING_FAILURE_JOB, "running");
    await failCatalogSync(env, RUNNING_FAILURE_JOB, new TypeError("invalid manifest"));
    expect(database.prepare("SELECT state, error_code FROM catalog_sync_jobs WHERE id=?").get(RUNNING_FAILURE_JOB))
      .toEqual({ state: "failed", error_code: "catalog-contract-invalid" });
    expect(database.prepare("SELECT active_commit_sha FROM catalogs WHERE id=?").get(CATALOG_ID))
      .toEqual({ active_commit_sha: COMMIT });
  });
});

describe("contest v2 storage migration", () => {
  it("stages persisted v1 contests for the deterministic application cutover", () => {
    const database = new DatabaseSync(":memory:");
    applyCoreMigrations(database, "0019");
    seedCatalogAuthority(database);
    const contestId = "77777777-7777-4777-8777-777777777777";
    database.prepare(`INSERT INTO contest_series
      (id, catalog_id, slug, invite_code_hash, created_at)
      VALUES (?, ?, 'legacy', NULL, ?)`)
      .run(contestId, CATALOG_ID, NOW);
    database.prepare(`INSERT INTO contest_revisions
      (contest_id, commit_sha, status, title, description, access_mode,
       starts_at, ends_at, freeze_at, created_at)
      VALUES (?, ?, 'archived', 'Legacy', '', 'public',
       '2026-08-26T00:00:00Z', '2026-08-26T01:00:00Z', NULL, ?)`)
      .run(contestId, COMMIT, NOW);

    database.exec(readFileSync(join(process.cwd(), "migrations/core/0020_contest_v2_runtime.sql"), "utf8"));

    expect(database.prepare("SELECT title FROM contest_revisions WHERE contest_id=?").get(contestId))
      .toEqual({ title: "Legacy" });
    expect(database.prepare(`SELECT state, legacy_contest_count, legacy_revision_count,
      completed_contest_count FROM contest_v2_cutover_state`).get()).toEqual({
      state: "pending", legacy_contest_count: 1, legacy_revision_count: 1,
      completed_contest_count: 0,
    });
    expect(database.prepare(`SELECT state, source_revision_count,
      source_participant_count, source_submission_count
      FROM contest_v2_cutover_items WHERE contest_id=?`).get(contestId)).toEqual({
      state: "pending", source_revision_count: 1,
      source_participant_count: 0, source_submission_count: 0,
    });
    expect(database.prepare("SELECT blocker_kind FROM contest_v2_preflight_blockers").all())
      .toContainEqual({ blocker_kind: "contest-v2-cutover-not-complete" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("adds immutable source provenance for user and Prompt Program sources", () => {
    const { database } = databaseFixture();
    const sourceId = "88888888-8888-4888-8888-888888888888";
    database.prepare(`INSERT INTO submission_sources
      (id, owner_user_id, admission_erasure_epoch, content_sha256, bytes, state, created_at)
      VALUES (?, ?, 0, ?, 1, 'reserved', ?)`)
      .run(sourceId, USER_ID, "8".repeat(64), NOW);
    expect(database.prepare("SELECT source_kind FROM submission_sources WHERE id=?").get(sourceId))
      .toEqual({ source_kind: "user-code" });
    expect(() => database.prepare("UPDATE submission_sources SET source_kind='prompt-generated' WHERE id=?").run(sourceId))
      .toThrow("submission source kind is immutable");
  });

  it("retains released prompt quota history while atomically freeing its live slot", async () => {
    const { database, env } = databaseFixture();
    await persistCatalogSync(env, context(FIRST_JOB), [problem()], [promptContest]);
    const contestId = database.prepare("SELECT id FROM contest_series WHERE slug='prompt-sprint'").get()!.id as string;
    const problemId = database.prepare("SELECT id FROM problem_series WHERE slug='sum'").get()!.id as string;
    const entrantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const firstAttempt = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const secondAttempt = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const promptText = "solve this";
    const promptDigest = createHash("sha256").update(promptText).digest("hex");
    const contextDigest = createHash("sha256").update("{}").digest("hex");
    database.prepare(`INSERT INTO contest_entrants
      (id, contest_id, kind, subject_key, account_user_id, owner_user_id,
       joined_at, started_at, start_timeline_generation, individual_wall_anchor_at,
       individual_logical_anchor_seconds, state, state_timeline_generation, created_at, updated_at)
      VALUES (?, ?, 'account', ?, ?, ?, ?, ?, 1, ?, 0, 'active', 1, ?, ?)`)
      .run(entrantId, contestId, USER_ID, USER_ID, USER_ID, NOW, NOW, NOW, NOW, NOW);
    database.prepare(`INSERT INTO prompt_public_contexts (sha256, bytes, storage_key, created_at)
      VALUES (?, 2, 'prompt-context/v1', ?)`)
      .run(contextDigest, NOW);
    const insertAttempt = database.prepare(`INSERT INTO prompt_attempts
      (id, contest_id, entrant_id, problem_id, timeline_generation, rules_epoch,
       problem_epoch, content_epoch, judge_epoch, compiler_config_id, compiler_config_sha256,
       public_context_sha256, prompt_text, prompt_bytes, prompt_sha256,
       output_language, output_target, output_optimization, output_entry_path,
       state, admitted_logical_seconds, eligibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 1, 1, 1, 1, 'fake-v1', ?, ?, ?, ?, ?,
       'c', 'wasip1', 'release', 'main.c', 'reserved', 0, 'eligible', ?, ?)`);
    for (const attemptId of [firstAttempt, secondAttempt]) {
      insertAttempt.run(
        attemptId, contestId, entrantId, problemId, "4".repeat(64), contextDigest,
        promptText, Buffer.byteLength(promptText), promptDigest, NOW, NOW,
      );
    }
    const reserve = database.prepare(`INSERT INTO prompt_attempt_quota
      (prompt_attempt_id, contest_id, entrant_id, problem_id, timeline_generation,
       quota_slot, configured_limit, state, reserved_at)
      VALUES (?, ?, ?, ?, 1, 1, 3, 'reserved', ?)`);
    reserve.run(firstAttempt, contestId, entrantId, problemId, NOW);
    expect(() => reserve.run(secondAttempt, contestId, entrantId, problemId, NOW)).toThrow("UNIQUE constraint failed");

    database.prepare(`UPDATE prompt_attempt_quota
      SET state='released', settled_at=?, settlement_reason='provider-failure'
      WHERE prompt_attempt_id=?`).run(NOW, firstAttempt);
    reserve.run(secondAttempt, contestId, entrantId, problemId, NOW);

    expect(database.prepare(`SELECT state, COUNT(*) AS count FROM prompt_attempt_quota
      GROUP BY state ORDER BY state`).all()).toEqual([
      { state: "released", count: 1 },
      { state: "reserved", count: 1 },
    ]);
  });

  it("permits only account-erasure rebinding of contest actors and account entrants", async () => {
    const { database, env } = databaseFixture();
    await persistCatalogSync(env, context(FIRST_JOB), [problem()], [contest]);
    const contestId = database.prepare("SELECT id FROM contest_series WHERE slug='weekly'").get()!.id as string;
    const entrantId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const anonymousUserId = `erased-${"e".repeat(32)}`;
    const erasureJobId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    database.prepare(`INSERT INTO contest_entrants
      (id, contest_id, kind, subject_key, account_user_id, owner_user_id,
       joined_at, individual_logical_anchor_seconds, state,
       state_timeline_generation, created_at, updated_at)
      VALUES (?, ?, 'account', ?, ?, ?, ?, 0, 'joined', 1, ?, ?)`)
      .run(entrantId, contestId, USER_ID, USER_ID, USER_ID, NOW, NOW, NOW);
    database.prepare(`INSERT INTO contest_timeline_events
      (contest_id, event_key, event_type, from_generation, to_generation,
       logical_seconds, target_logical_seconds, actor_user_id, payload_json, created_at)
      VALUES (?, 'test:pause', 'pause', 1, 1, 0, NULL, ?, '{}', ?)`)
      .run(contestId, USER_ID, NOW);

    expect(() => database.prepare("UPDATE contest_rule_epochs SET activated_by=activated_by WHERE contest_id=?")
      .run(contestId)).toThrow("actor may change only for account erasure");
    expect(() => database.prepare("UPDATE contest_timeline_events SET payload_json='null' WHERE contest_id=?")
      .run(contestId)).toThrow("timeline event history is immutable");
    expect(() => database.prepare("UPDATE contest_entrants SET owner_user_id=owner_user_id WHERE id=?")
      .run(entrantId)).toThrow("account may change only for account erasure");

    database.prepare(`INSERT INTO users
      (id, created_at, updated_at, status, erasure_epoch)
      VALUES (?, ?, ?, 'suspended', 0)`).run(anonymousUserId, NOW, NOW);
    database.prepare(`INSERT INTO account_erasure_jobs
      (id, user_id, anonymous_user_id, status, requested_at, updated_at)
      VALUES (?, ?, ?, 'anonymizing', ?, ?)`)
      .run(erasureJobId, USER_ID, anonymousUserId, NOW, NOW);
    database.prepare("UPDATE contest_rule_epochs SET activated_by=? WHERE activated_by=?")
      .run(anonymousUserId, USER_ID);
    database.prepare("UPDATE contest_timeline_events SET actor_user_id=? WHERE actor_user_id=?")
      .run(anonymousUserId, USER_ID);
    database.prepare(`UPDATE contest_entrants
      SET subject_key=?, account_user_id=?, owner_user_id=?
      WHERE id=? AND account_user_id=?`)
      .run(anonymousUserId, anonymousUserId, anonymousUserId, entrantId, USER_ID);

    expect(database.prepare("SELECT activated_by FROM contest_rule_epochs WHERE contest_id=?").get(contestId))
      .toEqual({ activated_by: anonymousUserId });
    expect(database.prepare("SELECT actor_user_id, payload_json FROM contest_timeline_events WHERE contest_id=?").get(contestId))
      .toEqual({ actor_user_id: anonymousUserId, payload_json: "{}" });
    expect(database.prepare(`SELECT subject_key, account_user_id, owner_user_id, joined_at,
      state, state_timeline_generation FROM contest_entrants WHERE id=?`).get(entrantId)).toEqual({
      subject_key: anonymousUserId,
      account_user_id: anonymousUserId,
      owner_user_id: anonymousUserId,
      joined_at: NOW,
      state: "joined",
      state_timeline_generation: 1,
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
