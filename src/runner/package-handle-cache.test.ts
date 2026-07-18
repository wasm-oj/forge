import type { Command, Wasmer } from "@wasmer/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  PackageHandleCache,
  WasmerPackageHandle,
  withHandleLease,
  withWasmerCommand,
} from "./package-handle-cache";

interface TrackedHandle {
  free(): void;
}

describe("PackageHandleCache", () => {
  it("defers retired handle release until every lease is idle", async () => {
    const cache = new PackageHandleCache<string, TrackedHandle>();
    const first = { free: vi.fn() };
    const second = { free: vi.fn() };
    const firstLoad = vi.fn(async () => first);
    const secondLoad = vi.fn(async () => second);
    const firstLease = await cache.acquire("python", firstLoad);
    const sharedLease = await cache.acquire("python", firstLoad);

    const retirement = cache.retireAll();
    expect(first.free).not.toHaveBeenCalled();

    const replacementLease = await cache.acquire("python", secondLoad);
    expect(firstLoad).toHaveBeenCalledOnce();
    expect(secondLoad).toHaveBeenCalledOnce();
    firstLease.release();
    expect(first.free).not.toHaveBeenCalled();
    sharedLease.release();
    await retirement.wait();
    expect(first.free).toHaveBeenCalledOnce();
    expect(second.free).not.toHaveBeenCalled();

    replacementLease.release();
    await cache.retireAll().wait();
    expect(second.free).toHaveBeenCalledOnce();
  });

  it("evicts a rejected load without manufacturing a handle to release", async () => {
    const cache = new PackageHandleCache<string, TrackedHandle>();
    const failure = new Error("load failed");
    await expect(cache.acquire("python", async () => { throw failure; })).rejects.toBe(failure);

    const replacement = { free: vi.fn() };
    const lease = await cache.acquire("python", async () => replacement);
    lease.release();
    await cache.retireAll().wait();
    expect(replacement.free).toHaveBeenCalledOnce();
  });

  it("retires a pending load but waits for its eventual lease release", async () => {
    const cache = new PackageHandleCache<string, TrackedHandle>();
    const handle = { free: vi.fn() };
    let finishLoad!: (value: TrackedHandle) => void;
    const acquisition = cache.acquire("python", () => new Promise((resolve) => {
      finishLoad = resolve;
    }));
    await Promise.resolve();
    const retirement = cache.retireAll();

    finishLoad(handle);
    const lease = await acquisition;
    expect(handle.free).not.toHaveBeenCalled();
    lease.release();
    await retirement.wait();
    expect(handle.free).toHaveBeenCalledOnce();
  });

  it("rejects double lease release", async () => {
    const cache = new PackageHandleCache<string, TrackedHandle>();
    const handle = { free: vi.fn() };
    const lease = await cache.acquire("python", async () => handle);
    lease.release();
    expect(() => lease.release()).toThrow("more than once");
    await cache.retireAll().wait();
    expect(handle.free).toHaveBeenCalledOnce();
  });

  it("surfaces synchronous and deferred handle-release failures", async () => {
    const synchronousFailure = new Error("synchronous free failed");
    const synchronousCache = new PackageHandleCache<string, TrackedHandle>();
    const synchronousLease = await synchronousCache.acquire("python", async () => ({
      free() { throw synchronousFailure; },
    }));
    synchronousLease.release();
    expect(() => synchronousCache.retireAll()).toThrow(expect.objectContaining({
      errors: [synchronousFailure],
    }));

    const deferredFailure = new Error("deferred free failed");
    const deferredCache = new PackageHandleCache<string, TrackedHandle>();
    const deferredLease = await deferredCache.acquire("python", async () => ({
      free() { throw deferredFailure; },
    }));
    const retirement = deferredCache.retireAll();
    expect(() => deferredLease.release()).toThrow(deferredFailure);
    await expect(retirement.wait()).rejects.toBe(deferredFailure);
  });
});

describe("withWasmerCommand", () => {
  it("keeps package-owned command wrappers alive through use and frees each unique wrapper once", async () => {
    const selected = command();
    const dependency = command();
    const packageFree = vi.fn();
    const pkg = wasmerPackage(
      {
        python: selected.value,
        dependency: dependency.value,
        dependencyAlias: dependency.value,
      },
      packageFree,
    );
    let finish!: (value: Uint8Array) => void;
    const operation = withWasmerCommand(pkg, "python", () => new Promise<Uint8Array>((resolve) => {
      finish = resolve;
    }));

    expect(selected.free).not.toHaveBeenCalled();
    expect(dependency.free).not.toHaveBeenCalled();
    const binary = new Uint8Array([0, 97, 115, 109]);
    finish(binary);
    await expect(operation).resolves.toBe(binary);
    expect(selected.free).not.toHaveBeenCalled();
    expect(dependency.free).not.toHaveBeenCalled();

    pkg.free();
    expect(selected.free).toHaveBeenCalledOnce();
    expect(dependency.free).toHaveBeenCalledOnce();
    expect(packageFree).toHaveBeenCalledOnce();
  });

  it("does not release package-owned wrappers when the requested command is absent", async () => {
    const dependency = command();
    const pkg = wasmerPackage({ dependency: dependency.value });

    await expect(withWasmerCommand(pkg, "python", () => undefined)).rejects.toThrow(
      "does not expose the 'python' command",
    );
    expect(dependency.free).not.toHaveBeenCalled();
    pkg.free();
    expect(dependency.free).toHaveBeenCalledOnce();
  });

  it("preserves command failures independently from later package cleanup", async () => {
    const operationFailure = new Error("command failed");
    const selected = command();
    const pkg = wasmerPackage({ python: selected.value });

    await expect(withWasmerCommand(pkg, "python", async () => {
      throw operationFailure;
    })).rejects.toBe(operationFailure);
    expect(selected.free).not.toHaveBeenCalled();
    pkg.free();
    expect(selected.free).toHaveBeenCalledOnce();
  });

  it("attempts all package-owned cleanup and aggregates its errors", () => {
    const commandFailure = new Error("command free failed");
    const packageFailure = new Error("package free failed");
    const pkg = wasmerPackage(
      { python: { free() { throw commandFailure; } } as unknown as Command },
      () => { throw packageFailure; },
    );

    expect(() => pkg.free()).toThrow(expect.objectContaining({
      errors: [commandFailure, packageFailure],
    }));
  });
});

describe("withHandleLease", () => {
  it("preserves the primary operation failure when lease cleanup also fails", async () => {
    const operationFailure = new Error("operation failed");
    const cleanupFailure = new Error("lease release failed");
    const caught = await withHandleLease(
      {
        value: "package",
        release() { throw cleanupFailure; },
      },
      async () => { throw operationFailure; },
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([operationFailure, cleanupFailure]);
  });
});

function command(): { value: Command; free: ReturnType<typeof vi.fn> } {
  const free = vi.fn();
  return {
    value: { free } as unknown as Command,
    free,
  };
}

function wasmerPackage(
  commands: Record<string, Command>,
  free: () => void = vi.fn(),
): WasmerPackageHandle {
  return new WasmerPackageHandle({ commands, free } as unknown as Wasmer);
}
