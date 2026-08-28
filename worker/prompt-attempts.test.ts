import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryContest } from "../src/online-judge/repository-contract";
import {
  PromptCompilerAdapterError,
  PromptCompilerRegistry,
  type PromptCompilerAdapter,
} from "../src/online-judge/prompt-compiler";
import { persistCatalogSync, type CatalogSyncContext, type ValidatedCatalogProblem } from "./catalog-persistence";
import { sha256Hex } from "./crypto";
import { ApiError } from "./http";
import {
  PromptAttemptService,
  reconcilePromptAttemptProduct,
  reconcileReadyPromptAttemptProducts,
  type PromptAttemptHost,
  type PromptGeneratedSubmissionRequest,
} from "./prompt-attempts";
import { promptContestGallery } from "./prompt-gallery";
import {
  admitPromptGeneratedSubmission,
  encodeOfficialSourceDocument,
  reconcileAdmittingSubmission,
  submissionSourceKey,
} from "./submissions";

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
  private batchTail: Promise<void> = Promise.resolve();
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string): Statement { return new Statement(this.database, sql); }
  async batch(statements: readonly Statement[]): Promise<D1Result[]> {
    let release!: () => void;
    const previous = this.batchTail;
    this.batchTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      release();
    }
  }
}

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const CATALOG_ID = "22222222-2222-4222-8222-222222222222";
const SYNC_JOB_ID = "33333333-3333-4333-8333-333333333333";
const ENTRANT_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_IDS = [
  "50000000-0000-4000-8000-000000000001",
  "50000000-0000-4000-8000-000000000002",
  "50000000-0000-4000-8000-000000000003",
  "50000000-0000-4000-8000-000000000004",
] as const;
const SOURCE_IDS = [
  "60000000-0000-4000-8000-000000000001",
  "60000000-0000-4000-8000-000000000002",
  "60000000-0000-4000-8000-000000000003",
] as const;
const SUBMISSION_IDS = [
  "70000000-0000-4000-8000-000000000001",
  "70000000-0000-4000-8000-000000000002",
  "70000000-0000-4000-8000-000000000003",
] as const;
const COMMIT = "a".repeat(40);
const COMPILER_DIGEST = "4".repeat(64);
const JUDGE_DIGEST = "3".repeat(64);
const CONTEXT_CONTENT = "# Sum\nRead two integers and print their sum.\n";
const CONTEXT_SHA256 = createHash("sha256").update(CONTEXT_CONTENT).digest("hex");
const START = "2026-08-26T00:00:00.000Z";
const NOW = new Date("2026-08-26T00:00:30.000Z");

function applyCoreMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations/core");
  for (const filename of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function seedCatalogAuthority(database: DatabaseSync): void {
  database.prepare("INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'active')")
    .run(OWNER_ID, START, START);
  database.prepare(`INSERT INTO github_installations
    (installation_id, account_github_id, account_login, installed_by_user_id,
     status, permissions_json, repository_selection, created_at, updated_at)
    VALUES (1, 42, 'wasm-oj', ?, 'active', '{}', 'all', ?, ?)`)
    .run(OWNER_ID, START, START);
  database.prepare(`INSERT INTO github_repositories
    (github_repository_id, installation_id, owner_login, name, is_private,
     authorization_status, updated_at)
    VALUES (42, 1, 'wasm-oj', 'prompt-fixtures', 1, 'authorized', ?)`)
    .run(START);
  database.prepare(`INSERT INTO catalogs
    (id, organizer_user_id, github_repository_id, active_commit_sha, created_at, updated_at)
    VALUES (?, ?, 42, NULL, ?, ?)`)
    .run(CATALOG_ID, OWNER_ID, START, START);
  database.prepare(`INSERT INTO catalog_sync_jobs
    (id, catalog_id, requested_ref, commit_sha, state, requested_by,
     idempotency_key, request_digest, error_code, summary_json,
     created_at, updated_at, started_at, finished_at)
    VALUES (?, ?, 'main', ?, 'running', ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`)
    .run(
      SYNC_JOB_ID,
      CATALOG_ID,
      COMMIT,
      OWNER_ID,
      SYNC_JOB_ID,
      createHash("sha256").update(SYNC_JOB_ID).digest("hex"),
      START,
      START,
      START,
    );
}

function problem(): ValidatedCatalogProblem {
  return {
    source: {
      slug: "sum",
      order: 1,
      title: { "zh-TW": "加總", en: "Sum" },
      summary: { "zh-TW": "計算", en: "Compute" },
      practiceEnabled: true,
      practiceBundle: { path: "collection/sum.practice.json", bytes: 10, sha256: "1".repeat(64) },
      contestBundle: {
        path: "collection/sum.contest.json",
        bytes: new TextEncoder().encode(CONTEXT_CONTENT).byteLength,
        sha256: CONTEXT_SHA256,
      },
      judgePackage: { path: "collection/sum.wasmojjudge", bytes: 20, sha256: JUDGE_DIGEST },
    },
    allowedProfilesJson: JSON.stringify({ c: { target: "wasip1", optimization: "release" } }),
  };
}

const promptContest = {
  slug: "prompt-sprint",
  status: "published",
  title: "Prompt Sprint",
  description: "",
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
      disclosure: "best-after-end",
    },
    evidenceAt: "generated-source-ready",
    problems: [{
      slug: "sum",
      batch: 1,
      releaseAfterSeconds: 0,
      submissionClosesAfterSeconds: 900,
      points: 100,
      attemptLimit: 2,
      output: { language: "c", target: "wasip1", optimization: "release", entry: "main.c" },
    }],
    scoring: { kind: "score", tieBreaks: ["fully-passed-cases", "final-best-achieved-at"] },
    checkpoints: [],
    leaderboard: { kind: "hidden-until-end" },
  },
} satisfies RepositoryContest;

function syncContext(): CatalogSyncContext {
  return {
    jobId: SYNC_JOB_ID,
    catalogId: CATALOG_ID,
    githubRepositoryId: 42,
    commitSha: COMMIT,
    requestedBy: OWNER_ID,
    state: "running",
  };
}

interface Fixture {
  readonly database: DatabaseSync;
  readonly databaseAdapter: D1Database;
  readonly contestId: string;
  readonly problemId: string;
  readonly contextSha256: string;
}

