import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./http";
import type { WasmOjWorkerEnv } from "./env";

const ATTEMPT_ID = "50000000-0000-4000-8000-000000000001";
const CONTEST_ID = "10000000-0000-4000-8000-000000000001";
const PROBLEM_ID = "20000000-0000-4000-8000-000000000001";
const USER_ID = "30000000-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  failWorkflowDispatch: vi.fn(),
  lookupWorkflowInstance: vi.fn(),
  markWorkflowDispatched: vi.fn(),
  workflowCreate: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireBrowserOrBearerMutationSession: vi.fn(async () => ({ userId: USER_ID })),
  requireSession: vi.fn(async () => ({ userId: USER_ID })),
}));
vi.mock("./formal-access", () => ({ requireStagingFormalAccess: vi.fn(async () => undefined) }));
vi.mock("./formal-mutations", () => ({ requireFormalMutationsEnabled: vi.fn(async () => undefined) }));
vi.mock("./prompt-attempts", () => ({
  PromptAttemptService: class {
    reserve = mocks.reserve;
    failWorkflowDispatch = mocks.failWorkflowDispatch;
    markWorkflowDispatched = mocks.markWorkflowDispatched;
  },
}));
vi.mock("./prompt-compiler-registry", () => ({ hostPromptCompilerRegistry: vi.fn(() => ({})) }));
vi.mock("./submissions", () => ({ createPromptAttemptHost: vi.fn(() => ({})) }));
vi.mock("./workflow-instance-status", () => ({ lookupWorkflowInstance: mocks.lookupWorkflowInstance }));

import { createPromptAttempt } from "./prompt-api";

function body(prompt: string, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    contestId: CONTEST_ID,
    problemId: PROBLEM_ID,
    timelineGeneration: 1,
    rulesEpoch: 1,
    problemEpoch: 1,
    publicContextSha256: "a".repeat(64),
    prompt,
    idempotencyKey: "prompt-api-test-0001",
    ...overrides,
  };
}

function request(value: unknown): Request {
  return new Request("https://example.test/api/prompt-attempts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

function env(): WasmOjWorkerEnv {
  return {
    DB: {} as D1Database,
    PROMPT_ATTEMPT_WORKFLOW: { create: mocks.workflowCreate } as never,
  } as unknown as WasmOjWorkerEnv;
}

function reserved(created = true) {
  return {
    created,
    attempt: { attemptId: ATTEMPT_ID, state: "reserved" },
  };
}

describe("Prompt attempt POST admission", () => {
  beforeEach(() => {
    mocks.reserve.mockReset().mockResolvedValue(reserved());
    mocks.failWorkflowDispatch.mockReset().mockResolvedValue(undefined);
    mocks.lookupWorkflowInstance.mockReset().mockResolvedValue({ found: false });
    mocks.markWorkflowDispatched.mockReset().mockResolvedValue(undefined);
    mocks.workflowCreate.mockReset().mockResolvedValue({});
  });

  it.each([
    new ApiError(409, "contest-not-accepting-submissions", "paused"),
    new ApiError(409, "prompt-attempt-limit", "limit"),
  ])("rejects %s before creating a Workflow", async (failure) => {
    mocks.reserve.mockRejectedValueOnce(failure);

    await expect(createPromptAttempt(request(body("solve")), env())).rejects.toBe(failure);

    expect(mocks.workflowCreate).not.toHaveBeenCalled();
  });

  it("passes only opaque attemptId to Workflow and accepts worst-case escaped 16 KiB JSON", async () => {
    const prompt = "\u0001".repeat(16 * 1024);
    const response = await createPromptAttempt(request(body(prompt)), env());

    expect(response.status).toBe(202);
    expect(mocks.reserve).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: USER_ID,
      prompt,
      timelineGeneration: 1,
      rulesEpoch: 1,
      problemEpoch: 1,
    }), expect.any(String));
    expect(mocks.workflowCreate).toHaveBeenCalledWith({
      id: ATTEMPT_ID,
      params: { attemptId: ATTEMPT_ID },
    });
    expect(mocks.markWorkflowDispatched).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(JSON.stringify(mocks.workflowCreate.mock.calls[0]![0])).not.toContain(prompt);
    await expect(response.json()).resolves.toEqual({
      promptAttemptId: ATTEMPT_ID,
      state: "reserved",
      replayed: false,
      detailUrl: `https://example.test/api/prompt-attempts/${ATTEMPT_ID}`,
      eventsUrl: `https://example.test/api/prompt-attempts/${ATTEMPT_ID}/events`,
    });
  });

  it("leaves a queryable pending reservation when Workflow creation is explicitly absent", async () => {
    mocks.workflowCreate.mockRejectedValueOnce(new Error("binding unavailable"));

    const response = await createPromptAttempt(request(body("solve")), env());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      promptAttemptId: ATTEMPT_ID,
      state: "reserved",
    });
    expect(mocks.lookupWorkflowInstance).toHaveBeenCalledWith(expect.anything(), ATTEMPT_ID);
    expect(mocks.failWorkflowDispatch).not.toHaveBeenCalled();
    expect(mocks.markWorkflowDispatched).not.toHaveBeenCalled();
  });

  it("returns 202 pending when Workflow create succeeds but the D1 delivery mark fails", async () => {
    mocks.markWorkflowDispatched.mockRejectedValueOnce(new Error("D1 unavailable"));

    const response = await createPromptAttempt(request(body("solve")), env());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ promptAttemptId: ATTEMPT_ID, state: "reserved" });
    expect(mocks.workflowCreate).toHaveBeenCalledOnce();
    expect(mocks.failWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("reconciles a lost create acknowledgement when exact Workflow status exists", async () => {
    mocks.workflowCreate.mockRejectedValueOnce(new Error("create acknowledgement lost"));
    mocks.lookupWorkflowInstance.mockResolvedValueOnce({ found: true, status: "running" });

    const response = await createPromptAttempt(request(body("solve")), env());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ promptAttemptId: ATTEMPT_ID, state: "reserved" });
    expect(mocks.markWorkflowDispatched).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(mocks.failWorkflowDispatch).not.toHaveBeenCalled();
  });

  it("returns an idempotent replay without dispatching a second Workflow", async () => {
    mocks.reserve.mockResolvedValueOnce(reserved(false));

    const response = await createPromptAttempt(request(body("solve")), env());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      promptAttemptId: ATTEMPT_ID,
      replayed: true,
    });
    expect(mocks.workflowCreate).not.toHaveBeenCalled();
  });
});
