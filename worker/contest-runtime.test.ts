import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryContest } from "../src/online-judge/repository-contract";
import {
  persistCatalogSync,
  type CatalogSyncContext,
  type ValidatedCatalogProblem,
} from "./catalog-persistence";
import type { AuthenticatedSession, WasmOjWorkerEnv } from "./env";

const ORGANIZER_ID = "10000000-0000-4000-8000-000000000001";
const CATALOG_ID = "10000000-0000-4000-8000-000000000002";
const FIRST_JOB_ID = "10000000-0000-4000-8000-000000000003";
const SECOND_JOB_ID = "10000000-0000-4000-8000-000000000004";
const ENTRANT_USER_ID = "10000000-0000-4000-8000-000000000011";
const ENTRANT_ID = "20000000-0000-4000-8000-000000000011";
const FIRST_COMMIT = "a".repeat(40);
const SECOND_COMMIT = "b".repeat(40);
const CREATED_AT = "2026-08-26T00:00:00.000Z";
const JUDGE_DIGEST = "3".repeat(64);
const CONTEXT_DIGEST = "2".repeat(64);
const COMPILER_DIGEST = "4".repeat(64);

const SESSION: AuthenticatedSession = {
  userId: ORGANIZER_ID,
  login: "organizer",
  avatarUrl: "https://example.test/avatar.png",
  roles: ["organizer"],
  expiresAt: "2027-01-01T00:00:00.000Z",
};

vi.mock("./auth", () => ({
  requireBrowserMutationSession: vi.fn(async () => SESSION),
  requireBrowserOrBearerMutationSession: vi.fn(async () => SESSION),
}));
vi.mock("./formal-mutations", () => ({ requireFormalMutationsEnabled: vi.fn(async () => undefined) }));
vi.mock("./github", () => ({ requireOrganizer: vi.fn(async () => undefined) }));

import {
  activatePendingContestRules,
  materializeContestRuntime,
  pauseContest,
  prepareContestSubmissionAdmission,
  resumeContest,
  rewindContest,
  startContestEntrant,
} from "./contest-runtime";

class Statement {
  private bindings: SQLInputValue[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]): Statement { this.bindings = values as SQLInputValue[]; return this; }
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

function problem(commit = FIRST_COMMIT): ValidatedCatalogProblem {
  return {
    source: {
      slug: "sum",
      order: 1,
      title: { "zh-TW": "加總", en: "Sum" },
      summary: { "zh-TW": "計算", en: "Compute" },
      practiceEnabled: true,
      practiceBundle: { path: "sum.practice.json", bytes: 10, sha256: "1".repeat(64) },
      contestBundle: { path: "sum.contest.json", bytes: 10, sha256: CONTEXT_DIGEST },
      judgePackage: { path: "sum.wasmojjudge", bytes: 10, sha256: JUDGE_DIGEST },
    },
    allowedProfilesJson: JSON.stringify({ c: { target: "wasip1", optimization: "release" }, commit }),
  };
}

function globalContest(input: {
  readonly startsAt?: string;
  readonly durationSeconds?: number;
  readonly releaseAfterSeconds?: number;
  readonly attemptLimit?: number;
  readonly checkpointMinimumSolved?: number;
} = {}): RepositoryContest {
  const durationSeconds = input.durationSeconds ?? 300;
  const startsAt = input.startsAt ?? "2026-08-26T00:10:00Z";
  const registrationClosesAt = new Date(Date.parse(startsAt) + durationSeconds * 1_000).toISOString();
  return {
    slug: "runtime",
    status: "published",
    title: "Runtime",
    description: "",
    accessMode: "public",
    rules: {
      clock: {
        kind: "global",
        registrationOpensAt: "2026-08-25T00:00:00Z",
        registrationClosesAt,
        startsAt,
        durationSeconds,
      },
      officialTrack: { kind: "code", aiAssist: "allowed" },
      evidenceAt: "input-admitted",
      problems: [{
        slug: "sum",
        batch: 1,
        releaseAfterSeconds: input.releaseAfterSeconds ?? 0,
        submissionClosesAfterSeconds: durationSeconds,
        points: 100,
        attemptLimit: input.attemptLimit ?? 8,
      }],
      scoring: { kind: "score", tieBreaks: ["final-best-achieved-at"] },
      checkpoints: input.checkpointMinimumSolved === undefined ? [] : [{
        id: "gate",
        atSeconds: 100,
        scope: { kind: "all-released" },
        threshold: { minimumSolved: input.checkpointMinimumSolved, minimumScore: null },
        ranking: null,
        settlement: "provisional",
      }],
      leaderboard: { kind: "live" },
    },
  };
}

