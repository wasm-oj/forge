import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type {
  CodeContestProblemRule,
  ContestCheckpointRule,
} from "../src/online-judge/contest-rules";
import type { RepositoryContest } from "../src/online-judge/repository-contract";
import {
  reconcileContestCheckpoints,
  reconcileContestCheckpointsForContest,
} from "./contest-checkpoints";
import {
  persistCatalogSync,
  type CatalogSyncContext,
  type ValidatedCatalogProblem,
} from "./catalog-persistence";
import type { WasmOjWorkerEnv } from "./env";

class Statement {
  private bindings: SQLInputValue[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]) { this.bindings = values as SQLInputValue[]; return this; }
  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null;
  }
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

const NOW = new Date("2026-08-26T00:03:20.000Z");
const CREATED_AT = "2026-08-26T00:00:00.000Z";
const COMMIT = "a".repeat(40);
const CATALOG_ID = "10000000-0000-4000-8000-000000000001";
const ORGANIZER_ID = "10000000-0000-4000-8000-000000000002";
const JOB_ID = "10000000-0000-4000-8000-000000000003";
const ENTRANT_A_USER = "10000000-0000-4000-8000-000000000011";
const ENTRANT_B_USER = "10000000-0000-4000-8000-000000000012";
const ENTRANT_C_USER = "10000000-0000-4000-8000-000000000013";
const ENTRANT_D_USER = "10000000-0000-4000-8000-000000000014";

