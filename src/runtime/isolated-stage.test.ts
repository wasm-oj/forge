import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PersistentIsolatedStage,
  runIsolatedStage,
  type IsolatedStageResponse,
} from "./isolated-stage";

class FakeWorker<Result> extends EventTarget {
  terminateCount = 0;
  postError?: Error;
  postCount = 0;

  postMessage(): void {
    if (this.postError) throw this.postError;
    this.postCount += 1;
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  respond(response: IsolatedStageResponse<Result>): void {
    this.dispatchEvent(new MessageEvent("message", { data: response }));
  }

  crash(message: string): void {
    const event = new Event("error") as ErrorEvent;
    Object.defineProperty(event, "message", { value: message });
    this.dispatchEvent(event);
  }

  messageError(): void {
    this.dispatchEvent(new Event("messageerror"));
  }
}

afterEach(() => vi.useRealTimers());

describe("runIsolatedStage", () => {
  it("returns a result and terminates exactly once", async () => {
    const worker = new FakeWorker<number>();
    const pending = runIsolatedStage(worker as unknown as Worker, { type: "compile" }, 1_000, "test");
    worker.respond({ type: "result", result: 42 });
    await expect(pending).resolves.toBe(42);
    worker.crash("late crash");
    expect(worker.terminateCount).toBe(1);
  });

  it("preserves a structured stage error", async () => {
    const worker = new FakeWorker<number>();
    const pending = runIsolatedStage(worker as unknown as Worker, {}, 1_000, "test");
    worker.respond({ type: "error", message: "compile failed", stack: "guest stack" });
    await expect(pending).rejects.toMatchObject({ message: "compile failed", stack: "guest stack" });
    expect(worker.terminateCount).toBe(1);
  });

  it("cleans up a worker error", async () => {
    const worker = new FakeWorker<number>();
    const pending = runIsolatedStage(worker as unknown as Worker, {}, 1_000, "test");
    worker.crash("worker crashed");
    await expect(pending).rejects.toThrow("worker crashed");
    expect(worker.terminateCount).toBe(1);
  });

  it("rejects an invalid worker protocol response", async () => {
    const worker = new FakeWorker<number>();
    const pending = runIsolatedStage(worker as unknown as Worker, {}, 1_000, "test");
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "result" } }));
    await expect(pending).rejects.toThrow("invalid response");
    expect(worker.terminateCount).toBe(1);
  });

  it("cleans up an unreadable message", async () => {
    const worker = new FakeWorker<number>();
    const pending = runIsolatedStage(worker as unknown as Worker, {}, 1_000, "test");
    worker.messageError();
    await expect(pending).rejects.toThrow("unreadable response");
    expect(worker.terminateCount).toBe(1);
  });

  it("cleans up when postMessage throws synchronously", async () => {
    const worker = new FakeWorker<number>();
    worker.postError = new Error("clone failed");
    await expect(runIsolatedStage(worker as unknown as Worker, {}, 1_000, "test"))
      .rejects.toThrow("clone failed");
    expect(worker.terminateCount).toBe(1);
  });

  it("cleans up on timeout", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker<number>();
    const pending = runIsolatedStage(worker as unknown as Worker, {}, 1_000, "test");
    const rejection = expect(pending).rejects.toThrow("exceeded 1000 ms");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(worker.terminateCount).toBe(1);
  });
});

describe("PersistentIsolatedStage", () => {
  it("serially reuses one Worker without terminating between results", async () => {
    const worker = new FakeWorker<number>();
    const stage = new PersistentIsolatedStage<object, number>({
      createWorker: () => worker as unknown as Worker,
      timeoutMs: 1_000,
      stageLabel: "rustc",
    });

    const first = stage.run({ build: 1 });
    expect(() => stage.run({ build: 2 })).toThrow("one request at a time");
    worker.respond({ type: "result", result: 41 });
    await expect(first).resolves.toBe(41);

    const second = stage.run({ build: 2 });
    worker.respond({ type: "result", result: 42 });
    await expect(second).resolves.toBe(42);
    expect(worker.postCount).toBe(2);
    expect(worker.terminateCount).toBe(0);

    stage.dispose();
    expect(worker.terminateCount).toBe(1);
    expect(() => stage.run({ build: 3 })).toThrow("disposed");
  });

  it("keeps a responsive Worker after a structured toolchain error", async () => {
    const worker = new FakeWorker<number>();
    const stage = new PersistentIsolatedStage<object, number>({
      createWorker: () => worker as unknown as Worker,
      timeoutMs: 1_000,
      stageLabel: "rustc",
    });

    const failed = stage.run({ build: 1 });
    worker.respond({ type: "error", message: "source failed", stack: "guest stack" });
    await expect(failed).rejects.toMatchObject({ message: "source failed", stack: "guest stack" });

    const recovered = stage.run({ build: 2 });
    worker.respond({ type: "result", result: 42 });
    await expect(recovered).resolves.toBe(42);
    expect(worker.terminateCount).toBe(0);
    stage.dispose();
  });

  it("waits for an explicit shutdown acknowledgement before terminating", async () => {
    const worker = new FakeWorker<number>();
    const stage = new PersistentIsolatedStage<object, number>({
      createWorker: () => worker as unknown as Worker,
      timeoutMs: 1_000,
      stageLabel: "rustc",
    });

    const shutdown = stage.shutdown({ type: "shutdown" });
    expect(worker.postCount).toBe(1);
    expect(worker.terminateCount).toBe(0);
    expect(() => stage.run({ build: 1 })).toThrow("shutting down");
    worker.respond({ type: "shutdown-complete" });

    await expect(shutdown).resolves.toBeUndefined();
    expect(worker.terminateCount).toBe(1);
    expect(() => stage.run({ build: 2 })).toThrow("disposed");
  });

  it("fails closed when a shutdown acknowledgement is malformed", async () => {
    const worker = new FakeWorker<number>();
    const stage = new PersistentIsolatedStage<object, number>({
      createWorker: () => worker as unknown as Worker,
      timeoutMs: 1_000,
      stageLabel: "rustc",
    });

    const shutdown = stage.shutdown({ type: "shutdown" });
    worker.respond({ type: "result", result: 42 });

    await expect(shutdown).rejects.toThrow("invalid shutdown response");
    expect(worker.terminateCount).toBe(1);
  });

  it("fails closed and rejects the active request when the Worker crashes", async () => {
    const worker = new FakeWorker<number>();
    const stage = new PersistentIsolatedStage<object, number>({
      createWorker: () => worker as unknown as Worker,
      timeoutMs: 1_000,
      stageLabel: "rustc",
    });

    const pending = stage.run({ build: 1 });
    worker.crash("runtime crashed");
    await expect(pending).rejects.toThrow("runtime crashed");
    expect(worker.terminateCount).toBe(1);
    expect(() => stage.run({ build: 2 })).toThrow("runtime crashed");
  });

  it("terminates a timed-out Worker exactly once", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker<number>();
    const stage = new PersistentIsolatedStage<object, number>({
      createWorker: () => worker as unknown as Worker,
      timeoutMs: 1_000,
      stageLabel: "rustc",
    });

    const pending = stage.run({ build: 1 });
    const rejection = expect(pending).rejects.toThrow("exceeded 1000 ms");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(worker.terminateCount).toBe(1);
    stage.dispose();
    expect(worker.terminateCount).toBe(1);
  });
});
