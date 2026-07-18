import type { Command, Wasmer } from "@wasmer/sdk";

interface ReleasableHandle {
  free(): void;
}

interface HandleEntry<Handle extends ReleasableHandle> {
  readonly promise: Promise<Handle>;
  handle?: Handle;
  borrowers: number;
  retired: boolean;
  releaseState: "pending" | "released" | "failed";
  releaseError?: unknown;
  readonly releaseListeners: Set<() => void>;
}

export interface HandleLease<Handle> {
  readonly value: Handle;
  release(): void;
}

export interface HandleRetirement {
  wait(): Promise<void>;
}

export class WasmerPackageHandle implements ReleasableHandle {
  readonly commands: Record<string, Command>;
  private released = false;

  constructor(readonly wasmer: Wasmer) {
    this.commands = wasmer.commands;
  }

  free(): void {
    if (this.released) throw new Error("Wasmer package handle was released more than once.");
    this.released = true;
    const errors: unknown[] = [];
    for (const command of new Set(Object.values(this.commands))) {
      try {
        command.free();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.wasmer.free();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Unable to release a Wasmer package and its command handles.");
    }
  }
}

export class PackageHandleCache<Key, Handle extends ReleasableHandle> {
  private readonly entries = new Map<Key, HandleEntry<Handle>>();

  async acquire(key: Key, load: () => Promise<Handle>): Promise<HandleLease<Handle>> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.createEntry(key, load);
      this.entries.set(key, entry);
    }
    entry.borrowers += 1;

    let handle: Handle;
    try {
      handle = await entry.promise;
    } catch (error) {
      entry.borrowers -= 1;
      throw error;
    }

    let released = false;
    return {
      value: handle,
      release: () => {
        if (released) throw new Error("Package handle lease was released more than once.");
        released = true;
        entry.borrowers -= 1;
        if (entry.borrowers < 0) throw new Error("Package handle lease count became negative.");
        this.releaseRetiredEntry(entry);
      },
    };
  }

  retireAll(): HandleRetirement {
    const retired = [...this.entries.values()];
    this.entries.clear();
    const releaseErrors: unknown[] = [];
    for (const entry of retired) {
      entry.retired = true;
      try {
        this.releaseRetiredEntry(entry);
      } catch (error) {
        releaseErrors.push(error);
      }
    }
    if (releaseErrors.length > 0) {
      throw new AggregateError(releaseErrors, "Unable to release one or more retired package handles.");
    }
    // Completion is deliberately lazy: synchronous idle-release failures are
    // thrown above, while active leases surface deferred failures from release().
    // Explicit async clear operations may additionally wait for all borrowers.
    return {
      wait: () => Promise.all(retired.map((entry) => waitForRelease(entry))).then(() => undefined),
    };
  }

  private createEntry(key: Key, load: () => Promise<Handle>): HandleEntry<Handle> {
    const reference: { current?: HandleEntry<Handle> } = {};
    const promise = Promise.resolve().then(load).then(
      (handle) => {
        const entry = reference.current;
        if (!entry) throw new Error("Package handle cache entry was not initialized.");
        entry.handle = handle;
        return handle;
      },
      (error: unknown) => {
        const entry = reference.current;
        if (!entry) throw new Error("Package handle cache entry was not initialized.");
        if (this.entries.get(key) === entry) this.entries.delete(key);
        entry.releaseState = "released";
        notifyReleaseListeners(entry);
        throw error;
      },
    );
    const entry: HandleEntry<Handle> = {
      promise,
      borrowers: 0,
      retired: false,
      releaseState: "pending",
      releaseListeners: new Set<() => void>(),
    };
    reference.current = entry;
    return entry;
  }

  private releaseRetiredEntry(entry: HandleEntry<Handle>): void {
    if (!entry.retired || entry.borrowers !== 0 || !entry.handle || entry.releaseState !== "pending") return;
    try {
      entry.handle.free();
      entry.releaseState = "released";
    } catch (error) {
      entry.releaseState = "failed";
      entry.releaseError = error;
      throw error;
    } finally {
      notifyReleaseListeners(entry);
    }
  }
}

export async function withWasmerCommand<Result>(
  pkg: WasmerPackageHandle,
  commandName: string,
  operation: (command: Command) => Result | Promise<Result>,
): Promise<Result> {
  const selected = pkg.commands[commandName];
  if (!selected) throw new Error(`Package does not expose the '${commandName}' command.`);
  return operation(selected);
}

export function withHandleLease<Handle, Result>(
  lease: HandleLease<Handle>,
  operation: (handle: Handle) => Result | Promise<Result>,
): Promise<Result> {
  return withCleanup(
    () => operation(lease.value),
    () => lease.release(),
    "Package operation and package-handle cleanup both failed.",
  );
}

function waitForRelease<Handle extends ReleasableHandle>(entry: HandleEntry<Handle>): Promise<void> {
  if (entry.releaseState === "released") return Promise.resolve();
  if (entry.releaseState === "failed") return Promise.reject(entry.releaseError);
  return new Promise((resolve, reject) => {
    const listener = () => {
      entry.releaseListeners.delete(listener);
      if (entry.releaseState === "released") resolve();
      else reject(entry.releaseError);
    };
    entry.releaseListeners.add(listener);
  });
}

function notifyReleaseListeners<Handle extends ReleasableHandle>(entry: HandleEntry<Handle>): void {
  for (const listener of [...entry.releaseListeners]) listener();
}

async function withCleanup<Result>(
  operation: () => Result | Promise<Result>,
  cleanup: () => void,
  aggregateMessage: string,
): Promise<Result> {
  let result: Result | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    cleanup();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  if (operationFailed && cleanupFailed) {
    throw new AggregateError([operationError, cleanupError], aggregateMessage);
  }
  if (operationFailed) throw operationError;
  if (cleanupFailed) throw cleanupError;
  return result as Result;
}