interface Fixture {
  readonly database: DatabaseSync;
  readonly env: WasmOjWorkerEnv;
  readonly contestId: string;
  readonly problemId: string;
}

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations/core");
  for (const filename of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function problem(slug = "sum", order = 1): ValidatedCatalogProblem {
  return {
    source: {
      slug, order, title: { "zh-TW": slug, en: slug },
      summary: { "zh-TW": "計算", en: "Compute" }, practiceEnabled: true,
      practiceBundle: { path: `${slug}.practice.json`, bytes: 10, sha256: "1".repeat(64) },
      contestBundle: { path: `${slug}.contest.json`, bytes: 10, sha256: "2".repeat(64) },
      judgePackage: { path: `${slug}.wasmojjudge`, bytes: 10, sha256: "3".repeat(64) },
    },
    allowedProfilesJson: JSON.stringify({ c: { target: "wasip1", optimization: "release" } }),
  };
}

const DEFAULT_PROBLEM_RULES = [{
  slug: "sum", batch: 1, releaseAfterSeconds: 0,
  submissionClosesAfterSeconds: 600, points: 100, attemptLimit: 8,
}] satisfies readonly CodeContestProblemRule[];

function contest(
  checkpoint: ContestCheckpointRule,
  problemRules: readonly CodeContestProblemRule[] = DEFAULT_PROBLEM_RULES,
): RepositoryContest {
  return {
    slug: "checkpoint", status: "published", title: "Checkpoint", description: "",
    accessMode: "public",
    rules: {
      clock: {
        kind: "global",
        registrationOpensAt: "2026-08-25T00:00:00Z",
        registrationClosesAt: "2026-08-26T00:00:00Z",
        startsAt: "2026-08-26T00:00:00Z",
        durationSeconds: 600,
      },
      officialTrack: { kind: "code", aiAssist: "disabled" },
      evidenceAt: "judge-terminal",
      problems: problemRules,
      scoring: { kind: "score", tieBreaks: ["final-best-achieved-at"] },
      checkpoints: [checkpoint],
      leaderboard: { kind: "live" },
    },
  };
}

async function fixture(
  checkpoint: ContestCheckpointRule,
  problemRules: readonly CodeContestProblemRule[] = DEFAULT_PROBLEM_RULES,
): Promise<Fixture> {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  const env = { DB: new SqliteD1(database) as unknown as D1Database } as WasmOjWorkerEnv;
  database.prepare("INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'active')")
    .run(ORGANIZER_ID, CREATED_AT, CREATED_AT);
  database.prepare(`INSERT INTO github_installations
    (installation_id, account_github_id, account_login, installed_by_user_id,
     status, permissions_json, repository_selection, created_at, updated_at)
    VALUES (1, 42, 'wasm-oj', ?, 'active', '{}', 'all', ?, ?)`)
    .run(ORGANIZER_ID, CREATED_AT, CREATED_AT);
  database.prepare(`INSERT INTO github_repositories
    (github_repository_id, installation_id, owner_login, name, is_private,
     authorization_status, updated_at)
    VALUES (42, 1, 'wasm-oj', 'problems', 1, 'authorized', ?)`)
    .run(CREATED_AT);
  database.prepare(`INSERT INTO catalogs
    (id, organizer_user_id, github_repository_id, active_commit_sha, created_at, updated_at)
    VALUES (?, ?, 42, NULL, ?, ?)`)
    .run(CATALOG_ID, ORGANIZER_ID, CREATED_AT, CREATED_AT);
  database.prepare(`INSERT INTO catalog_sync_jobs
    (id, catalog_id, requested_ref, commit_sha, state, requested_by,
     idempotency_key, request_digest, created_at, updated_at, started_at)
    VALUES (?, ?, 'main', ?, 'running', ?, 'checkpoint-fixture', ?, ?, ?, ?)`)
    .run(
      JOB_ID, CATALOG_ID, COMMIT, ORGANIZER_ID,
      createHash("sha256").update("checkpoint-fixture").digest("hex"),
      CREATED_AT, CREATED_AT, CREATED_AT,
    );
  const context: CatalogSyncContext = {
    jobId: JOB_ID,
    catalogId: CATALOG_ID,
    githubRepositoryId: 42,
    commitSha: COMMIT,
    requestedBy: ORGANIZER_ID,
    state: "running",
  };
  await persistCatalogSync(
    env,
    context,
    problemRules.map((rule, index) => problem(rule.slug, index + 1)),
    [contest(checkpoint, problemRules)],
  );
  const contestId = database.prepare("SELECT id FROM contest_series WHERE slug='checkpoint'").get()!.id as string;
  const problemId = database.prepare("SELECT id FROM problem_series WHERE slug='sum'").get()!.id as string;
  database.prepare(`UPDATE contest_runtimes
    SET state='running', wall_anchor_at=?, first_started_at=?, updated_at=?
    WHERE contest_id=?`).run(CREATED_AT, CREATED_AT, CREATED_AT, contestId);
  return { database, env, contestId, problemId };
}

function addEntrant(fixtureValue: Fixture, userId: string, entrantId: string): void {
  fixtureValue.database.prepare(
    "INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'active')",
  ).run(userId, CREATED_AT, CREATED_AT);
  fixtureValue.database.prepare(`INSERT INTO contest_entrants
    (id, contest_id, kind, subject_key, account_user_id, owner_user_id,
     joined_at, started_at, start_timeline_generation,
     individual_logical_anchor_seconds, state, state_timeline_generation,
     created_at, updated_at)
    VALUES (?, ?, 'account', ?, ?, ?, ?, ?, 1, 0, 'active', 1, ?, ?)`)
    .run(
      entrantId, fixtureValue.contestId, userId, userId, userId,
      CREATED_AT, CREATED_AT, CREATED_AT, CREATED_AT,
    );
}

function addSubmission(
  fixtureValue: Fixture,
  input: {
    readonly id: string;
    readonly entrantId: string;
    readonly userId: string;
    readonly admitted: number;
    readonly state: "queued" | "completed";
    readonly score?: number;
    readonly evidence?: number;
    readonly problemId?: string;
  },
): void {
  const sourceId = input.id.replace(/^./, "f");
  const digest = createHash("sha256").update(input.id).digest("hex");
  fixtureValue.database.prepare(`INSERT INTO submission_sources
    (id, owner_user_id, admission_erasure_epoch, content_sha256, bytes, state, created_at)
    VALUES (?, ?, 0, ?, 1, 'reserved', ?)`)
    .run(sourceId, input.userId, digest, CREATED_AT);
  fixtureValue.database.prepare("UPDATE submission_sources SET state='ready', ready_at=? WHERE id=?")
    .run(CREATED_AT, sourceId);
  const terminal = input.state === "completed";
  fixtureValue.database.prepare(`INSERT INTO submissions
    (id, origin_submission_id, origin_submitted_at, user_id, problem_id,
     catalog_commit, judge_digest, contest_id, source_id, language, target,
     optimization, entry_path, state, verdict, visibility, score,
     fully_passed_cases, deterministic_cost, peak_memory_bytes,
     policy_summary_json, effective_attempt, admitted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'c', 'wasip1', 'release', 'main.c',
      ?, ?, 'private', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.id, input.id, CREATED_AT, input.userId, input.problemId ?? fixtureValue.problemId,
      COMMIT, "3".repeat(64), fixtureValue.contestId, sourceId,
      input.state, terminal ? (input.score === 100 ? "accepted" : "wrong-answer") : null,
      terminal ? input.score ?? 0 : null,
      terminal ? (input.score === 100 ? 1 : 0) : null,
      terminal ? 100 : null,
      terminal ? 1024 : null,
      terminal ? "{}" : null,
      terminal ? 1 : null,
      CREATED_AT, CREATED_AT, CREATED_AT, terminal ? CREATED_AT : null,
    );
  fixtureValue.database.prepare(`INSERT INTO contest_submission_records
    (submission_id, contest_id, entrant_id, timeline_generation, rules_epoch,
     content_epoch, judge_epoch, admitted_logical_seconds, evidence_at,
     evidence_logical_seconds, eligibility, created_at)
    VALUES (?, ?, ?, 1, 1, 1, 1, ?, 'judge-terminal', ?, 'eligible', ?)`)
    .run(input.id, fixtureValue.contestId, input.entrantId, input.admitted, input.evidence ?? null, CREATED_AT);
}

function settleSubmission(fixtureValue: Fixture, submissionId: string, score: number, evidence: number): void {
  fixtureValue.database.prepare(`UPDATE submissions
    SET state='completed', verdict=?, score=?, fully_passed_cases=?,
        deterministic_cost=100, peak_memory_bytes=1024, policy_summary_json='{}',
        effective_attempt=1, updated_at=?, completed_at=?
    WHERE id=?`).run(
    score === 100 ? "accepted" : "wrong-answer",
    score,
    score === 100 ? 1 : 0,
    CREATED_AT,
    CREATED_AT,
    submissionId,
  );
  fixtureValue.database.prepare(`UPDATE contest_submission_records
    SET evidence_logical_seconds=? WHERE submission_id=?`).run(evidence, submissionId);
}

function addUnsettledJudgeRollout(fixtureValue: Fixture, problemId = fixtureValue.problemId): string {
  const batchId = crypto.randomUUID();
  const toCommit = "b".repeat(40);
  fixtureValue.database.prepare(`INSERT INTO problem_revisions
      (problem_id, commit_sha, ordinal, title_json, summary_json, practice_enabled,
       practice_bundle_path, practice_bundle_bytes, practice_bundle_sha256,
       contest_bundle_path, contest_bundle_bytes, contest_bundle_sha256,
       judge_package_path, judge_package_bytes, judge_digest,
       allowed_profiles_json, created_at)
    SELECT problem_id, ?, ordinal, title_json, summary_json, practice_enabled,
      practice_bundle_path, practice_bundle_bytes, practice_bundle_sha256,
      contest_bundle_path, contest_bundle_bytes, contest_bundle_sha256,
      judge_package_path, judge_package_bytes, ?, allowed_profiles_json, ?
    FROM problem_revisions WHERE problem_id=? AND commit_sha=?`)
    .run(toCommit, "4".repeat(64), CREATED_AT, problemId, COMMIT);
  fixtureValue.database.prepare(`INSERT INTO rejudge_batches
    (id, problem_id, from_commit, to_commit, contest_id, requested_by, state,
     expected_count, idempotency_key, request_digest, created_at, updated_at,
     purpose, rollout_attempt, snapshot_timeline_generation)
    VALUES (?, ?, ?, ?, ?, ?, 'running', 1, ?, ?, ?, ?,
      'contest-judge-rollout', 1, 1)`)
    .run(
      batchId, problemId, COMMIT, toCommit, fixtureValue.contestId, ORGANIZER_ID,
      `checkpoint-rollout-${batchId}`, createHash("sha256").update(batchId).digest("hex"),
      CREATED_AT, CREATED_AT,
    );
  fixtureValue.database.prepare(`UPDATE contest_problem_epochs SET rollout_batch_id=?
    WHERE contest_id=? AND problem_id=? AND state='effective'`)
    .run(batchId, fixtureValue.contestId, problemId);
  return batchId;
}

function settleJudgeRollout(fixtureValue: Fixture, batchId: string): void {
  fixtureValue.database.prepare(`UPDATE rejudge_batches
    SET state='effective', effective_at=?, updated_at=? WHERE id=?`)
    .run(NOW.toISOString(), NOW.toISOString(), batchId);
}

function decisions(database: DatabaseSync): readonly Record<string, unknown>[] {
  return database.prepare(`SELECT entrants.subject_key, decisions.decision, decisions.provisional
    FROM contest_checkpoint_decisions AS decisions
    JOIN contest_entrants AS entrants ON entrants.id=decisions.entrant_id
    ORDER BY entrants.subject_key`).all() as Record<string, unknown>[];
}

describe("contest checkpoint reconciliation", () => {
  it("provisionally advances pending entrants, then eliminates failure and invalidates downstream work", async () => {
    const value = await fixture({
      id: "gate", atSeconds: 180, scope: { kind: "all-released" },
      threshold: { minimumSolved: 1, minimumScore: null },
      ranking: null, settlement: "provisional",
    });
    const entrantA = "20000000-0000-4000-8000-000000000011";
    const entrantB = "20000000-0000-4000-8000-000000000012";
    addEntrant(value, ENTRANT_A_USER, entrantA);
    addEntrant(value, ENTRANT_B_USER, entrantB);
    addSubmission(value, {
      id: "30000000-0000-4000-8000-000000000011",
      entrantId: entrantA, userId: ENTRANT_A_USER,
      admitted: 100, state: "completed", score: 100, evidence: 150,
    });
    const pendingId = "30000000-0000-4000-8000-000000000012";
    addSubmission(value, {
      id: pendingId, entrantId: entrantB, userId: ENTRANT_B_USER,
      admitted: 100, state: "queued",
    });
    const downstreamId = "30000000-0000-4000-8000-000000000013";
    addSubmission(value, {
      id: downstreamId, entrantId: entrantB, userId: ENTRANT_B_USER,
      admitted: 190, state: "queued",
    });

    const first = await reconcileContestCheckpoints(value.env, NOW);
    expect(first).toMatchObject({ created: 1, provisional: 1, finalized: 0, eliminated: 0 });
    expect(decisions(value.database)).toEqual([
      { subject_key: ENTRANT_A_USER, decision: "advanced", provisional: 0 },
      { subject_key: ENTRANT_B_USER, decision: "advanced", provisional: 1 },
    ]);
    expect(value.database.prepare("SELECT state, pending_work FROM contest_checkpoint_runs").get())
      .toEqual({ state: "provisional", pending_work: 1 });

    await reconcileContestCheckpoints(value.env, NOW);
    expect(value.database.prepare("SELECT COUNT(*) AS count FROM contest_checkpoint_runs").get())
      .toEqual({ count: 1 });
    settleSubmission(value, pendingId, 0, 170);

    const final = await reconcileContestCheckpoints(value.env, NOW);
    expect(final).toMatchObject({ finalized: 1, eliminated: 1 });
    expect(decisions(value.database)).toEqual([
      { subject_key: ENTRANT_A_USER, decision: "advanced", provisional: 0 },
      { subject_key: ENTRANT_B_USER, decision: "eliminated", provisional: 0 },
    ]);
    expect(value.database.prepare("SELECT state, eliminated_checkpoint_id FROM contest_entrants WHERE id=?").get(entrantB))
      .toEqual({ state: "eliminated", eliminated_checkpoint_id: "gate" });
    expect(value.database.prepare("SELECT eligibility, invalidation_reason FROM contest_submission_records WHERE submission_id=?").get(downstreamId))
      .toEqual({ eligibility: "invalid", invalidation_reason: "checkpoint:gate" });
    expect(await reconcileContestCheckpoints(value.env, NOW)).toMatchObject({ visited: 0, eliminated: 0 });
  });

  it("atomically pauses a pause-until-terminal boundary and resumes only after its bounded work settles", async () => {
    const value = await fixture({
      id: "stop", atSeconds: 180, scope: { kind: "all-released" },
      threshold: { minimumSolved: 1, minimumScore: null },
      ranking: null, settlement: "pause-until-terminal",
    });
    const entrant = "20000000-0000-4000-8000-000000000021";
    addEntrant(value, ENTRANT_A_USER, entrant);
    const submissionId = "30000000-0000-4000-8000-000000000021";
    addSubmission(value, {
      id: submissionId, entrantId: entrant, userId: ENTRANT_A_USER,
      admitted: 100, state: "queued",
    });

    const waiting = await reconcileContestCheckpointsForContest(value.env, value.contestId, NOW);
    expect(waiting).toMatchObject({ created: 1, paused: 1, finalized: 0 });
    expect(value.database.prepare("SELECT state, pause_reason, logical_anchor_seconds FROM contest_runtimes").get())
      .toEqual({
        state: "paused",
        pause_reason: "checkpoint:1:stop",
        logical_anchor_seconds: 180,
      });
    expect(value.database.prepare("SELECT state, pending_work FROM contest_checkpoint_runs").get())
      .toEqual({ state: "evaluating", pending_work: 1 });
    expect(value.database.prepare("SELECT COUNT(*) AS count FROM contest_timeline_events").get())
      .toEqual({ count: 1 });
    expect((await reconcileContestCheckpoints(value.env, NOW)).paused).toBe(0);

    settleSubmission(value, submissionId, 100, 180);
    const resumedAt = new Date(NOW.getTime() + 30_000);
    const settled = await reconcileContestCheckpoints(value.env, resumedAt);
    expect(settled).toMatchObject({ finalized: 1, resumed: 1, eliminated: 0 });
    expect(value.database.prepare(`SELECT state, pause_reason, paused_from_state,
      schedule_shift_seconds FROM contest_runtimes`).get())
      .toEqual({
        state: "running",
        pause_reason: null,
        paused_from_state: null,
        schedule_shift_seconds: 30,
      });
    expect(value.database.prepare("SELECT state, pending_work FROM contest_checkpoint_runs").get())
      .toEqual({ state: "final", pending_work: 0 });
    expect(value.database.prepare("SELECT COUNT(*) AS count FROM contest_timeline_events").get())
      .toEqual({ count: 2 });
  });

  it("keeps a provisional checkpoint provisional while a scoped judge rollout is unsettled", async () => {
    const value = await fixture({
      id: "rollout-provisional", atSeconds: 180, scope: { kind: "all-released" },
      threshold: { minimumSolved: 1, minimumScore: null },
      ranking: null, settlement: "provisional",
    });
    const entrant = "20000000-0000-4000-8000-000000000022";
    addEntrant(value, ENTRANT_A_USER, entrant);
    addSubmission(value, {
      id: "30000000-0000-4000-8000-000000000022",
      entrantId: entrant, userId: ENTRANT_A_USER,
      admitted: 100, state: "completed", score: 100, evidence: 150,
    });
    const rollout = addUnsettledJudgeRollout(value);

    expect(await reconcileContestCheckpoints(value.env, NOW)).toMatchObject({
      created: 1,
      provisional: 1,
      finalized: 0,
      eliminated: 0,
    });
    expect(decisions(value.database)).toEqual([
      { subject_key: ENTRANT_A_USER, decision: "advanced", provisional: 1 },
    ]);
    expect(value.database.prepare("SELECT state, pending_work FROM contest_checkpoint_runs").get())
      .toEqual({ state: "provisional", pending_work: 1 });

    settleJudgeRollout(value, rollout);
    expect(await reconcileContestCheckpoints(value.env, NOW)).toMatchObject({
      provisional: 0,
      finalized: 1,
      eliminated: 0,
    });
    expect(decisions(value.database)).toEqual([
      { subject_key: ENTRANT_A_USER, decision: "advanced", provisional: 0 },
    ]);
  });

  it("treats a scoped judge rollout as bounded pending work for pause-until-terminal", async () => {
    const value = await fixture({
      id: "rollout-pause", atSeconds: 180, scope: { kind: "all-released" },
      threshold: { minimumSolved: 1, minimumScore: null },
      ranking: null, settlement: "pause-until-terminal",
    });
    const entrant = "20000000-0000-4000-8000-000000000023";
    addEntrant(value, ENTRANT_A_USER, entrant);
    addSubmission(value, {
      id: "30000000-0000-4000-8000-000000000023",
      entrantId: entrant, userId: ENTRANT_A_USER,
      admitted: 100, state: "completed", score: 100, evidence: 150,
    });
    const rollout = addUnsettledJudgeRollout(value);

    expect(await reconcileContestCheckpoints(value.env, NOW)).toMatchObject({
      created: 1,
      paused: 1,
      finalized: 0,
    });
    expect(value.database.prepare("SELECT state, pending_work FROM contest_checkpoint_runs").get())
      .toEqual({ state: "evaluating", pending_work: 1 });
    expect(value.database.prepare("SELECT state FROM contest_runtimes").get())
      .toEqual({ state: "paused" });

    settleJudgeRollout(value, rollout);
    expect(await reconcileContestCheckpoints(value.env, new Date(NOW.getTime() + 10_000)))
      .toMatchObject({ finalized: 1, resumed: 1, eliminated: 0 });
    expect(value.database.prepare("SELECT state FROM contest_checkpoint_runs").get())
      .toEqual({ state: "final" });
  });

  it("does not reopen a checkpoint finalized before a later judge rollout", async () => {
    const value = await fixture({
      id: "rollout-after-final", atSeconds: 180, scope: { kind: "all-released" },
      threshold: { minimumSolved: 1, minimumScore: null },
      ranking: null, settlement: "provisional",
    });
    const entrant = "20000000-0000-4000-8000-000000000024";
    addEntrant(value, ENTRANT_A_USER, entrant);
    addSubmission(value, {
      id: "30000000-0000-4000-8000-000000000024",
      entrantId: entrant, userId: ENTRANT_A_USER,
      admitted: 100, state: "completed", score: 100, evidence: 150,
    });
    expect(await reconcileContestCheckpoints(value.env, NOW)).toMatchObject({ finalized: 1 });
    addUnsettledJudgeRollout(value);

    expect(await reconcileContestCheckpoints(value.env, NOW)).toMatchObject({ visited: 0, finalized: 0 });
    expect(value.database.prepare("SELECT state FROM contest_checkpoint_runs").get())
      .toEqual({ state: "final" });
  });

  it("does not hold a checkpoint for a rollout outside its problem scope", async () => {
    const problemRules = [
      ...DEFAULT_PROBLEM_RULES,
      {
        slug: "product", batch: 1, releaseAfterSeconds: 0,
        submissionClosesAfterSeconds: 600, points: 100, attemptLimit: 8,
      },
    ] satisfies readonly CodeContestProblemRule[];
    const value = await fixture({
      id: "rollout-other-problem", atSeconds: 180,
      scope: { kind: "problems", slugs: ["product"] },
      threshold: { minimumSolved: 1, minimumScore: null },
      ranking: null, settlement: "provisional",
    }, problemRules);
    const entrant = "20000000-0000-4000-8000-000000000026";
    const productId = value.database.prepare(
      "SELECT id FROM problem_series WHERE slug='product'",
    ).get()!.id as string;
    addEntrant(value, ENTRANT_A_USER, entrant);
    addSubmission(value, {
      id: "30000000-0000-4000-8000-000000000026",
      entrantId: entrant, userId: ENTRANT_A_USER, problemId: productId,
      admitted: 100, state: "completed", score: 100, evidence: 150,
    });
    addUnsettledJudgeRollout(value);

    expect(await reconcileContestCheckpoints(value.env, NOW)).toMatchObject({
      finalized: 1,
      provisional: 0,
      eliminated: 0,
    });
    expect(value.database.prepare("SELECT state, pending_work FROM contest_checkpoint_runs").get())
      .toEqual({ state: "final", pending_work: 0 });
  });

  it("does not create new checkpoint work while an organizer pause is active", async () => {
    const value = await fixture({
      id: "manual-pause", atSeconds: 180, scope: { kind: "all-released" },
      threshold: { minimumSolved: 1, minimumScore: null },
      ranking: null, settlement: "provisional",
    });
    const entrant = "20000000-0000-4000-8000-000000000025";
    addEntrant(value, ENTRANT_A_USER, entrant);
    addSubmission(value, {
      id: "30000000-0000-4000-8000-000000000025",
      entrantId: entrant, userId: ENTRANT_A_USER,
      admitted: 100, state: "completed", score: 100, evidence: 150,
    });
    value.database.prepare(`UPDATE contest_runtimes
      SET state='paused', wall_anchor_at=NULL, logical_anchor_seconds=200,
          pause_reason='organizer-maintenance', paused_at=?, paused_from_state='running', updated_at=?
      WHERE contest_id=?`).run(NOW.toISOString(), NOW.toISOString(), value.contestId);

    expect(await reconcileContestCheckpoints(value.env, NOW)).toMatchObject({ visited: 0, created: 0 });
    expect(value.database.prepare("SELECT COUNT(*) AS count FROM contest_checkpoint_runs").get())
      .toEqual({ count: 0 });
  });

  it("excludes an accepted result whose judge-terminal evidence arrives after the boundary", async () => {
    const value = await fixture({
      id: "evidence", atSeconds: 180, scope: { kind: "all-released" },
      threshold: { minimumSolved: 1, minimumScore: null },
      ranking: null, settlement: "provisional",
    });
    const entrant = "20000000-0000-4000-8000-000000000026";
    const submissionId = "30000000-0000-4000-8000-000000000026";
    addEntrant(value, ENTRANT_A_USER, entrant);
    addSubmission(value, {
      id: submissionId, entrantId: entrant, userId: ENTRANT_A_USER,
      admitted: 100, state: "queued",
    });
    await reconcileContestCheckpoints(value.env, NOW);
    settleSubmission(value, submissionId, 100, 181);

    expect(await reconcileContestCheckpoints(value.env, NOW)).toMatchObject({
      finalized: 1,
      eliminated: 1,
    });
    expect(decisions(value.database)).toEqual([
      { subject_key: ENTRANT_A_USER, decision: "eliminated", provisional: 0 },
    ]);
  });

  it("uses tie-inclusive competitive ranks at a top-K cutoff", async () => {
    const value = await fixture({
      id: "cut", atSeconds: 180, scope: { kind: "all-released" },
      threshold: { minimumSolved: null, minimumScore: 0 },
      ranking: { kind: "top-k", count: 1 }, settlement: "provisional",
    });
    const entrants = [
      [ENTRANT_A_USER, "20000000-0000-4000-8000-000000000031", 100],
      [ENTRANT_B_USER, "20000000-0000-4000-8000-000000000032", 100],
      [ENTRANT_C_USER, "20000000-0000-4000-8000-000000000033", 50],
    ] as const;
    for (const [userId, entrantId, score] of entrants) {
      addEntrant(value, userId, entrantId);
      addSubmission(value, {
        id: entrantId.replace(/^2/, "3"), entrantId, userId,
        admitted: 100, state: "completed", score, evidence: 150,
      });
    }

    const result = await reconcileContestCheckpoints(value.env, NOW);
    expect(result).toMatchObject({ finalized: 1, eliminated: 1, provisional: 0 });
    expect(decisions(value.database)).toEqual([
      { subject_key: ENTRANT_A_USER, decision: "advanced", provisional: 0 },
      { subject_key: ENTRANT_B_USER, decision: "advanced", provisional: 0 },
      { subject_key: ENTRANT_C_USER, decision: "eliminated", provisional: 0 },
    ]);
  });

  it("uses the active population ceiling and advances every tie at a top-percent cutoff", async () => {
    const value = await fixture({
      id: "percent", atSeconds: 180, scope: { kind: "all-released" },
      threshold: { minimumSolved: null, minimumScore: 0 },
      ranking: { kind: "top-percent", percent: 50 }, settlement: "provisional",
    });
    const entrants = [
      [ENTRANT_A_USER, "20000000-0000-4000-8000-000000000041", 100],
      [ENTRANT_B_USER, "20000000-0000-4000-8000-000000000042", 50],
      [ENTRANT_C_USER, "20000000-0000-4000-8000-000000000043", 50],
      [ENTRANT_D_USER, "20000000-0000-4000-8000-000000000044", 0],
    ] as const;
    for (const [userId, entrantId, score] of entrants) {
      addEntrant(value, userId, entrantId);
      addSubmission(value, {
        id: entrantId.replace(/^2/, "3"), entrantId, userId,
        admitted: 100, state: "completed", score, evidence: 150,
      });
    }

    const result = await reconcileContestCheckpoints(value.env, NOW);
    expect(result).toMatchObject({ finalized: 1, eliminated: 1 });
    expect(decisions(value.database)).toEqual([
      { subject_key: ENTRANT_A_USER, decision: "advanced", provisional: 0 },
      { subject_key: ENTRANT_B_USER, decision: "advanced", provisional: 0 },
      { subject_key: ENTRANT_C_USER, decision: "advanced", provisional: 0 },
      { subject_key: ENTRANT_D_USER, decision: "eliminated", provisional: 0 },
    ]);
  });

  it("evaluates batch and explicit-problem scopes without leaking results across scopes", async () => {
    const problemRules = [
      ...DEFAULT_PROBLEM_RULES,
      {
        slug: "product", batch: 2, releaseAfterSeconds: 120,
        submissionClosesAfterSeconds: 600, points: 100, attemptLimit: 8,
      },
    ] satisfies readonly CodeContestProblemRule[];
    const variants = [
      {
        checkpoint: {
          id: "batch", atSeconds: 180, scope: { kind: "batch", batch: 2 },
          threshold: { minimumSolved: 1, minimumScore: null },
          ranking: null, settlement: "provisional",
        } satisfies ContestCheckpointRule,
        expected: ["eliminated", "advanced"],
      },
      {
        checkpoint: {
          id: "listed", atSeconds: 180, scope: { kind: "problems", slugs: ["sum"] },
          threshold: { minimumSolved: 1, minimumScore: null },
          ranking: null, settlement: "provisional",
        } satisfies ContestCheckpointRule,
        expected: ["advanced", "eliminated"],
      },
    ] as const;
    for (const variant of variants) {
      const value = await fixture(variant.checkpoint, problemRules);
      const productId = value.database.prepare("SELECT id FROM problem_series WHERE slug='product'").get()!.id as string;
      const entrantA = "20000000-0000-4000-8000-000000000051";
      const entrantB = "20000000-0000-4000-8000-000000000052";
      addEntrant(value, ENTRANT_A_USER, entrantA);
      addEntrant(value, ENTRANT_B_USER, entrantB);
      addSubmission(value, {
        id: "30000000-0000-4000-8000-000000000051",
        entrantId: entrantA, userId: ENTRANT_A_USER,
        admitted: 100, state: "completed", score: 100, evidence: 150,
      });
      addSubmission(value, {
        id: "30000000-0000-4000-8000-000000000052",
        entrantId: entrantB, userId: ENTRANT_B_USER, problemId: productId,
        admitted: 130, state: "completed", score: 100, evidence: 150,
      });

      await reconcileContestCheckpoints(value.env, NOW);
      expect(decisions(value.database).map((decision) => decision.decision))
        .toEqual(variant.expected);
    }
  });
});
