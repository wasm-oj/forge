import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";

const ATTEMPT_ID = "50000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-08-26T00:00:00.000Z";
const NOW = new Date("2026-08-26T02:00:00.000Z");
const mocks = vi.hoisted(() => ({
  failWorkflowDispatch: vi.fn(),
  failWorkflowExecution: vi.fn(),
  markWorkflowDispatched: vi.fn(),
  reconcileReadyProducts: vi.fn(),
  status: vi.fn(),
}));

vi.mock("./prompt-attempts", () => ({
  PromptAttemptService: class {
    failWorkflowDispatch = mocks.failWorkflowDispatch;
    failWorkflowExecution = mocks.failWorkflowExecution;
    markWorkflowDispatched = mocks.markWorkflowDispatched;
  },
  reconcileReadyPromptAttemptProducts: mocks.reconcileReadyProducts,
}));
vi.mock("./prompt-compiler-registry", () => ({ hostPromptCompilerRegistry: vi.fn(() => ({})) }));
vi.mock("./submissions", () => ({ createPromptAttemptHost: vi.fn(() => ({})) }));
vi.mock("./workflow-instance-status", () => ({ lookupWorkflowInstance: mocks.status }));

import { reconcilePromptAttemptDispatches } from "./prompt-dispatcher";

class Statement {
  private bindings: SQLInputValue[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]): Statement { this.bindings = values as SQLInputValue[]; return this; }
  async all<T>(): Promise<D1Result<T>> {
    return { success: true, results: this.database.prepare(this.sql).all(...this.bindings) as T[], meta: {} } as D1Result<T>;
  }
  async run(): Promise<D1Result> {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
  }
}

