import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";

const ATTEMPT_ID = "50000000-0000-4000-8000-000000000001";
const mocks = vi.hoisted(() => ({
  runReserved: vi.fn(),
  failWorkflowExecution: vi.fn(),
  markWorkflowDispatched: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("./prompt-attempts", () => ({
  PromptAttemptService: class {
    runReserved = mocks.runReserved;
    failWorkflowExecution = mocks.failWorkflowExecution;
    markWorkflowDispatched = mocks.markWorkflowDispatched;
  },
}));
vi.mock("./prompt-compiler-registry", () => ({ hostPromptCompilerRegistry: vi.fn(() => ({})) }));
vi.mock("./submissions", () => ({ createPromptAttemptHost: vi.fn(() => ({})) }));

import { parsePromptAttemptWorkflowParameters } from "./prompt-workflow-identity";
import { PromptAttemptWorkflow } from "./prompt-workflows";

describe("Prompt attempt Workflow identity", () => {
  beforeEach(() => {
    mocks.runReserved.mockReset().mockResolvedValue({
      attemptId: ATTEMPT_ID,
      prompt: "private prompt",
      state: "submitted",
    });
    mocks.failWorkflowExecution.mockReset().mockResolvedValue({
      attemptId: ATTEMPT_ID,
      prompt: "private prompt",
      state: "failed",
    });
    mocks.markWorkflowDispatched.mockReset().mockResolvedValue(undefined);
  });

  it("accepts only opaque attemptId and rejects embedded prompt or identity data", () => {
    expect(parsePromptAttemptWorkflowParameters({ attemptId: ATTEMPT_ID })).toEqual({ attemptId: ATTEMPT_ID });
    expect(() => parsePromptAttemptWorkflowParameters({ attemptId: ATTEMPT_ID, prompt: "secret" }))
      .toThrow("invalid shape");
  });

  it("resumes the durable reservation instead of recreating admission", async () => {
    let persistedStepOutput: unknown;
    const doStep = vi.fn(async (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
      persistedStepOutput = await callback();
      return persistedStepOutput;
    });
    const workflow = Object.assign(Object.create(PromptAttemptWorkflow.prototype), {
      env: { DB: {} } as WasmOjWorkerEnv,
    }) as PromptAttemptWorkflow;

    const result = await workflow.run(
      { payload: { attemptId: ATTEMPT_ID } } as never,
      { do: doStep } as never,
    );

    expect(result).toEqual({ attemptId: ATTEMPT_ID });
    expect(persistedStepOutput).toEqual({ attemptId: ATTEMPT_ID });
    expect(JSON.stringify({ result, persistedStepOutput })).not.toContain("private prompt");
    expect(mocks.runReserved).toHaveBeenCalledOnce();
    expect(mocks.runReserved).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(mocks.markWorkflowDispatched).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(doStep).toHaveBeenCalledWith(
      "compile prompt and admit locked source",
      expect.objectContaining({ retries: { limit: 0, delay: "1 second" } }),
      expect.any(Function),
    );
  });

  it("terminally settles a failed Workflow step instead of leaving quota polling forever", async () => {
    const workflow = Object.assign(Object.create(PromptAttemptWorkflow.prototype), {
      env: { DB: {} } as WasmOjWorkerEnv,
    }) as PromptAttemptWorkflow;
    const doStep = vi.fn(async () => { throw new Error("step failed"); });

    await expect(workflow.run(
      { payload: { attemptId: ATTEMPT_ID } } as never,
      { do: doStep } as never,
    )).resolves.toEqual({ attemptId: ATTEMPT_ID });
    expect(mocks.failWorkflowExecution).toHaveBeenCalledWith(ATTEMPT_ID);
  });
});
