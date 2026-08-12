import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";

const mocks = vi.hoisted(() => ({
  dispatchCatalogJobs: vi.fn(async () => 0),
  resolveExactCommit: vi.fn(async () => "b".repeat(40)),
}));

vi.mock("./auth", () => ({
  authenticatedSession: vi.fn(async () => undefined),
  requireMutationSession: vi.fn(async () => ({
    userId: "11111111-1111-4111-8111-111111111111",
    login: "organizer",
    avatarUrl: "https://example.test/organizer.png",
    roles: ["organizer"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  })),
  requireSession: vi.fn(async () => {
    throw new Error("Unexpected read session.");
  }),
}));
vi.mock("./catalog-dispatcher", () => ({ dispatchCatalogJobs: mocks.dispatchCatalogJobs }));
vi.mock("./catalog-github", () => ({
  authorizedCatalogRepository: vi.fn(async () => ({
    githubRepositoryId: 42,
    installationId: 7,
    owner: "wasm-oj",
    repository: "official-problems",
    isPrivate: true,
    token: "github-token-for-tests",
  })),
  catalogRepositoryById: vi.fn(async () => {
    throw new Error("Unexpected repository lookup.");
  }),
  readVerifiedBlob: vi.fn(async () => {
    throw new Error("Unexpected blob read.");
  }),
  resolveExactCommit: mocks.resolveExactCommit,
}));
vi.mock("./formal-access", () => ({ requireStagingFormalAccess: vi.fn(async () => undefined) }));
vi.mock("./formal-mutations", () => ({ requireFormalMutationsEnabled: vi.fn(async () => undefined) }));
vi.mock("./github", () => ({ requireOrganizer: vi.fn(async () => undefined) }));

import { createCatalogValidation } from "./catalog";

type Binding = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement {
  private bindings: readonly Binding[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: Binding[]): SqliteStatement {
    this.bindings = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null;
  }

  async run(): Promise<{ readonly meta: { readonly changes: number } }> {
    return this.execute();
  }

  execute(): { readonly meta: { readonly changes: number } } {
    return { meta: { changes: Number(this.database.prepare(this.sql).run(...this.bindings).changes) } };
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  async batch(statements: readonly SqliteStatement[]): Promise<readonly { readonly meta: { readonly changes: number } }[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const USER_ID = "11111111-1111-4111-8111-111111111111";
const COLLECTION_ID = "22222222-2222-4222-8222-222222222222";
const REVISION_ID = "33333333-3333-4333-8333-333333333333";
const VALIDATION_JOB_ID = "44444444-4444-4444-8444-444444444444";
const COMMIT_SHA = "b".repeat(40);
const SUMMARY = {
  schema: "wasm-oj-platform/catalog-validation-summary/v2",
  valid: true,
  commitSha: COMMIT_SHA,
  collectionRevision: "c".repeat(64),
  problemCount: 45,
};

function fixture(): { readonly database: DatabaseSync; readonly env: WasmOjWorkerEnv } {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE problem_collections (
      id TEXT PRIMARY KEY, organizer_user_id TEXT NOT NULL, github_repository_id INTEGER NOT NULL,
      index_path TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE catalog_validation_jobs (
      id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, requested_ref TEXT NOT NULL,
      commit_sha TEXT NOT NULL, state TEXT NOT NULL, created_by TEXT NOT NULL,
      error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, finished_at TEXT
    ) STRICT;
    CREATE TABLE collection_revisions (
      id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, validation_job_id TEXT NOT NULL,
      commit_sha TEXT NOT NULL, validation_summary_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE catalog_publish_jobs (
      id TEXT PRIMARY KEY, collection_revision_id TEXT NOT NULL, state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE workflow_outbox (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, catalog_validation_job_id TEXT,
      attempts INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;`);
  database.prepare(`INSERT INTO problem_collections
      (id, organizer_user_id, github_repository_id, index_path, created_at, updated_at)
    VALUES (?, ?, 42, 'collection/index.json', '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')`)
    .run(COLLECTION_ID, USER_ID);
  return {
    database,
    env: {
      DB: new SqliteD1(database) as unknown as D1Database,
      ENVIRONMENT: "production",
    } as WasmOjWorkerEnv,
  };
}

function validationRequest(ref: string): Request {
  return new Request(`https://wasm-oj.test/api/organizer/collections/${COLLECTION_ID}/validations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref }),
  });
}

describe("catalog validation creation projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveExactCommit.mockResolvedValue(COMMIT_SHA);
  });

  it("reuses a durable valid revision after its operational job row is gone", async () => {
    const { database, env } = fixture();
    database.prepare(`INSERT INTO collection_revisions
      (id, collection_id, validation_job_id, commit_sha, validation_summary_json)
      VALUES (?, ?, ?, ?, ?)`)
      .run(REVISION_ID, COLLECTION_ID, VALIDATION_JOB_ID, COMMIT_SHA, JSON.stringify(SUMMARY));
    expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_validation_jobs").get()).toEqual({ count: 0 });

    const response = await createCatalogValidation(validationRequest("release/current"), env, COLLECTION_ID);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ validation: {
      id: VALIDATION_JOB_ID,
      collectionId: COLLECTION_ID,
      requestedRef: "release/current",
      commitSha: COMMIT_SHA,
      state: "valid",
      errorCode: null,
      revisionId: REVISION_ID,
      summary: SUMMARY,
    } });
    expect(mocks.dispatchCatalogJobs).not.toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_validation_jobs").get()).toEqual({ count: 0 });
  });

  it("returns the complete queued projection for a newly admitted validation", async () => {
    const { database, env } = fixture();

    const response = await createCatalogValidation(validationRequest("main"), env, COLLECTION_ID);
    const payload = await response.json() as { readonly validation: Record<string, unknown> };

    expect(response.status).toBe(202);
    expect(payload).toEqual({ validation: {
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      collectionId: COLLECTION_ID,
      requestedRef: "main",
      commitSha: COMMIT_SHA,
      state: "queued",
      errorCode: null,
      revisionId: null,
      summary: null,
    } });
    expect(database.prepare(`SELECT collection_id, requested_ref, commit_sha, state
      FROM catalog_validation_jobs WHERE id=?`).get(payload.validation.id as string)).toEqual({
      collection_id: COLLECTION_ID,
      requested_ref: "main",
      commit_sha: COMMIT_SHA,
      state: "queued",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM workflow_outbox").get()).toEqual({ count: 1 });
    expect(mocks.dispatchCatalogJobs).toHaveBeenCalledOnce();
  });
});