function fixture(attempts = 0) {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE prompt_attempts (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE prompt_attempt_dispatches (
      prompt_attempt_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;`);
  database.prepare("INSERT INTO prompt_attempts VALUES (?, 'reserved', ?)").run(ATTEMPT_ID, CREATED_AT);
  database.prepare(`INSERT INTO prompt_attempt_dispatches
      VALUES (?, 'pending', ?, NULL, ?, ?)`)
    .run(ATTEMPT_ID, attempts, CREATED_AT, CREATED_AT);
  const workflowCreate = vi.fn();
  return {
    database,
    workflowCreate,
    env: {
      DB: { prepare: (sql: string) => new Statement(database, sql) },
      PROMPT_ATTEMPT_WORKFLOW: { create: workflowCreate },
    } as unknown as WasmOjWorkerEnv,
  };
}

describe("Prompt attempt durable dispatch reconciliation", () => {
  beforeEach(() => {
    mocks.failWorkflowDispatch.mockReset().mockResolvedValue(undefined);
    mocks.failWorkflowExecution.mockReset().mockResolvedValue({ state: "failed" });
    mocks.markWorkflowDispatched.mockReset().mockResolvedValue(undefined);
    mocks.reconcileReadyProducts.mockReset().mockResolvedValue(0);
    mocks.status.mockReset().mockResolvedValue({ found: false });
  });

  it("runs the bounded durable-product closure even without live Workflow work", async () => {
    const { database, env } = fixture();
    database.prepare("UPDATE prompt_attempts SET state='failed' WHERE id=?").run(ATTEMPT_ID);
    database.prepare("UPDATE prompt_attempt_dispatches SET state='delivered' WHERE prompt_attempt_id=?")
      .run(ATTEMPT_ID);
    mocks.reconcileReadyProducts.mockResolvedValue(1);

    await expect(reconcilePromptAttemptDispatches(env, NOW)).resolves.toBe(1);

    expect(mocks.reconcileReadyProducts).toHaveBeenCalledWith(env.DB, NOW);
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("recovers a reserve-to-create process crash with opaque deterministic Workflow params", async () => {
    const { env, workflowCreate } = fixture();
    workflowCreate.mockResolvedValue({ id: ATTEMPT_ID });

    await expect(reconcilePromptAttemptDispatches(env, NOW)).resolves.toBe(1);

    expect(workflowCreate).toHaveBeenCalledOnce();
    expect(workflowCreate).toHaveBeenCalledWith({
      id: ATTEMPT_ID,
      params: { attemptId: ATTEMPT_ID },
    });
    expect(mocks.markWorkflowDispatched).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(mocks.failWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("settles a bounded stale reservation only after create fails and exact status remains absent", async () => {
    const { env, workflowCreate } = fixture(5);
    workflowCreate.mockRejectedValue(new Error("create unavailable"));

    await expect(reconcilePromptAttemptDispatches(env, NOW)).resolves.toBe(1);

    expect(mocks.failWorkflowDispatch).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(workflowCreate).toHaveBeenCalledOnce();
    expect(mocks.status).toHaveBeenCalledTimes(2);
  });

  it("settles a terminal Workflow observed after a lost create acknowledgement", async () => {
    const { env, workflowCreate } = fixture();
    mocks.status.mockResolvedValue({ found: true, status: "errored" });

    await expect(reconcilePromptAttemptDispatches(env, NOW)).resolves.toBe(1);

    expect(mocks.markWorkflowDispatched).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(mocks.failWorkflowExecution).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(workflowCreate).not.toHaveBeenCalled();
  });

  it("never releases when create succeeds but marking delivery remains unavailable", async () => {
    const { database, env, workflowCreate } = fixture(5);
    workflowCreate.mockResolvedValue({ id: ATTEMPT_ID });
    mocks.status.mockResolvedValueOnce({ found: false });
    mocks.markWorkflowDispatched.mockRejectedValue(new Error("D1 unavailable"));

    await expect(reconcilePromptAttemptDispatches(env, NOW)).resolves.toBe(1);

    expect(mocks.failWorkflowDispatch).not.toHaveBeenCalled();
    expect(workflowCreate).toHaveBeenCalledOnce();
    expect(mocks.status).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT state, attempts FROM prompt_attempt_dispatches").get()).toEqual({
      state: "pending",
      attempts: 6,
    });
  });

  it("marks delivery when create throws but the deterministic Workflow is found", async () => {
    const { env, workflowCreate } = fixture(5);
    workflowCreate.mockRejectedValue(new Error("create acknowledgement lost"));
    mocks.status
      .mockResolvedValueOnce({ found: false })
      .mockResolvedValueOnce({ found: true, status: "running" });

    await expect(reconcilePromptAttemptDispatches(env, NOW)).resolves.toBe(1);

    expect(mocks.markWorkflowDispatched).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(mocks.failWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("durably increments retry state when creation and reconciliation both fail", async () => {
    const { database, env, workflowCreate } = fixture();
    workflowCreate.mockRejectedValue(new Error("create unavailable"));

    await expect(reconcilePromptAttemptDispatches(env, NOW)).resolves.toBe(1);

    expect(database.prepare(`SELECT state, attempts, last_error, updated_at
      FROM prompt_attempt_dispatches WHERE prompt_attempt_id=?`).get(ATTEMPT_ID)).toEqual({
      state: "pending",
      attempts: 1,
      last_error: "Error",
      updated_at: NOW.toISOString(),
    });
  });

  it.each(["running", "queued"])("does not settle stale work while Workflow status is %s", async (status) => {
    const { database, env } = fixture();
    database.prepare("UPDATE prompt_attempt_dispatches SET state='delivered' WHERE prompt_attempt_id=?")
      .run(ATTEMPT_ID);
    mocks.status.mockResolvedValue({ found: true, status });

    await expect(reconcilePromptAttemptDispatches(env, NOW)).resolves.toBe(0);

    expect(mocks.failWorkflowExecution).not.toHaveBeenCalled();
    expect(mocks.failWorkflowDispatch).not.toHaveBeenCalled();
  });

  it.each([
    { found: true, status: "errored" },
    { found: true, status: "terminated" },
    { found: true, status: "complete" },
    { found: false },
  ])("terminally reconciles stale delivered work for $status", async (lookup) => {
    const { database, env } = fixture();
    database.prepare("UPDATE prompt_attempt_dispatches SET state='delivered' WHERE prompt_attempt_id=?")
      .run(ATTEMPT_ID);
    mocks.status.mockResolvedValue(lookup);

    await expect(reconcilePromptAttemptDispatches(env, NOW)).resolves.toBe(1);

    expect(mocks.failWorkflowExecution).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(mocks.failWorkflowDispatch).not.toHaveBeenCalled();
  });
});