interface CapturedSource {
  readonly sourceId: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

async function databaseFixture(): Promise<Fixture> {
  const database = new DatabaseSync(":memory:");
  applyCoreMigrations(database);
  seedCatalogAuthority(database);
  const databaseAdapter = new SqliteD1(database) as unknown as D1Database;
  await persistCatalogSync({ DB: databaseAdapter } as never, syncContext(), [problem()], [promptContest]);
  const contestId = database.prepare("SELECT id FROM contest_series WHERE slug='prompt-sprint'").get()!.id as string;
  const problemId = database.prepare("SELECT id FROM problem_series WHERE slug='sum'").get()!.id as string;
  database.prepare(`UPDATE contest_runtimes
    SET state='running', wall_anchor_at=?, logical_anchor_seconds=0,
        first_started_at=?, updated_at=? WHERE contest_id=?`)
    .run(START, START, START, contestId);
  database.prepare(`INSERT INTO contest_entrants
    (id, contest_id, kind, subject_key, account_user_id, owner_user_id,
     joined_at, started_at, start_timeline_generation, individual_wall_anchor_at,
     individual_logical_anchor_seconds, state, state_timeline_generation,
     eliminated_at, eliminated_logical_seconds, eliminated_checkpoint_id,
     elimination_reason, created_at, updated_at)
    VALUES (?, ?, 'account', ?, ?, ?, ?, ?, 1, ?, 0, 'active', 1,
      NULL, NULL, NULL, NULL, ?, ?)`)
    .run(ENTRANT_ID, contestId, OWNER_ID, OWNER_ID, OWNER_ID, START, START, START, START, START);
  database.prepare(`INSERT INTO contest_reveal_grants
    (contest_id, entrant_id, problem_id, timeline_generation, rules_epoch, problem_epoch,
     content_epoch, granted_logical_seconds, granted_at, eligibility,
     invalidated_at, invalidation_reason)
    VALUES (?, ?, ?, 1, 1, 1, 1, 0, ?, 'eligible', NULL, NULL)`)
    .run(contestId, ENTRANT_ID, problemId, START);
  const contextSha256 = CONTEXT_SHA256;
  return { database, databaseAdapter, contestId, problemId, contextSha256 };
}

function registry(compile: PromptCompilerAdapter["compile"]): PromptCompilerRegistry {
  const value = new PromptCompilerRegistry();
  value.register({
    compilerConfigId: "fake-v1",
    compilerConfigDigest: COMPILER_DIGEST,
    adapterId: "fake-adapter",
  }, { id: "fake-adapter", compile });
  return value;
}

function generatedResponse() {
  return { sourceFiles: [{ path: "main.c", encoding: "utf8" as const, content: "int main(void){return 0;}\n" }] };
}

function uuidSequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index++];
    if (!value) throw new Error("UUID fixture exhausted.");
    return value;
  };
}