function individualContest(): RepositoryContest {
  return {
    slug: "runtime",
    status: "published",
    title: "Runtime",
    description: "",
    accessMode: "public",
    rules: {
      clock: {
        kind: "individual",
        enrollmentOpensAt: "2026-08-26T00:00:00Z",
        enrollmentClosesAt: "2026-08-27T00:00:00Z",
        durationSeconds: 120,
      },
      officialTrack: { kind: "code", aiAssist: "disabled" },
      evidenceAt: "judge-terminal",
      problems: [{
        slug: "sum", batch: 1, releaseAfterSeconds: 0,
        submissionClosesAfterSeconds: 120, points: 100, attemptLimit: 8,
      }],
      scoring: { kind: "score", tieBreaks: ["final-best-achieved-at"] },
      checkpoints: [],
      leaderboard: { kind: "live" },
    },
  };
}

function promptContest(): RepositoryContest {
  return {
    slug: "runtime",
    status: "published",
    title: "Runtime",
    description: "",
    accessMode: "public",
    rules: {
      clock: {
        kind: "global",
        registrationOpensAt: "2026-08-25T00:00:00Z",
        registrationClosesAt: "2026-08-26T00:10:00Z",
        startsAt: "2026-08-26T00:00:00Z",
        durationSeconds: 600,
      },
      officialTrack: {
        kind: "prompt-program",
        compiler: { configId: "fake-v1", configDigest: COMPILER_DIGEST },
        limits: {
          promptBytes: 16_384,
          inputTokens: 4_096,
          outputTokens: 8_192,
          generatedSourceBytes: 1_048_576,
          timeoutSeconds: 120,
        },
        attemptPolicy: {
          consumeOn: "model-response-received",
          terminalInfrastructureFailure: "release-reservation",
        },
        disclosure: "private",
      },
      evidenceAt: "input-admitted",
      problems: [{
        slug: "sum", batch: 1, releaseAfterSeconds: 0,
        submissionClosesAfterSeconds: 600, points: 100, attemptLimit: 3,
        output: { language: "c", target: "wasip1", optimization: "release", entry: "main.c" },
      }],
      scoring: { kind: "score", tieBreaks: ["final-best-achieved-at"] },
      checkpoints: [],
      leaderboard: { kind: "live" },
    },
  };
}

