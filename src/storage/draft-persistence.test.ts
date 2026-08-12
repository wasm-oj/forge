import { describe, expect, it, vi } from "vitest";
import type { Project } from "../core/types";
import { DraftPersistenceController } from "./draft-persistence";

function project(updatedAt: number, content = `revision ${updatedAt}`): Project {
  return {
    id: "draft",
    name: "Draft",
    files: [{ path: "main.c", language: "c", content }],
    activeFile: "main.c",
    config: {
      language: "c",
      target: "wasip1",
      entry: "main.c",
      optimization: "debug",
      args: [],
      stdin: "",
      env: {},
      determinism: { randomSeed: 1, realtimeEpochMs: 0, clockStepNs: 1 },
      resources: {
        instructionBudget: 1,
        logicalTimeLimitMs: 1,
        memoryLimitBytes: 65_536,
        outputLimitBytes: 1,
        filesystemWriteLimitBytes: 1,
        filesystemEntryLimit: 1,
        wallTimeLimitMs: 1,
      },
    },
    updatedAt,
  };
}

describe("DraftPersistenceController", () => {
  it("preserves the browser receiver when using global timer functions", () => {
    const timer = { id: "draft-debounce" } as unknown as ReturnType<typeof setTimeout>;
    let scheduled = 0;
    let cleared = 0;

    vi.stubGlobal("setTimeout", function browserSetTimeout(this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      scheduled += 1;
      return timer;
    });
    vi.stubGlobal("clearTimeout", function browserClearTimeout(this: unknown, value: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      expect(value).toBe(timer);
      cleared += 1;
    });

    try {
      const controller = new DraftPersistenceController(async () => undefined);
      controller.update(project(2));
      controller.update(project(3));

      expect(scheduled).toBe(2);
      expect(cleared).toBe(1);
      expect(controller.snapshot()).toMatchObject({ phase: "dirty", revision: 2, persistedRevision: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("debounces edits and persists an immutable snapshot", async () => {
    vi.useFakeTimers();
    try {
      const persist = vi.fn(async () => undefined);
      const controller = new DraftPersistenceController(persist);
      const draft = project(2);

      controller.update(draft);
      draft.files[0].content = "mutated after update";
      expect(controller.snapshot()).toMatchObject({ phase: "dirty", revision: 1, persistedRevision: 0 });
      await vi.advanceTimersByTimeAsync(349);
      expect(persist).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(persist).toHaveBeenCalledWith(expect.objectContaining({
        files: [expect.objectContaining({ path: "main.c", content: "revision 2" })],
      }));
      expect(controller.snapshot()).toMatchObject({ phase: "saved", revision: 1, persistedRevision: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes writes and drains the newest edit before flush resolves", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const persist = vi.fn()
      .mockImplementationOnce(async () => await firstWrite)
      .mockResolvedValueOnce(undefined);
    const controller = new DraftPersistenceController(persist, { debounceMs: 60_000 });

    controller.update(project(2));
    const flushing = controller.flush();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    controller.update(project(3));
    expect(controller.snapshot()).toMatchObject({ phase: "saving", revision: 2, persistedRevision: 0 });
    releaseFirst?.();
    await flushing;

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1][0]).toMatchObject({ updatedAt: 3 });
    expect(controller.snapshot()).toMatchObject({ phase: "saved", revision: 2, persistedRevision: 2 });
  });

  it("keeps the newest draft pending after failure and exposes retry state", async () => {
    const failure = new DOMException("browser quota exhausted", "QuotaExceededError");
    const persist = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const controller = new DraftPersistenceController(persist, { debounceMs: 60_000 });
    const observed: string[] = [];
    controller.subscribe((state) => observed.push(state.phase));

    controller.update(project(2));
    await expect(controller.flush()).rejects.toBe(failure);
    expect(controller.hasPendingDraft()).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      phase: "error",
      revision: 1,
      persistedRevision: 0,
      error: "browser quota exhausted",
    });

    controller.update(project(3, "latest survives"));
    await expect(controller.retry()).resolves.toBeUndefined();
    expect(persist.mock.calls[1][0]).toMatchObject({
      updatedAt: 3,
      files: [{ path: "main.c", content: "latest survives" }],
    });
    expect(controller.hasPendingDraft()).toBe(false);
    expect(observed).toContain("error");
  });

  it("flushes immediately instead of waiting for the debounce deadline", async () => {
    vi.useFakeTimers();
    try {
      const persist = vi.fn(async () => undefined);
      const controller = new DraftPersistenceController(persist);
      controller.update(project(2));

      await controller.flush();
      expect(persist).toHaveBeenCalledOnce();
      await vi.runAllTimersAsync();
      expect(persist).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("imports a validated source backup as a pending revision and persists it", async () => {
    const persist = vi.fn(async () => undefined);
    const controller = new DraftPersistenceController(persist, { debounceMs: 60_000 });
    const backup = controller.exportSources(project(2, "recovered source"));
    const restored = controller.importSources(backup, project(3, "current source"), 4);

    expect(restored).toMatchObject({
      updatedAt: 4,
      files: [{ path: "main.c", content: "recovered source" }],
    });
    expect(controller.snapshot()).toMatchObject({ phase: "dirty", revision: 1, persistedRevision: 0 });
    await controller.flush();
    expect(persist).toHaveBeenCalledWith(restored);
    expect(controller.snapshot()).toMatchObject({ phase: "saved", revision: 1, persistedRevision: 1 });
  });
});