function normalSubmissionHost(
  fixture: Fixture,
  options: {
    readonly fail?: boolean;
    readonly omitPersistence?: boolean;
    readonly throwAfterPersistence?: boolean;
    readonly leaveSourceReserved?: boolean;
    readonly captureSource?: (sourceId: string, bytes: Uint8Array, sha256: string) => void;
  } = {},
): PromptAttemptHost & { readonly admitGeneratedSource: ReturnType<typeof vi.fn> } {
  let productIndex = 0;
  const admitGeneratedSource = vi.fn(async (request: PromptGeneratedSubmissionRequest) => {
    if (options.fail) throw new Error("host unavailable");
    const sourceId = SOURCE_IDS[productIndex]!;
    const submissionId = SUBMISSION_IDS[productIndex]!;
    productIndex += 1;
    const sourceBytes = await encodeOfficialSourceDocument({
      language: request.generatedSource.output.language,
      target: request.generatedSource.output.target,
      optimization: request.generatedSource.output.optimization,
      entry: request.generatedSource.entry,
      sourceFiles: request.generatedSource.sourceFiles,
    });
    const sourceSha256 = await sha256Hex(sourceBytes);
    options.captureSource?.(sourceId, sourceBytes, sourceSha256);
    if (!options.omitPersistence) {
      const evidence = request.evidenceAt === "input-admitted"
        ? request.admittedLogicalSeconds
        : request.evidenceAt === "generated-source-ready"
          ? request.sourceReadyLogicalSeconds
          : null;
      fixture.database.exec("BEGIN IMMEDIATE");
      try {
        fixture.database.prepare(`INSERT INTO submission_sources
          (id, owner_user_id, admission_erasure_epoch, content_sha256, bytes,
           state, created_at, ready_at, erased_at, erasure_requested_at,
           erasure_attempts, erasure_next_attempt_at, erasure_last_error, source_kind)
          VALUES (?, ?, 0, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, 'prompt-generated')`)
          .run(
            sourceId,
            request.ownerUserId,
            sourceSha256,
            sourceBytes.byteLength,
            options.leaveSourceReserved ? "reserved" : "ready",
            START,
            options.leaveSourceReserved ? null : START,
          );
        fixture.database.prepare(`INSERT INTO submissions
          (id, origin_submission_id, origin_submitted_at, user_id, problem_id,
           catalog_commit, judge_digest, contest_id, source_id, language, target,
           optimization, entry_path, state, verdict, visibility, score,
           fully_passed_cases, deterministic_cost, peak_memory_bytes,
           policy_summary_json, effective_attempt, admitted_at, created_at,
           updated_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL,
            'private', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL)`)
          .run(
            submissionId,
            submissionId,
            START,
            request.ownerUserId,
            request.problemId,
            request.contentCommit,
            request.judgeDigest,
            request.contestId,
            sourceId,
            request.generatedSource.output.language,
            request.generatedSource.output.target,
            request.generatedSource.output.optimization,
            request.generatedSource.entry,
            START,
            START,
            START,
          );
        fixture.database.prepare(`INSERT INTO contest_submission_records
          (submission_id, contest_id, entrant_id, timeline_generation, rules_epoch,
           content_epoch, judge_epoch, admitted_logical_seconds, evidence_at,
           evidence_logical_seconds, eligibility, invalidated_at,
           invalidation_reason, created_at, prompt_attempt_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            submissionId,
            request.contestId,
            request.entrantId,
            request.timelineGeneration,
            request.rulesEpoch,
            request.contentEpoch,
            request.judgeEpoch,
            request.admittedLogicalSeconds,
            request.evidenceAt,
            evidence,
            request.eligibility,
            request.invalidatedAt,
            request.invalidationReason,
            START,
            request.attemptId,
          );
        fixture.database.exec("COMMIT");
      } catch (error) {
        fixture.database.exec("ROLLBACK");
        throw error;
      }
    }
    if (options.throwAfterPersistence) throw new Error("host response lost after durable product");
    return { sourceId, sourceSha256, submissionId };
  });
  return {
    loadPublicContext: vi.fn(async ({ sha256 }) => ({ content: CONTEXT_CONTENT, sha256 })),
    admitGeneratedSource,
  };
}

function capturedSourceBucket(source: CapturedSource) {
  const key = submissionSourceKey(source.sourceId);
  const metadata = { kind: "submission-source", sourceId: source.sourceId, sha256: source.sha256 };
  return {
    head: vi.fn(async (candidate: string) => candidate === key
      ? { size: source.bytes.byteLength, customMetadata: metadata }
      : null),
    get: vi.fn(async (candidate: string) => candidate === key
      ? {
          size: source.bytes.byteLength,
          arrayBuffer: async () => source.bytes.slice().buffer,
        }
      : null),
  };
}

function completeSubmissionAndContest(fixture: Fixture, submissionId: string): void {
  const completedAt = "2026-08-26T00:15:00.000Z";
  fixture.database.prepare(`UPDATE submissions
    SET state='completed', verdict='accepted', score=100, fully_passed_cases=1,
        deterministic_cost=1, peak_memory_bytes=1024, policy_summary_json='{}',
        effective_attempt=1, updated_at=?, completed_at=? WHERE id=?`)
    .run(completedAt, completedAt, submissionId);
  fixture.database.prepare(`UPDATE contest_runtimes
    SET state='ended', wall_anchor_at=NULL, logical_anchor_seconds=900,
        paused_at=NULL, paused_from_state=NULL, ended_at=?, updated_at=?
    WHERE contest_id=?`)
    .run(completedAt, completedAt, fixture.contestId);
}

function productionSubmissionHost(
  fixture: Fixture,
): PromptAttemptHost & { readonly admitGeneratedSource: ReturnType<typeof vi.fn> } {
  const objects = new Map<string, {
    readonly bytes: Uint8Array;
    readonly customMetadata: Record<string, string>;
  }>();
  const bucket = {
    put: vi.fn(async (key: string, value: Uint8Array, options: {
      readonly customMetadata: Record<string, string>;
    }) => {
      if (objects.has(key)) return null;
      objects.set(key, { bytes: new Uint8Array(value), customMetadata: options.customMetadata });
      return { key };
    }),
    head: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength, customMetadata: object.customMetadata } : null;
    }),
  };
  const env = {
    DB: fixture.databaseAdapter,
    JUDGE_BUCKET: bucket,
    ACCOUNT_ERASURE_HMAC_SECRET: "test-submission-attempt-secret-at-least-32-bytes",
    SUBMISSION_WORKFLOW: {
      get: vi.fn(async () => { throw new Error("(instance.not_found) Instance not found"); }),
      create: vi.fn(async () => ({})),
    },
  } as never;
  const admitGeneratedSource = vi.fn((request: PromptGeneratedSubmissionRequest) => (
    admitPromptGeneratedSubmission(env, request)
  ));
  return {
    loadPublicContext: vi.fn(async ({ sha256 }) => ({ content: CONTEXT_CONTENT, sha256 })),
    admitGeneratedSource,
  };
}

function service(
  fixture: Fixture,
  compiler: PromptCompilerRegistry,
  host: PromptAttemptHost,
  options: {
    readonly attemptIds?: readonly string[];
    readonly now?: () => Date;
  } = {},
): PromptAttemptService {
  let monotonic = 100;
  return new PromptAttemptService({
    database: fixture.databaseAdapter,
    registry: compiler,
    host,
    now: options.now ?? (() => new Date(NOW)),
    randomUUID: uuidSequence(options.attemptIds ?? ATTEMPT_IDS),
    monotonicNow: () => {
      const current = monotonic;
      monotonic += 25;
      return current;
    },
  });
}

function createInput(fixture: Fixture, prompt = "Write a C solution.") {
  return {
    ownerUserId: OWNER_ID,
    contestId: fixture.contestId,
    problemId: fixture.problemId,
    timelineGeneration: 1,
    rulesEpoch: 1,
    problemEpoch: 1,
    publicContextSha256: fixture.contextSha256,
    prompt,
    idempotencyKey: createHash("sha256").update(prompt).digest("hex").slice(0, 32),
  };
}

describe("Prompt Program attempt workflow", () => {
  it("reserves synchronously, rejects stale or paused admission before reservation, and releases dispatch failure visibly", async () => {
    const fixture = await databaseFixture();
    const attempts = service(
      fixture,
      registry(async () => generatedResponse()),
      normalSubmissionHost(fixture),
    );

    await expect(attempts.reserve({ ...createInput(fixture), timelineGeneration: 2 }))
      .rejects.toMatchObject({ status: 409, code: "contest-epoch-stale" });
    fixture.database.prepare("UPDATE contest_runtimes SET state='paused', wall_anchor_at=NULL, paused_at=?, paused_from_state='running' WHERE contest_id=?")
      .run(NOW.toISOString(), fixture.contestId);
    await expect(attempts.reserve(createInput(fixture)))
      .rejects.toMatchObject({ status: 409, code: "contest-not-accepting-submissions" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM prompt_attempts").get()).toEqual({ count: 0 });

    fixture.database.prepare("UPDATE contest_runtimes SET state='running', wall_anchor_at=?, paused_at=NULL, paused_from_state=NULL WHERE contest_id=?")
      .run(START, fixture.contestId);
    const reserved = await attempts.reserve(createInput(fixture));
    expect(reserved).toMatchObject({ created: true, attempt: { state: "reserved", quota: { state: "reserved" } } });
    expect(fixture.database.prepare(`SELECT state, attempts, settled_at
      FROM prompt_attempt_dispatches WHERE prompt_attempt_id=?`).get(reserved.attempt.attemptId)).toEqual({
      state: "pending",
      attempts: 0,
      settled_at: null,
    });
    await attempts.failWorkflowDispatch(reserved.attempt.attemptId);
    await attempts.failWorkflowDispatch(reserved.attempt.attemptId);
    await expect(attempts.detail(reserved.attempt.attemptId, OWNER_ID)).resolves.toMatchObject({
      state: "failed",
      failureCode: "prompt-workflow-unavailable",
      quota: { state: "released", settlementReason: "prompt-workflow-unavailable" },
    });
    expect(fixture.database.prepare(`SELECT state, last_error, settled_at IS NOT NULL AS settled
      FROM prompt_attempt_dispatches WHERE prompt_attempt_id=?`).get(reserved.attempt.attemptId)).toEqual({
      state: "failed",
      last_error: "prompt-workflow-unavailable",
      settled: 1,
    });
  });

  it("terminally settles an interrupted generating attempt with no durable product", async () => {
    const fixture = await databaseFixture();
    const attempts = service(
      fixture,
      registry(async () => generatedResponse()),
      normalSubmissionHost(fixture),
    );
    const reservation = await attempts.reserve(createInput(fixture));
    fixture.database.prepare("UPDATE prompt_attempts SET state='generating' WHERE id=?")
      .run(reservation.attempt.attemptId);

    const detail = await attempts.failWorkflowExecution(reservation.attempt.attemptId);

    expect(detail).toMatchObject({
      state: "failed",
      failureCode: "prompt-workflow-execution-failure",
      quota: { state: "released", settlementReason: "prompt-workflow-execution-failure" },
    });
  });

  it("releases a stale consumed generation only when no exact durable product exists", async () => {
    const fixture = await databaseFixture();
    const attempts = service(
      fixture,
      registry(async () => generatedResponse()),
      normalSubmissionHost(fixture),
    );
    const reservation = await attempts.reserve(createInput(fixture));
    fixture.database.prepare(`UPDATE prompt_attempts
      SET state='generating', response_received_at=?, provider_duration_ms=25 WHERE id=?`)
      .run(NOW.toISOString(), reservation.attempt.attemptId);
    fixture.database.prepare(`UPDATE prompt_attempt_quota
      SET state='consumed', settled_at=?, settlement_reason='model-response-received'
      WHERE prompt_attempt_id=?`)
      .run(NOW.toISOString(), reservation.attempt.attemptId);

    const detail = await attempts.failWorkflowExecution(reservation.attempt.attemptId);

    expect(detail).toMatchObject({
      state: "failed",
      responseReceivedAt: NOW.toISOString(),
      failureCode: "prompt-submission-host-failure",
      generatedSourceId: null,
      submissionId: null,
      quota: { state: "released", settlementReason: "prompt-submission-host-failure" },
    });
  });

  it("keeps consumed quota and reconciles a stale generation with an exact durable product", async () => {
    const fixture = await databaseFixture();
    const host = normalSubmissionHost(fixture);
    const attempts = service(fixture, registry(async () => generatedResponse()), host);
    const reservation = await attempts.reserve(createInput(fixture));
    fixture.database.prepare(`UPDATE prompt_attempts
      SET state='generating', response_received_at=?, provider_duration_ms=25 WHERE id=?`)
      .run(NOW.toISOString(), reservation.attempt.attemptId);
    fixture.database.prepare(`UPDATE prompt_attempt_quota
      SET state='consumed', settled_at=?, settlement_reason='model-response-received'
      WHERE prompt_attempt_id=?`)
      .run(NOW.toISOString(), reservation.attempt.attemptId);
    await host.admitGeneratedSource({
      attemptId: reservation.attempt.attemptId,
      ownerUserId: OWNER_ID,
      contestId: fixture.contestId,
      entrantId: ENTRANT_ID,
      problemId: fixture.problemId,
      timelineGeneration: 1,
      rulesEpoch: 1,
      problemEpoch: 1,
      contentEpoch: 1,
      judgeEpoch: 1,
      contentCommit: COMMIT,
      judgeDigest: JUDGE_DIGEST,
      admittedLogicalSeconds: 30,
      sourceReadyLogicalSeconds: 30,
      timelineDisposition: "current",
      evidenceAt: "generated-source-ready",
      eligibility: "eligible",
      invalidatedAt: null,
      invalidationReason: null,
      generatedSource: {
        output: { language: "c", target: "wasip1", optimization: "release", entry: "main.c" },
        entry: "main.c",
        ...generatedResponse(),
      },
    });

    const detail = await attempts.failWorkflowExecution(reservation.attempt.attemptId);

    expect(detail).toMatchObject({
      state: "submitted",
      generatedSourceId: SOURCE_IDS[0],
      submissionId: SUBMISSION_IDS[0],
      failureCode: null,
      quota: { state: "consumed", settlementReason: "model-response-received" },
    });
  });

  it("terminally settles an interrupted generation whose quota was already invalidated", async () => {
    const fixture = await databaseFixture();
    const attempts = service(
      fixture,
      registry(async () => generatedResponse()),
      normalSubmissionHost(fixture),
    );
    const reservation = await attempts.reserve(createInput(fixture));
    fixture.database.prepare(`UPDATE prompt_attempts
      SET state='generating', eligibility='invalid', invalidated_at=?,
          invalidation_reason='timeline-rewind' WHERE id=?`)
      .run(NOW.toISOString(), reservation.attempt.attemptId);
    fixture.database.prepare(`UPDATE prompt_attempt_quota
      SET state='invalid', settled_at=?, settlement_reason='timeline-rewind'
      WHERE prompt_attempt_id=?`)
      .run(NOW.toISOString(), reservation.attempt.attemptId);

    const detail = await attempts.failWorkflowExecution(reservation.attempt.attemptId);

    expect(detail).toMatchObject({
      state: "cancelled",
      eligibility: "invalid",
      invalidationReason: "timeline-rewind",
      failureCode: "prompt-submission-host-failure",
      quota: { state: "invalid", settlementReason: "timeline-rewind" },
    });
  });

  it("atomically blocks admission until every due checkpoint has advanced the entrant", async () => {
    const fixture = await databaseFixture();
    const attempts = service(
      fixture,
      registry(async () => generatedResponse()),
      normalSubmissionHost(fixture),
    );
    fixture.database.prepare(`INSERT INTO contest_rule_checkpoints
      (contest_id, rules_commit, checkpoint_id, ordinal, at_seconds, scope_kind,
       scope_batch, scope_problem_slugs_json, minimum_solved, minimum_score,
       ranking_kind, ranking_value, settlement, checkpoint_rules_json)
      VALUES (?, ?, 'gate', 1, 20, 'all-released', NULL, NULL, 0, NULL,
        NULL, NULL, 'provisional', '{}')`)
      .run(fixture.contestId, COMMIT);

    await expect(attempts.reserve(createInput(fixture)))
      .rejects.toMatchObject({ status: 409, code: "contest-checkpoint-not-advanced" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM prompt_attempts").get()).toEqual({ count: 0 });

    const runId = "80000000-0000-4000-8000-000000000001";
    fixture.database.prepare(`INSERT INTO contest_checkpoint_runs
      (id, contest_id, checkpoint_id, timeline_generation, rules_epoch,
       logical_seconds, settlement, state, population, pending_work,
       created_at, finalized_at, invalidated_at, invalidation_reason)
      VALUES (?, ?, 'gate', 1, 1, 20, 'provisional', 'final', 1, 0,
        ?, ?, NULL, NULL)`)
      .run(runId, fixture.contestId, START, START);
    fixture.database.prepare(`INSERT INTO contest_checkpoint_decisions
      (checkpoint_run_id, entrant_id, decision, provisional,
       competitive_key_json, decided_at)
      VALUES (?, ?, 'advanced', 0, '[]', ?)`)
      .run(runId, ENTRANT_ID, START);

    await expect(attempts.reserve(createInput(fixture)))
      .resolves.toMatchObject({ created: true, attempt: { state: "reserved" } });
  });

  it("uses an opaque durable reservation for replay-safe exactly-once generation", async () => {
    const fixture = await databaseFixture();
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const compile = vi.fn<PromptCompilerAdapter["compile"]>(async () => {
      await gate;
      return generatedResponse();
    });
    const attempts = service(fixture, registry(compile), normalSubmissionHost(fixture));
    const reservation = await attempts.reserve(createInput(fixture));

    const first = attempts.runReserved(reservation.attempt.attemptId);
    const replay = attempts.runReserved(reservation.attempt.attemptId);
    unblock();
    const [completed, observed] = await Promise.all([first, replay]);

    expect(compile).toHaveBeenCalledOnce();
    expect(completed.state).toBe("submitted");
    expect(["generating", "submitted"]).toContain(observed.state);
    await expect(attempts.runReserved(reservation.attempt.attemptId))
      .resolves.toMatchObject({ state: "submitted", submissionId: SUBMISSION_IDS[0] });
    expect(compile).toHaveBeenCalledOnce();
  });

  it("replays the same idempotency request and rejects key reuse with different content", async () => {
    const fixture = await databaseFixture();
    const attempts = service(fixture, registry(async () => generatedResponse()), normalSubmissionHost(fixture));
    const input = createInput(fixture);
    const first = await attempts.reserve(input);
    const replay = await attempts.reserve(input, ATTEMPT_IDS[1]);
    expect(replay).toEqual({ created: false, attempt: first.attempt });
    await expect(attempts.reserve({ ...input, prompt: "different" }, ATTEMPT_IDS[2]))
      .rejects.toMatchObject({ status: 409, code: "prompt-idempotency-conflict" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM prompt_attempts").get()).toEqual({ count: 1 });
  });

  it("atomically consumes one slot, persists provenance, and links only a verified normal submission", async () => {
    const fixture = await databaseFixture();
    const compile = vi.fn<PromptCompilerAdapter["compile"]>(async () => generatedResponse());
    const host = normalSubmissionHost(fixture);
    const attempts = service(fixture, registry(compile), host);

    const detail = await attempts.create(createInput(fixture));

    await expect(host.admitGeneratedSource.mock.results[0]!.value).resolves.toEqual(expect.objectContaining({
      sourceId: expect.any(String),
      submissionId: expect.any(String),
    }));
    expect(detail).toMatchObject({
      attemptId: ATTEMPT_IDS[0],
      entrantId: ENTRANT_ID,
      state: "submitted",
      quota: { slot: 1, limit: 2, state: "consumed", settlementReason: "model-response-received" },
      output: { language: "c", target: "wasip1", optimization: "release", entry: "main.c" },
      generatedSourceId: SOURCE_IDS[0],
      submissionId: SUBMISSION_IDS[0],
      admittedLogicalSeconds: 30,
      evidenceLogicalSeconds: 30,
      providerDurationMs: 25,
      failureCode: null,
    });
    expect(detail.promptBytes).toBe(new TextEncoder().encode("Write a C solution.").byteLength);
    expect(detail.promptSha256).toBe(await sha256Hex("Write a C solution."));
    expect(compile).toHaveBeenCalledOnce();
    expect(host.admitGeneratedSource).toHaveBeenCalledOnce();
    expect(fixture.database.prepare(`SELECT source_kind, state FROM submission_sources WHERE id=?`).get(SOURCE_IDS[0]))
      .toEqual({ source_kind: "prompt-generated", state: "ready" });
    expect(fixture.database.prepare(`SELECT timeline_generation, rules_epoch, content_epoch,
      judge_epoch, evidence_at, evidence_logical_seconds
      FROM contest_submission_records WHERE submission_id=?`).get(SUBMISSION_IDS[0])).toEqual({
      timeline_generation: 1,
      rules_epoch: 1,
      content_epoch: 1,
      judge_epoch: 1,
      evidence_at: "generated-source-ready",
      evidence_logical_seconds: 30,
    });

    const events = await attempts.events({ ownerUserId: OWNER_ID, attemptId: ATTEMPT_IDS[0] });
    expect(events.map((event) => event.type)).toEqual([
      "reserved",
      "generation-started",
      "response-received",
      "source-ready",
      "submission-created",
    ]);
    await expect(attempts.events({ ownerUserId: "another-user", attemptId: ATTEMPT_IDS[0] }))
      .rejects.toMatchObject({ status: 404, code: "prompt-attempt-not-found" });
    await expect(attempts.detail(ATTEMPT_IDS[0], "another-user"))
      .rejects.toMatchObject({ status: 404, code: "prompt-attempt-not-found" });

    expect(await attempts.history({ ownerUserId: OWNER_ID, contestId: fixture.contestId })).toEqual([
      expect.objectContaining({
        attemptId: ATTEMPT_IDS[0],
        state: "submitted",
        quotaState: "consumed",
        submissionId: SUBMISSION_IDS[0],
      }),
    ]);
    expect(await attempts.events({
      ownerUserId: OWNER_ID,
      attemptId: ATTEMPT_IDS[0],
      after: events[2]!.sequence,
    })).toHaveLength(2);
  });

  it("returns typed 503 before context loading or quota reservation when no adapter exists", async () => {
    const fixture = await databaseFixture();
    const host = normalSubmissionHost(fixture);
    const attempts = service(fixture, new PromptCompilerRegistry(), host);

    await expect(attempts.create(createInput(fixture))).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      code: "prompt-compiler-unavailable",
    });
    expect(host.loadPublicContext).not.toHaveBeenCalled();
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM prompt_attempts").get()).toEqual({ count: 0 });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM prompt_attempt_quota").get()).toEqual({ count: 0 });
  });

  it("releases a pre-response provider failure and reuses the released slot", async () => {
    const fixture = await databaseFixture();
    const compile = vi.fn<PromptCompilerAdapter["compile"]>()
      .mockRejectedValueOnce(new PromptCompilerAdapterError("provider unavailable", true))
      .mockResolvedValueOnce(generatedResponse());
    const host = normalSubmissionHost(fixture);
    const attempts = service(fixture, registry(compile), host);

    const failed = await attempts.create(createInput(fixture, "first"));
    expect(failed).toMatchObject({
      state: "failed",
      quota: { slot: 1, state: "released", settlementReason: "prompt-provider-failure" },
      responseReceivedAt: null,
      failureCode: "prompt-provider-failure",
    });
    expect((await attempts.events({ ownerUserId: OWNER_ID, attemptId: ATTEMPT_IDS[0] }))
      .map((event) => event.type)).toEqual([
      "reserved",
      "generation-started",
      "failed",
      "quota-released",
    ]);

    const succeeded = await attempts.create(createInput(fixture, "second"));
    expect(succeeded).toMatchObject({ state: "submitted", quota: { slot: 1, state: "consumed" } });
  });

  it("consumes malformed responses and atomically enforces the configured attempt limit", async () => {
    const fixture = await databaseFixture();
    const compile = vi.fn<PromptCompilerAdapter["compile"]>()
      .mockResolvedValueOnce("```c\nint main(){}\n```")
      .mockResolvedValue(generatedResponse());
    const host = normalSubmissionHost(fixture);
    const attempts = service(fixture, registry(compile), host);

    const malformed = await attempts.create(createInput(fixture, "malformed"));
    expect(malformed).toMatchObject({
      state: "failed",
      quota: { slot: 1, state: "consumed", settlementReason: "model-response-received" },
      failureCode: "prompt-response-invalid",
    });
    expect(malformed.responseReceivedAt).not.toBeNull();
    const valid = await attempts.create(createInput(fixture, "valid"));
    expect(valid).toMatchObject({ state: "submitted", quota: { slot: 2, state: "consumed" } });

    await expect(attempts.create(createInput(fixture, "over limit"))).rejects.toMatchObject({
      status: 409,
      code: "prompt-attempt-limit",
    });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM prompt_attempts").get()).toEqual({ count: 2 });
    expect(fixture.database.prepare(`SELECT quota_slot, state FROM prompt_attempt_quota
      ORDER BY quota_slot`).all()).toEqual([
      { quota_slot: 1, state: "consumed" },
      { quota_slot: 2, state: "consumed" },
    ]);
  });

  it("releases quota when the platform cannot persist the normal submission product", async () => {
    for (const options of [{ fail: true }, { omitPersistence: true }]) {
      const fixture = await databaseFixture();
      const host = normalSubmissionHost(fixture, options);
      const attempts = service(fixture, registry(async () => generatedResponse()), host);

      const detail = await attempts.create(createInput(fixture));
      expect(detail).toMatchObject({
        state: "failed",
        quota: { state: "released", settlementReason: "prompt-submission-host-failure" },
        failureCode: "prompt-submission-host-failure",
        generatedSourceId: null,
        submissionId: null,
      });
      expect(detail.responseReceivedAt).not.toBeNull();
    }
  });

  it("keeps quota consumed and links an exact durable product when the host response is uncertain", async () => {
    const fixture = await databaseFixture();
    const attempts = service(
      fixture,
      registry(async () => generatedResponse()),
      normalSubmissionHost(fixture, { throwAfterPersistence: true }),
    );

    const detail = await attempts.create(createInput(fixture));

    expect(detail).toMatchObject({
      state: "submitted",
      quota: { state: "consumed", settlementReason: "model-response-received" },
      generatedSourceId: SOURCE_IDS[0],
      submissionId: SUBMISSION_IDS[0],
      failureCode: null,
    });
    expect(fixture.database.prepare("SELECT prompt_attempt_id FROM contest_submission_records WHERE submission_id=?")
      .get(SUBMISSION_IDS[0])).toEqual({ prompt_attempt_id: ATTEMPT_IDS[0] });
  });

  it("reconciles a recovered Official Submission into the best-after-end gallery without another model call", async () => {
    const fixture = await databaseFixture();
    const compile = vi.fn<PromptCompilerAdapter["compile"]>(async () => generatedResponse());
    let captured: CapturedSource | undefined;
    const attempts = service(
      fixture,
      registry(compile),
      normalSubmissionHost(fixture, {
        throwAfterPersistence: true,
        leaveSourceReserved: true,
        captureSource: (sourceId, bytes, sha256) => { captured = { sourceId, bytes, sha256 }; },
      }),
    );

    const failed = await attempts.create(createInput(fixture));

    expect(failed).toMatchObject({
      state: "failed",
      failureCode: "prompt-submission-reconciliation-required",
      quota: { state: "consumed", settlementReason: "model-response-received" },
      generatedSourceId: SOURCE_IDS[0],
      submissionId: SUBMISSION_IDS[0],
    });
    expect(compile).toHaveBeenCalledOnce();
    expect(captured).toBeDefined();
    const bucket = capturedSourceBucket(captured!);
    fixture.database.prepare("UPDATE submissions SET state='admitting', updated_at=? WHERE id=?")
      .run(START, SUBMISSION_IDS[0]);
    const admissionEnv = {
      DB: fixture.databaseAdapter,
      JUDGE_BUCKET: bucket,
      ACCOUNT_ERASURE_HMAC_SECRET: "prompt-recovery-test-secret-at-least-32-bytes",
      SUBMISSION_WORKFLOW: {
        get: vi.fn(async () => { throw new Error("(instance.not_found) Instance not found"); }),
        create: vi.fn(async () => ({})),
      },
    } as never;

    await expect(reconcileAdmittingSubmission(
      admissionEnv,
      SUBMISSION_IDS[0],
      new Date("2026-08-26T00:05:00.000Z"),
    )).resolves.toBe(true);
    await expect(reconcilePromptAttemptProduct(
      fixture.databaseAdapter,
      SUBMISSION_IDS[0],
      new Date("2026-08-26T00:06:00.000Z"),
    )).resolves.toBe(false);

    const recovered = await attempts.detail(failed.attemptId, OWNER_ID);
    expect(recovered).toMatchObject({
      state: "submitted",
      failureCode: null,
      eligibility: "eligible",
      generatedSourceId: SOURCE_IDS[0],
      submissionId: SUBMISSION_IDS[0],
      quota: { state: "consumed", settlementReason: "model-response-received" },
    });
    expect(recovered.terminalAt).toBe(failed.terminalAt);
    expect((await attempts.events({ ownerUserId: OWNER_ID, attemptId: failed.attemptId }))
      .map((event) => event.type)).toEqual([
      "reserved",
      "generation-started",
      "response-received",
      "failed",
      "reconciled",
    ]);
    expect(compile).toHaveBeenCalledOnce();

    completeSubmissionAndContest(fixture, SUBMISSION_IDS[0]);
    const response = await promptContestGallery(
      new Request(`https://example.test/api/contests/${fixture.contestId}/prompt-gallery`),
      { DB: fixture.databaseAdapter, JUDGE_BUCKET: bucket } as never,
      fixture.contestId,
    );
    await expect(response.json()).resolves.toMatchObject({
      contestId: fixture.contestId,
      entries: [{
        promptAttemptId: failed.attemptId,
        submissionId: SUBMISSION_IDS[0],
        prompt: "Write a C solution.",
      }],
    });
    expect(compile).toHaveBeenCalledOnce();
  });

  it("never republishes eligibility while reconciling an invalid recovered product", async () => {
    const fixture = await databaseFixture();
    const compile = vi.fn<PromptCompilerAdapter["compile"]>(async () => generatedResponse());
    let captured: CapturedSource | undefined;
    const attempts = service(
      fixture,
      registry(compile),
      normalSubmissionHost(fixture, {
        throwAfterPersistence: true,
        leaveSourceReserved: true,
        captureSource: (sourceId, bytes, sha256) => { captured = { sourceId, bytes, sha256 }; },
      }),
    );
    const failed = await attempts.create(createInput(fixture));
    const invalidatedAt = "2026-08-26T00:04:00.000Z";
    fixture.database.prepare(`UPDATE prompt_attempts
      SET eligibility='invalid', invalidated_at=?,
          invalidation_reason='generated-source-ready-after-close' WHERE id=?`)
      .run(invalidatedAt, failed.attemptId);
    fixture.database.prepare(`UPDATE contest_submission_records
      SET eligibility='invalid', invalidated_at=?,
          invalidation_reason='generated-source-ready-after-close'
      WHERE prompt_attempt_id=?`)
      .run(invalidatedAt, failed.attemptId);
    fixture.database.prepare(`UPDATE submission_sources
      SET state='ready', ready_at=? WHERE id=? AND state='reserved'`)
      .run(invalidatedAt, SOURCE_IDS[0]);

    await expect(reconcileReadyPromptAttemptProducts(
      fixture.databaseAdapter,
      new Date("2026-08-26T00:05:00.000Z"),
    )).resolves.toBe(1);
    await expect(reconcileReadyPromptAttemptProducts(
      fixture.databaseAdapter,
      new Date("2026-08-26T00:06:00.000Z"),
    )).resolves.toBe(0);
    const recovered = await attempts.detail(failed.attemptId, OWNER_ID);
    expect(recovered).toMatchObject({
      state: "submitted",
      eligibility: "invalid",
      invalidationReason: "generated-source-ready-after-close",
      failureCode: null,
      quota: { state: "consumed" },
    });
    expect(recovered.terminalAt).toBe(failed.terminalAt);
    expect(compile).toHaveBeenCalledOnce();

    expect(captured).toBeDefined();
    const bucket = capturedSourceBucket(captured!);
    completeSubmissionAndContest(fixture, SUBMISSION_IDS[0]);
    const response = await promptContestGallery(
      new Request(`https://example.test/api/contests/${fixture.contestId}/prompt-gallery`),
      { DB: fixture.databaseAdapter, JUDGE_BUCKET: bucket } as never,
      fixture.contestId,
    );
    await expect(response.json()).resolves.toMatchObject({ entries: [] });
    expect(compile).toHaveBeenCalledOnce();
  });

  it("records a source completed at the close boundary but marks its official timeline evidence invalid", async () => {
    const fixture = await databaseFixture();
    let currentTime = new Date("2026-08-26T00:14:59.000Z");
    const compile = vi.fn<PromptCompilerAdapter["compile"]>(async () => {
      currentTime = new Date("2026-08-26T00:15:00.000Z");
      return generatedResponse();
    });
    const host = normalSubmissionHost(fixture);
    const attempts = service(fixture, registry(compile), host, {
      now: () => new Date(currentTime),
    });

    const detail = await attempts.create(createInput(fixture));

    expect(detail).toMatchObject({
      state: "submitted",
      quota: { state: "consumed", settlementReason: "model-response-received" },
      eligibility: "invalid",
      invalidationReason: "generated-source-ready-after-close",
      admittedLogicalSeconds: 899,
      evidenceLogicalSeconds: 900,
      sourceReadyAt: "2026-08-26T00:15:00.000Z",
      generatedSourceId: SOURCE_IDS[0],
      submissionId: SUBMISSION_IDS[0],
    });
    expect(host.admitGeneratedSource).toHaveBeenCalledWith(expect.objectContaining({
      admittedLogicalSeconds: 899,
      sourceReadyLogicalSeconds: 900,
      eligibility: "invalid",
      invalidatedAt: "2026-08-26T00:15:00.000Z",
      invalidationReason: "generated-source-ready-after-close",
    }));
    expect(fixture.database.prepare(`SELECT evidence_logical_seconds, eligibility,
      invalidated_at, invalidation_reason
      FROM contest_submission_records WHERE submission_id=?`).get(SUBMISSION_IDS[0])).toEqual({
      evidence_logical_seconds: 900,
      eligibility: "invalid",
      invalidated_at: "2026-08-26T00:15:00.000Z",
      invalidation_reason: "generated-source-ready-after-close",
    });
    expect((await attempts.events({ ownerUserId: OWNER_ID, attemptId: ATTEMPT_IDS[0] }))
      .map((event) => event.type)).toEqual([
      "reserved",
      "generation-started",
      "response-received",
      "source-ready",
      "submission-created",
      "invalidated",
    ]);
  });

  it("persists a locked invalid official history when generation resolves after rewind", async () => {
    const fixture = await databaseFixture();
    const compile = vi.fn<PromptCompilerAdapter["compile"]>(async () => {
      fixture.database.prepare(`UPDATE contest_runtimes
        SET timeline_generation=2, updated_at=? WHERE contest_id=?`).run(START, fixture.contestId);
      fixture.database.prepare(`UPDATE prompt_attempts
        SET eligibility='invalid', invalidated_at=?, invalidation_reason='timeline-rewind', updated_at=?
        WHERE id=? AND state='generating'`)
        .run(NOW.toISOString(), NOW.toISOString(), ATTEMPT_IDS[0]);
      fixture.database.prepare(`UPDATE prompt_attempt_quota
        SET state='invalid', settled_at=?, settlement_reason='timeline-rewind'
        WHERE prompt_attempt_id=? AND state='reserved'`)
        .run(NOW.toISOString(), ATTEMPT_IDS[0]);
      fixture.database.prepare(`INSERT INTO prompt_attempt_events
        (prompt_attempt_id, event_key, event_type, payload_json, created_at)
        VALUES (?, 'eligibility:timeline-rewind:2', 'invalidated',
          '{"reason":"timeline-rewind","timelineGeneration":2}', ?)`)
        .run(ATTEMPT_IDS[0], NOW.toISOString());
      return generatedResponse();
    });
    const host = normalSubmissionHost(fixture);
    const attempts = service(fixture, registry(compile), host);

    const detail = await attempts.create(createInput(fixture));
    expect(detail).toMatchObject({
      state: "cancelled",
      eligibility: "invalid",
      invalidationReason: "timeline-rewind",
      quota: { state: "invalid", settlementReason: "timeline-rewind" },
      generatedSourceId: SOURCE_IDS[0],
      submissionId: SUBMISSION_IDS[0],
      evidenceLogicalSeconds: null,
    });
    expect(detail.responseReceivedAt).not.toBeNull();
    expect(compile).toHaveBeenCalledOnce();
    expect(host.admitGeneratedSource).toHaveBeenCalledOnce();
    expect(host.admitGeneratedSource).toHaveBeenCalledWith(expect.objectContaining({
      timelineDisposition: "invalid-history",
      sourceReadyLogicalSeconds: null,
      eligibility: "invalid",
      invalidationReason: "timeline-rewind",
    }));
    expect(fixture.database.prepare(`SELECT eligibility, evidence_logical_seconds,
      invalidation_reason, prompt_attempt_id FROM contest_submission_records
      WHERE submission_id=?`).get(SUBMISSION_IDS[0])).toEqual({
      eligibility: "invalid",
      evidence_logical_seconds: null,
      invalidation_reason: "timeline-rewind",
      prompt_attempt_id: ATTEMPT_IDS[0],
    });
    expect((await attempts.events({ ownerUserId: OWNER_ID, attemptId: ATTEMPT_IDS[0] }))
      .map((event) => event.type)).toEqual([
      "reserved",
      "generation-started",
      "invalidated",
      "response-received",
      "source-ready",
      "submission-created",
      "cancelled",
    ]);
  });

  it("admits rewind-invalid history through the production Official Submission host fence", async () => {
    const fixture = await databaseFixture();
    const compile = vi.fn<PromptCompilerAdapter["compile"]>(async () => {
      fixture.database.prepare(`UPDATE contest_runtimes
        SET timeline_generation=2, updated_at=? WHERE contest_id=?`).run(START, fixture.contestId);
      fixture.database.prepare(`UPDATE prompt_attempts
        SET eligibility='invalid', invalidated_at=?, invalidation_reason='timeline-rewind', updated_at=?
        WHERE id=? AND state='generating'`)
        .run(NOW.toISOString(), NOW.toISOString(), ATTEMPT_IDS[0]);
      fixture.database.prepare(`UPDATE prompt_attempt_quota
        SET state='invalid', settled_at=?, settlement_reason='timeline-rewind'
        WHERE prompt_attempt_id=? AND state='reserved'`)
        .run(NOW.toISOString(), ATTEMPT_IDS[0]);
      return generatedResponse();
    });
    const host = productionSubmissionHost(fixture);
    const attempts = service(fixture, registry(compile), host);

    const detail = await attempts.create(createInput(fixture));

    await expect(host.admitGeneratedSource.mock.results[0]!.value).resolves.toEqual(expect.objectContaining({
      sourceId: expect.any(String),
      submissionId: expect.any(String),
    }));
    expect(detail).toMatchObject({
      state: "cancelled",
      eligibility: "invalid",
      invalidationReason: "timeline-rewind",
      quota: { state: "invalid", settlementReason: "timeline-rewind" },
    });
    expect(detail.generatedSourceId).not.toBeNull();
    expect(detail.submissionId).not.toBeNull();
    expect(host.admitGeneratedSource).toHaveBeenCalledWith(expect.objectContaining({
      timelineDisposition: "invalid-history",
      sourceReadyLogicalSeconds: null,
    }));
    expect(fixture.database.prepare(`SELECT records.eligibility,
        records.evidence_logical_seconds, records.invalidation_reason,
        sources.state AS source_state, sources.source_kind
      FROM contest_submission_records AS records
      JOIN submissions ON submissions.id=records.submission_id
      JOIN submission_sources AS sources ON sources.id=submissions.source_id
      WHERE records.prompt_attempt_id=?`).get(detail.attemptId)).toEqual({
      eligibility: "invalid",
      evidence_logical_seconds: null,
      invalidation_reason: "timeline-rewind",
      source_state: "ready",
      source_kind: "prompt-generated",
    });
  });

  it("does not reserve for a bad context digest or an unrevealed problem", async () => {
    const fixture = await databaseFixture();
    const host = normalSubmissionHost(fixture);
    host.loadPublicContext = vi.fn(async ({ sha256 }) => ({ content: `${CONTEXT_CONTENT}changed`, sha256 }));
    const attempts = service(fixture, registry(async () => generatedResponse()), host);
    await expect(attempts.create(createInput(fixture))).rejects.toMatchObject({
      status: 503,
      code: "prompt-context-unavailable",
    });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM prompt_attempts").get()).toEqual({ count: 0 });

    fixture.database.prepare("DELETE FROM contest_reveal_grants").run();
    const validHost = normalSubmissionHost(fixture);
    await expect(service(fixture, registry(async () => generatedResponse()), validHost)
      .create(createInput(fixture))).rejects.toMatchObject({
      status: 409,
      code: "contest-problem-locked",
    });
    expect(validHost.loadPublicContext).not.toHaveBeenCalled();
  });
});

describe("Prompt Program private query contracts", () => {
  it("validates event and history bounds without touching D1", async () => {
    const fixture = await databaseFixture();
    const attempts = service(fixture, registry(async () => generatedResponse()), normalSubmissionHost(fixture));
    await expect(attempts.events({ ownerUserId: OWNER_ID, attemptId: ATTEMPT_IDS[0], limit: 101 }))
      .rejects.toBeInstanceOf(ApiError);
    await expect(attempts.history({ ownerUserId: OWNER_ID, contestId: fixture.contestId, limit: 0 }))
      .rejects.toMatchObject({ status: 400, code: "prompt-history-limit-invalid" });
  });
});