function seedAuthority(database: DatabaseSync): void {
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
    VALUES (42, 1, 'wasm-oj', 'runtime', 1, 'authorized', ?)`).run(CREATED_AT);
  database.prepare(`INSERT INTO catalogs
    (id, organizer_user_id, github_repository_id, active_commit_sha, created_at, updated_at)
    VALUES (?, ?, 42, NULL, ?, ?)`).run(CATALOG_ID, ORGANIZER_ID, CREATED_AT, CREATED_AT);
}

function insertSyncJob(database: DatabaseSync, id: string, commit: string): void {
  database.prepare(`INSERT INTO catalog_sync_jobs
    (id, catalog_id, requested_ref, commit_sha, state, requested_by,
     idempotency_key, request_digest, created_at, updated_at, started_at)
    VALUES (?, ?, 'main', ?, 'running', ?, ?, ?, ?, ?, ?)`).run(
    id,
    CATALOG_ID,
    commit,
    ORGANIZER_ID,
    id,
    createHash("sha256").update(id).digest("hex"),
    CREATED_AT,
    CREATED_AT,
    CREATED_AT,
  );
}

async function fixture(contest: RepositoryContest): Promise<Fixture> {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  seedAuthority(database);
  insertSyncJob(database, FIRST_JOB_ID, FIRST_COMMIT);
  const env = { DB: new SqliteD1(database) as unknown as D1Database } as WasmOjWorkerEnv;
  const context: CatalogSyncContext = {
    jobId: FIRST_JOB_ID,
    catalogId: CATALOG_ID,
    githubRepositoryId: 42,
    commitSha: FIRST_COMMIT,
    requestedBy: ORGANIZER_ID,
    state: "running",
  };
  await persistCatalogSync(env, context, [problem()], [contest]);
  const contestId = database.prepare("SELECT id FROM contest_series WHERE slug='runtime'").get()!.id as string;
  const problemId = database.prepare("SELECT id FROM problem_series WHERE slug='sum'").get()!.id as string;
  return { database, env, contestId, problemId };
}

function addUserAndEntrant(
  value: Fixture,
  input: {
    readonly state: "joined" | "active" | "eliminated" | "completed";
    readonly userId?: string;
    readonly entrantId?: string;
    readonly generation?: number;
    readonly startedAt?: string | null;
    readonly individualAnchor?: number;
    readonly individualWallAnchorAt?: string | null;
  },
): string {
  const userId = input.userId ?? ENTRANT_USER_ID;
  const entrantId = input.entrantId ?? ENTRANT_ID;
  const generation = input.generation ?? 1;
  value.database.prepare("INSERT OR IGNORE INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'active')")
    .run(userId, CREATED_AT, CREATED_AT);
  const startedAt = input.startedAt === undefined
    ? input.state === "joined" ? null : CREATED_AT
    : input.startedAt;
  value.database.prepare(`INSERT INTO contest_entrants
    (id, contest_id, kind, subject_key, account_user_id, owner_user_id,
     joined_at, started_at, start_timeline_generation, individual_wall_anchor_at,
     individual_logical_anchor_seconds, state, state_timeline_generation,
     eliminated_at, eliminated_logical_seconds, eliminated_checkpoint_id,
     elimination_reason, created_at, updated_at)
    VALUES (?, ?, 'account', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`)
    .run(
      entrantId, value.contestId, userId, userId, userId, CREATED_AT,
      startedAt, startedAt ? 1 : null, input.individualWallAnchorAt ?? null,
      input.individualAnchor ?? 0, input.state, generation, CREATED_AT, CREATED_AT,
    );
  return entrantId;
}

function setRuntime(
  value: Fixture,
  state: "scheduled" | "running" | "paused",
  input: { readonly logical?: number; readonly generation?: number; readonly wall?: string } = {},
): void {
  const logical = input.logical ?? 0;
  const generation = input.generation ?? 1;
  if (state === "scheduled") {
    value.database.prepare(`UPDATE contest_runtimes SET state='scheduled', wall_anchor_at=NULL,
      logical_anchor_seconds=?, pause_reason=NULL, paused_at=NULL, paused_from_state=NULL,
      ended_at=NULL, timeline_generation=?, updated_at=? WHERE contest_id=?`)
      .run(logical, generation, CREATED_AT, value.contestId);
  } else if (state === "running") {
    value.database.prepare(`UPDATE contest_runtimes SET state='running', wall_anchor_at=?,
      logical_anchor_seconds=?, pause_reason=NULL, paused_at=NULL, paused_from_state=NULL,
      first_started_at=COALESCE(first_started_at, ?), ended_at=NULL,
      timeline_generation=?, updated_at=? WHERE contest_id=?`)
      .run(input.wall ?? CREATED_AT, logical, input.wall ?? CREATED_AT, generation, CREATED_AT, value.contestId);
  } else {
    value.database.prepare(`UPDATE contest_runtimes SET state='paused', wall_anchor_at=NULL,
      logical_anchor_seconds=?, pause_reason='test-pause', paused_at=?, paused_from_state='running',
      first_started_at=COALESCE(first_started_at, ?), ended_at=NULL,
      timeline_generation=?, updated_at=? WHERE contest_id=?`)
      .run(logical, CREATED_AT, CREATED_AT, generation, CREATED_AT, value.contestId);
  }
}

function operationRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://wasm-oj.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function addSubmissionRecord(
  value: Fixture,
  input: {
    readonly id: string;
    readonly entrantId: string;
    readonly userId: string;
    readonly generation: number;
    readonly admitted: number;
    readonly evidence: number | null;
  },
): void {
  const sourceId = input.id.replace(/^./, "f");
  const digest = createHash("sha256").update(input.id).digest("hex");
  value.database.prepare(`INSERT INTO submission_sources
    (id, owner_user_id, admission_erasure_epoch, content_sha256, bytes, state, created_at)
    VALUES (?, ?, 0, ?, 1, 'reserved', ?)`).run(sourceId, input.userId, digest, CREATED_AT);
  value.database.prepare("UPDATE submission_sources SET state='ready', ready_at=? WHERE id=?")
    .run(CREATED_AT, sourceId);
  value.database.prepare(`INSERT INTO submissions
    (id, origin_submission_id, origin_submitted_at, user_id, problem_id,
     catalog_commit, judge_digest, contest_id, source_id, language, target,
     optimization, entry_path, state, verdict, visibility, score,
     fully_passed_cases, deterministic_cost, peak_memory_bytes,
     policy_summary_json, effective_attempt, admitted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'c', 'wasip1', 'release', 'main.c',
      'completed', 'wrong-answer', 'private', 0, 0, 100, 1024, '{}', 1, ?, ?, ?, ?)`)
    .run(
      input.id, input.id, CREATED_AT, input.userId, value.problemId,
      FIRST_COMMIT, JUDGE_DIGEST, value.contestId, sourceId,
      CREATED_AT, CREATED_AT, CREATED_AT, CREATED_AT,
    );
  value.database.prepare(`INSERT INTO contest_submission_records
    (submission_id, contest_id, entrant_id, timeline_generation, rules_epoch,
     content_epoch, judge_epoch, admitted_logical_seconds, evidence_at,
     evidence_logical_seconds, eligibility, created_at)
    VALUES (?, ?, ?, ?, 1, 1, 1, ?, 'input-admitted', ?, 'eligible', ?)`)
    .run(
      input.id, value.contestId, input.entrantId, input.generation,
      input.admitted, input.evidence, CREATED_AT,
    );
}

function addPromptAttempt(
  value: Fixture,
  input: {
    readonly id: string;
    readonly generation: number;
    readonly admitted: number;
    readonly evidence: number | null;
    readonly slot: number;
  },
): void {
  const prompt = `attempt ${input.id}`;
  value.database.prepare(`INSERT INTO prompt_attempts
    (id, contest_id, entrant_id, problem_id, timeline_generation, rules_epoch,
     problem_epoch, content_epoch, judge_epoch, compiler_config_id, compiler_config_sha256,
     public_context_sha256, prompt_text, prompt_bytes, prompt_sha256,
     output_language, output_target, output_optimization, output_entry_path,
     state, admitted_logical_seconds, evidence_logical_seconds, failure_code,
     eligibility, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 1, 1, 1, 'fake-v1', ?, ?, ?, ?, ?,
      'c', 'wasip1', 'release', 'main.c', 'failed', ?, ?, 'malformed-output',
      'eligible', ?, ?)`)
    .run(
      input.id, value.contestId, ENTRANT_ID, value.problemId, input.generation,
      COMPILER_DIGEST, CONTEXT_DIGEST, prompt, Buffer.byteLength(prompt),
      createHash("sha256").update(prompt).digest("hex"), input.admitted,
      input.evidence, CREATED_AT, CREATED_AT,
    );
  value.database.prepare(`INSERT INTO prompt_attempt_quota
    (prompt_attempt_id, contest_id, entrant_id, problem_id, timeline_generation,
     quota_slot, configured_limit, state, reserved_at, settled_at, settlement_reason)
    VALUES (?, ?, ?, ?, ?, ?, 3, 'consumed', ?, ?, 'model-response-received')`)
    .run(
      input.id, value.contestId, ENTRANT_ID, value.problemId,
      input.generation, input.slot, CREATED_AT, CREATED_AT,
    );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Contest v2 runtime operations", () => {
  it("materializes global start and end on exact boundaries", async () => {
    const value = await fixture(globalContest());
    addUserAndEntrant(value, { state: "joined" });

    await materializeContestRuntime(value.env, value.contestId, new Date("2026-08-26T00:09:59.999Z"));
    expect(value.database.prepare("SELECT state FROM contest_runtimes WHERE contest_id=?").get(value.contestId)).toEqual({ state: "scheduled" });

    await materializeContestRuntime(value.env, value.contestId, new Date("2026-08-26T00:10:00.000Z"));
    expect(value.database.prepare("SELECT state, wall_anchor_at FROM contest_runtimes WHERE contest_id=?").get(value.contestId)).toEqual({
      state: "running",
      wall_anchor_at: "2026-08-26T00:10:00.000Z",
    });
    expect(value.database.prepare("SELECT state FROM contest_entrants WHERE id=?").get(ENTRANT_ID)).toEqual({ state: "active" });

    await materializeContestRuntime(value.env, value.contestId, new Date("2026-08-26T00:14:59.999Z"));
    expect(value.database.prepare("SELECT state FROM contest_runtimes WHERE contest_id=?").get(value.contestId)).toEqual({ state: "running" });
    await materializeContestRuntime(value.env, value.contestId, new Date("2026-08-26T00:15:00.000Z"));
    expect(value.database.prepare("SELECT state, logical_anchor_seconds FROM contest_runtimes WHERE contest_id=?").get(value.contestId)).toEqual({
      state: "ended",
      logical_anchor_seconds: 300,
    });
    expect(value.database.prepare("SELECT state FROM contest_entrants WHERE id=?").get(ENTRANT_ID)).toEqual({ state: "completed" });
  });

  it("shifts a scheduled global start by the full pause interval", async () => {
    const value = await fixture(globalContest());
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:05:00.000Z"));
    await pauseContest(operationRequest(`/api/organizer/contests/${value.contestId}/pause`, { reason: "maintenance" }), value.env, value.contestId);
    vi.setSystemTime(new Date("2026-08-26T00:07:30.000Z"));
    await resumeContest(operationRequest(`/api/organizer/contests/${value.contestId}/resume`, {}), value.env, value.contestId);

    expect(value.database.prepare(`SELECT state, schedule_shift_seconds
      FROM contest_runtimes WHERE contest_id=?`).get(value.contestId)).toEqual({
      state: "scheduled",
      schedule_shift_seconds: 150,
    });
    await materializeContestRuntime(value.env, value.contestId, new Date("2026-08-26T00:12:29.999Z"));
    expect(value.database.prepare("SELECT state FROM contest_runtimes WHERE contest_id=?").get(value.contestId)).toEqual({ state: "scheduled" });
    await materializeContestRuntime(value.env, value.contestId, new Date("2026-08-26T00:12:30.000Z"));
    expect(value.database.prepare("SELECT state FROM contest_runtimes WHERE contest_id=?").get(value.contestId)).toEqual({ state: "running" });
  });

  it("starts and freezes an individual entrant independently", async () => {
    const value = await fixture(individualContest());
    addUserAndEntrant(value, { state: "joined", userId: ORGANIZER_ID });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:01:00.000Z"));
    const started = await startContestEntrant(operationRequest(`/api/contests/${value.contestId}/start`, {}), value.env, value.contestId);
    expect(started.status).toBe(201);

    vi.setSystemTime(new Date("2026-08-26T00:01:05.000Z"));
    await pauseContest(operationRequest(`/api/organizer/contests/${value.contestId}/pause`, { reason: "judge outage" }), value.env, value.contestId);
    expect(value.database.prepare(`SELECT individual_logical_anchor_seconds, individual_wall_anchor_at
      FROM contest_entrants WHERE id=?`).get(ENTRANT_ID)).toEqual({
      individual_logical_anchor_seconds: 5,
      individual_wall_anchor_at: null,
    });

    vi.setSystemTime(new Date("2026-08-26T00:01:25.000Z"));
    await resumeContest(operationRequest(`/api/organizer/contests/${value.contestId}/resume`, {}), value.env, value.contestId);
    expect(value.database.prepare(`SELECT state, schedule_shift_seconds
      FROM contest_runtimes WHERE contest_id=?`).get(value.contestId)).toEqual({
      state: "running",
      schedule_shift_seconds: 20,
    });
    await materializeContestRuntime(value.env, value.contestId, new Date("2026-08-26T00:03:20.000Z"));
    expect(value.database.prepare("SELECT state FROM contest_entrants WHERE id=?").get(ENTRANT_ID)).toEqual({ state: "completed" });
  });

  it("recomputes exact release and close boundaries inside the admission INSERT", async () => {
    const value = await fixture(globalContest({
      startsAt: "2026-08-26T00:00:00Z",
      durationSeconds: 300,
      releaseAfterSeconds: 100,
    }));
    addUserAndEntrant(value, { state: "active" });
    setRuntime(value, "running", { wall: CREATED_AT });
    const epoch = value.database.prepare(`SELECT problem_epoch, content_commit
      FROM contest_problem_epochs WHERE contest_id=? AND problem_id=? AND state='effective'`)
      .get(value.contestId, value.problemId) as { problem_epoch: number; content_commit: string };
    const lockedId = "30000000-0000-4000-8000-000000000001";
    const releaseId = "30000000-0000-4000-8000-000000000002";
    const beforeId = "30000000-0000-4000-8000-000000000004";
    const closeId = "30000000-0000-4000-8000-000000000005";
    addSubmissionRecord(value, {
      id: lockedId, entrantId: ENTRANT_ID, userId: ENTRANT_USER_ID,
      generation: 1, admitted: 1, evidence: 1,
    });
    value.database.prepare("DELETE FROM contest_submission_records WHERE submission_id=?").run(lockedId);
    addSubmissionRecord(value, {
      id: releaseId, entrantId: ENTRANT_ID, userId: ENTRANT_USER_ID,
      generation: 1, admitted: 1, evidence: 1,
    });
    value.database.prepare("DELETE FROM contest_submission_records WHERE submission_id=?").run(releaseId);
    addSubmissionRecord(value, {
      id: beforeId, entrantId: ENTRANT_ID, userId: ENTRANT_USER_ID,
      generation: 1, admitted: 1, evidence: 1,
    });
    value.database.prepare("DELETE FROM contest_submission_records WHERE submission_id=?").run(beforeId);
    addSubmissionRecord(value, {
      id: closeId, entrantId: ENTRANT_ID, userId: ENTRANT_USER_ID,
      generation: 1, admitted: 1, evidence: 1,
    });
    value.database.prepare("DELETE FROM contest_submission_records WHERE submission_id=?").run(closeId);
    const fence = {
      contestId: value.contestId,
      entrantId: ENTRANT_ID,
      problemId: value.problemId,
      timelineGeneration: 1,
      ruleEpoch: 1,
      problemEpoch: epoch.problem_epoch,
      contentCommit: epoch.content_commit,
      logicalSeconds: 0,
    };

    const locked = await prepareContestSubmissionAdmission(
      value.env,
      fence,
      lockedId,
      "2026-08-26T00:01:39.999Z",
    ).run();
    expect(locked.meta.changes).toBe(0);
    const released = await prepareContestSubmissionAdmission(
      value.env,
      fence,
      releaseId,
      "2026-08-26T00:01:40.000Z",
    ).run();
    expect(released.meta.changes).toBe(1);
    expect(value.database.prepare(`SELECT admitted_logical_seconds FROM contest_submission_records
      WHERE submission_id=?`).get(releaseId)).toEqual({ admitted_logical_seconds: 100 });

    const admitted = await prepareContestSubmissionAdmission(
      value.env,
      fence,
      beforeId,
      "2026-08-26T00:04:59.999Z",
    ).run();
    expect(admitted.meta.changes).toBe(1);
    expect(value.database.prepare(`SELECT admitted_logical_seconds FROM contest_submission_records
      WHERE submission_id=?`).get(beforeId)).toEqual({ admitted_logical_seconds: 299 });

    const closed = await prepareContestSubmissionAdmission(
      value.env,
      fence,
      closeId,
      "2026-08-26T00:05:00.000Z",
    ).run();
    expect(closed.meta.changes).toBe(0);
    expect((await prepareContestSubmissionAdmission(
      value.env,
      { ...fence, problemId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
      closeId,
      "2026-08-26T00:04:00.000Z",
    ).run()).meta.changes).toBe(0);
  });

  it("recalculates a due checkpoint in a new rule epoch without reviving prior eliminations", async () => {
    const value = await fixture(globalContest({ startsAt: "2026-08-26T00:00:00Z", checkpointMinimumSolved: 0 }));
    addUserAndEntrant(value, { state: "active" });
    const priorEliminatedUser = "10000000-0000-4000-8000-000000000031";
    const priorEliminatedEntrant = "20000000-0000-4000-8000-000000000031";
    addUserAndEntrant(value, {
      state: "active",
      userId: priorEliminatedUser,
      entrantId: priorEliminatedEntrant,
    });
    value.database.prepare(`UPDATE contest_entrants
      SET state='eliminated', eliminated_at=?, eliminated_logical_seconds=50,
          eliminated_checkpoint_id='old-gate', elimination_reason='checkpoint:old-gate'
      WHERE id=?`).run(CREATED_AT, priorEliminatedEntrant);
    setRuntime(value, "paused", { logical: 200 });
    const oldRunId = "40000000-0000-4000-8000-000000000001";
    value.database.prepare(`INSERT INTO contest_checkpoint_runs
      (id, contest_id, checkpoint_id, timeline_generation, rules_epoch,
       logical_seconds, settlement, state, population, pending_work, created_at, finalized_at)
      VALUES (?, ?, 'gate', 1, 1, 100, 'provisional', 'final', 1, 0, ?, ?)`)
      .run(oldRunId, value.contestId, CREATED_AT, CREATED_AT);
    value.database.prepare(`INSERT INTO contest_checkpoint_decisions
      (checkpoint_run_id, entrant_id, decision, provisional, competitive_key_json, decided_at)
      VALUES (?, ?, 'advanced', 0, '{}', ?)`)
      .run(oldRunId, ENTRANT_ID, CREATED_AT);
    const downstreamId = "30000000-0000-4000-8000-000000000003";
    addSubmissionRecord(value, {
      id: downstreamId, entrantId: ENTRANT_ID, userId: ENTRANT_USER_ID,
      generation: 1, admitted: 150, evidence: 150,
    });

    insertSyncJob(value.database, SECOND_JOB_ID, SECOND_COMMIT);
    await persistCatalogSync(value.env, {
      jobId: SECOND_JOB_ID,
      catalogId: CATALOG_ID,
      githubRepositoryId: 42,
      commitSha: SECOND_COMMIT,
      requestedBy: ORGANIZER_ID,
      state: "running",
    }, [problem(SECOND_COMMIT)], [globalContest({
      startsAt: "2026-08-26T00:00:00Z",
      checkpointMinimumSolved: 1,
    })]);
    const response = await activatePendingContestRules(operationRequest(
      `/api/organizer/contests/${value.contestId}/rules/apply`,
      { mode: "monotonic-recalculate", reason: "raise checkpoint threshold" },
    ), value.env, value.contestId);
    expect(response.status).toBe(200);

    expect(value.database.prepare(`SELECT rules_epoch, timeline_generation
      FROM contest_runtimes WHERE contest_id=?`).get(value.contestId)).toEqual({
      rules_epoch: 2,
      timeline_generation: 1,
    });
    expect(value.database.prepare(`SELECT rules_epoch, state FROM contest_checkpoint_runs
      WHERE contest_id=? ORDER BY rules_epoch`).all(value.contestId)).toEqual([
      { rules_epoch: 1, state: "final" },
      { rules_epoch: 2, state: "final" },
    ]);
    expect(value.database.prepare("SELECT state, eliminated_logical_seconds FROM contest_entrants WHERE id=?")
      .get(ENTRANT_ID)).toEqual({ state: "eliminated", eliminated_logical_seconds: 100 });
    expect(value.database.prepare("SELECT state, eliminated_logical_seconds, elimination_reason FROM contest_entrants WHERE id=?")
      .get(priorEliminatedEntrant)).toEqual({
      state: "eliminated",
      eliminated_logical_seconds: 50,
      elimination_reason: "checkpoint:old-gate",
    });
    expect(value.database.prepare("SELECT eligibility, invalidation_reason FROM contest_submission_records WHERE submission_id=?")
      .get(downstreamId)).toEqual({ eligibility: "invalid", invalidation_reason: "checkpoint:gate" });
  });

  it("carries target-before evidence and invalidates every older lineage on repeated rewind", async () => {
    const value = await fixture(promptContest());
    addUserAndEntrant(value, { state: "active" });
    setRuntime(value, "paused", { logical: 300 });
    const keptSubmission = "30000000-0000-4000-8000-000000000011";
    const cutSubmission = "30000000-0000-4000-8000-000000000012";
    addSubmissionRecord(value, {
      id: keptSubmission, entrantId: ENTRANT_ID, userId: ENTRANT_USER_ID,
      generation: 1, admitted: 50, evidence: 50,
    });
    addSubmissionRecord(value, {
      id: cutSubmission, entrantId: ENTRANT_ID, userId: ENTRANT_USER_ID,
      generation: 1, admitted: 250, evidence: 250,
    });
    const keptAttempt = "50000000-0000-4000-8000-000000000011";
    const cutAttempt = "50000000-0000-4000-8000-000000000012";
    addPromptAttempt(value, { id: keptAttempt, generation: 1, admitted: 50, evidence: 50, slot: 1 });
    addPromptAttempt(value, { id: cutAttempt, generation: 1, admitted: 250, evidence: 250, slot: 2 });

    await rewindContest(operationRequest(`/api/organizer/contests/${value.contestId}/rewind`, {
      reason: "first rewind",
      targetLogicalSeconds: 200,
    }), value.env, value.contestId);
    expect(value.database.prepare(`SELECT eligibility FROM prompt_attempts WHERE id=?`).get(keptAttempt)).toEqual({ eligibility: "eligible" });
    expect(value.database.prepare(`SELECT eligibility FROM prompt_attempts WHERE id=?`).get(cutAttempt)).toEqual({ eligibility: "invalid" });
    expect(value.database.prepare(`SELECT state FROM prompt_attempt_quota WHERE prompt_attempt_id=?`).get(keptAttempt)).toEqual({ state: "consumed" });
    expect(value.database.prepare(`SELECT state FROM prompt_attempt_quota WHERE prompt_attempt_id=?`).get(cutAttempt)).toEqual({ state: "invalid" });

    const middleSubmission = "30000000-0000-4000-8000-000000000013";
    addSubmissionRecord(value, {
      id: middleSubmission, entrantId: ENTRANT_ID, userId: ENTRANT_USER_ID,
      generation: 2, admitted: 150, evidence: 150,
    });
    const middleAttempt = "50000000-0000-4000-8000-000000000013";
    addPromptAttempt(value, { id: middleAttempt, generation: 2, admitted: 150, evidence: 150, slot: 1 });
    value.database.prepare("UPDATE contest_runtimes SET logical_anchor_seconds=200 WHERE contest_id=?")
      .run(value.contestId);
    await rewindContest(operationRequest(`/api/organizer/contests/${value.contestId}/rewind`, {
      reason: "second rewind",
      targetLogicalSeconds: 100,
    }), value.env, value.contestId);

    expect(value.database.prepare(`SELECT id, eligibility FROM prompt_attempts ORDER BY id`).all()).toEqual([
      { id: keptAttempt, eligibility: "eligible" },
      { id: cutAttempt, eligibility: "invalid" },
      { id: middleAttempt, eligibility: "invalid" },
    ]);
    expect(value.database.prepare(`SELECT submission_id, eligibility FROM contest_submission_records
      ORDER BY submission_id`).all()).toEqual([
      { submission_id: keptSubmission, eligibility: "eligible" },
      { submission_id: cutSubmission, eligibility: "invalid" },
      { submission_id: middleSubmission, eligibility: "invalid" },
    ]);
    expect(value.database.prepare(`SELECT prompt_attempt_id, state FROM prompt_attempt_quota
      ORDER BY prompt_attempt_id`).all()).toEqual([
      { prompt_attempt_id: keptAttempt, state: "consumed" },
      { prompt_attempt_id: cutAttempt, state: "invalid" },
      { prompt_attempt_id: middleAttempt, state: "invalid" },
    ]);
    expect(value.database.prepare("SELECT timeline_generation FROM contest_runtimes WHERE contest_id=?")
      .get(value.contestId)).toEqual({ timeline_generation: 3 });
  });

  it("rewinds every started individual entrant to min(current, target) and leaves unstarted entrants unstarted", async () => {
    const value = await fixture(individualContest());
    const fastUser = "10000000-0000-4000-8000-000000000021";
    const slowUser = "10000000-0000-4000-8000-000000000022";
    const waitingUser = "10000000-0000-4000-8000-000000000023";
    const fastEntrant = "20000000-0000-4000-8000-000000000021";
    const slowEntrant = "20000000-0000-4000-8000-000000000022";
    const waitingEntrant = "20000000-0000-4000-8000-000000000023";
    addUserAndEntrant(value, {
      state: "active", userId: fastUser, entrantId: fastEntrant,
      individualAnchor: 100,
    });
    addUserAndEntrant(value, {
      state: "active", userId: slowUser, entrantId: slowEntrant,
      individualAnchor: 40,
    });
    addUserAndEntrant(value, {
      state: "joined", userId: waitingUser, entrantId: waitingEntrant,
      startedAt: null,
    });
    setRuntime(value, "paused", { logical: 0 });
    const fastKept = "30000000-0000-4000-8000-000000000021";
    const fastCut = "30000000-0000-4000-8000-000000000022";
    const slowKept = "30000000-0000-4000-8000-000000000023";
    const slowCut = "30000000-0000-4000-8000-000000000024";
    addSubmissionRecord(value, {
      id: fastKept, entrantId: fastEntrant, userId: fastUser,
      generation: 1, admitted: 50, evidence: 50,
    });
    addSubmissionRecord(value, {
      id: fastCut, entrantId: fastEntrant, userId: fastUser,
      generation: 1, admitted: 70, evidence: 70,
    });
    addSubmissionRecord(value, {
      id: slowKept, entrantId: slowEntrant, userId: slowUser,
      generation: 1, admitted: 30, evidence: 30,
    });
    addSubmissionRecord(value, {
      id: slowCut, entrantId: slowEntrant, userId: slowUser,
      generation: 1, admitted: 41, evidence: 41,
    });

    await rewindContest(operationRequest(`/api/organizer/contests/${value.contestId}/rewind`, {
      reason: "individual cohort rewind",
      targetLogicalSeconds: 60,
    }), value.env, value.contestId);

    expect(value.database.prepare(`SELECT id, state, started_at, individual_logical_anchor_seconds,
      state_timeline_generation FROM contest_entrants ORDER BY id`).all()).toEqual([
      {
        id: fastEntrant, state: "active", started_at: CREATED_AT,
        individual_logical_anchor_seconds: 60, state_timeline_generation: 2,
      },
      {
        id: slowEntrant, state: "active", started_at: CREATED_AT,
        individual_logical_anchor_seconds: 40, state_timeline_generation: 2,
      },
      {
        id: waitingEntrant, state: "joined", started_at: null,
        individual_logical_anchor_seconds: 0, state_timeline_generation: 2,
      },
    ]);
    expect(value.database.prepare(`SELECT submission_id, eligibility FROM contest_submission_records
      ORDER BY submission_id`).all()).toEqual([
      { submission_id: fastKept, eligibility: "eligible" },
      { submission_id: fastCut, eligibility: "invalid" },
      { submission_id: slowKept, eligibility: "eligible" },
      { submission_id: slowCut, eligibility: "invalid" },
    ]);
  });
});
