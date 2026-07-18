import { describe, expect, it, vi } from "vitest";
import { ForgeError } from "../core/errors";
import type { JudgeProjectResult } from "../sdk/engine";
import {
  ForgeOperationScheduler,
  type ForgeOperationEvent,
  type ForgeOperationSchedulerHost,
  type ForgeSubmissionRequest,
} from "./operation";

const request = (id: string, signal?: AbortSignal): ForgeSubmissionRequest => ({
  id,
  input: { language: "c", entry: "main.c", files: { "main.c": "int main(){}" } },
  spec: { version: 1, cases: [] },
  ...(signal === undefined ? {} : { signal }),
});

const result = (): JudgeProjectResult => ({
  build: {
    success: false,
    diagnostics: [],
    stdout: "",
    stderr: "",
    cacheHit: false,
  },
});

describe("ForgeOperationScheduler", () => {
  it("runs submissions in FIFO order and correlates every observation", async () => {
    const first = deferred<JudgeProjectResult>();
    const second = deferred<JudgeProjectResult>();
    const started: string[] = [];
    const observations: ForgeOperationEvent[] = [];
    const host = {
      executeSubmission: vi.fn((submission: ForgeSubmissionRequest) => {
        started.push(submission.id!);
        return submission.id === "first" ? first.promise : second.promise;
      }),
      cancelActiveSubmission: vi.fn(),
    } satisfies ForgeOperationSchedulerHost;
    const scheduler = new ForgeOperationScheduler(host, (event) => observations.push(event));

    const firstOperation = scheduler.submit(request("first"));
    const secondOperation = scheduler.submit(request("second"));
    await until(() => started.length === 1);
    expect(started).toEqual(["first"]);
    expect(firstOperation.state()).toBe("running");
    expect(secondOperation.state()).toBe("queued");

    first.resolve(result());
    await expect(firstOperation.result).resolves.toEqual(result());
    await until(() => started.length === 2);
    second.resolve(result());
    await expect(secondOperation.result).resolves.toEqual(result());

    expect(started).toEqual(["first", "second"]);
    expect(observations.filter((event) => event.operationId === "first").map((event) => event.sequence))
      .toEqual([0, 1, 2]);
    expect(observations.filter((event) => event.operationId === "second").map((event) => event.sequence))
      .toEqual([0, 1, 2]);
    scheduler.dispose();
  });

  it("cancels a queued submission without touching the active host operation", async () => {
    const active = deferred<JudgeProjectResult>();
    const host = {
      executeSubmission: vi.fn(() => active.promise),
      cancelActiveSubmission: vi.fn(),
    } satisfies ForgeOperationSchedulerHost;
    const scheduler = new ForgeOperationScheduler(host);
    const first = scheduler.submit(request("active"));
    const queued = scheduler.submit(request("queued"));
    await until(() => first.state() === "running");

    queued.cancel("User cancelled the queued submission.");
    await expect(queued.result).rejects.toMatchObject({
      code: "operation-cancelled",
      operationId: "queued",
    });
    expect(host.cancelActiveSubmission).not.toHaveBeenCalled();

    active.resolve(result());
    await first.result;
    scheduler.dispose();
  });

  it("propagates AbortSignal cancellation to exactly the active host operation", async () => {
    const active = deferred<JudgeProjectResult>();
    const abort = new AbortController();
    const host = {
      executeSubmission: vi.fn(() => active.promise),
      cancelActiveSubmission: vi.fn(() => active.reject(new Error("host cancelled"))),
    } satisfies ForgeOperationSchedulerHost;
    const scheduler = new ForgeOperationScheduler(host);
    const operation = scheduler.submit(request("abortable", abort.signal));
    await until(() => operation.state() === "running");

    abort.abort("Client disconnected.");
    await expect(operation.result).rejects.toMatchObject({
      code: "operation-cancelled",
      message: "Client disconnected.",
    });
    expect(host.cancelActiveSubmission).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it("rejects duplicate operation identities with a structured conflict", () => {
    const host = {
      executeSubmission: vi.fn(async () => result()),
      cancelActiveSubmission: vi.fn(),
    } satisfies ForgeOperationSchedulerHost;
    const scheduler = new ForgeOperationScheduler(host);
    scheduler.submit(request("same"));

    expect(() => scheduler.submit(request("same"))).toThrow(ForgeError);
    expect(() => scheduler.submit(request("same"))).toThrow(expect.objectContaining({
      code: "operation-conflict",
    }));
    scheduler.dispose();
  });

  it("isolates observation listener failures from the submission result", async () => {
    const host = {
      executeSubmission: vi.fn(async (_request, observe) => {
        observe({ type: "progress", progress: { phase: "running", label: "guest" } });
        return result();
      }),
      cancelActiveSubmission: vi.fn(),
    } satisfies ForgeOperationSchedulerHost;
    const scheduler = new ForgeOperationScheduler(host);
    const operation = scheduler.submit(request("observed"));
    const throwing = vi.fn(() => { throw new Error("observer failure"); });
    operation.onEvent(throwing);

    await expect(operation.result).resolves.toEqual(result());
    expect(throwing).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it("starts a scoped observer with the operation's current state snapshot", async () => {
    const pending = deferred<JudgeProjectResult>();
    const scheduler = new ForgeOperationScheduler({
      executeSubmission: vi.fn(() => pending.promise),
      cancelActiveSubmission: vi.fn(),
    });
    const operation = scheduler.submit(request("snapshot"));
    const events: ForgeOperationEvent[] = [];
    operation.onEvent((event) => events.push(event));

    expect(events).toEqual([expect.objectContaining({
      operationId: "snapshot",
      sequence: 0,
      type: "state",
      state: "queued",
    })]);
    pending.resolve(result());
    await operation.result;
    scheduler.dispose();
  });

  it("scopes an existing infrastructure error to the submission identity", async () => {
    const scheduler = new ForgeOperationScheduler({
      executeSubmission: vi.fn(async () => {
        throw new ForgeError("Compiler failed.", {
          code: "compiler-failure",
          stage: "compile",
          retryable: true,
        });
      }),
      cancelActiveSubmission: vi.fn(),
    });
    const operation = scheduler.submit(request("failed-submission"));
    const events: ForgeOperationEvent[] = [];
    operation.onEvent((event) => events.push(event));

    await expect(operation.result).rejects.toMatchObject({
      code: "compiler-failure",
      stage: "compile",
      operationId: "failed-submission",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      operationId: "failed-submission",
      error: expect.objectContaining({ operationId: "failed-submission" }),
    }));
    scheduler.dispose();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached.");
}
