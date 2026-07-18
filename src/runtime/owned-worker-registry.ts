export interface WorkerConstructorHost {
  Worker: typeof Worker;
}

/**
 * Gives an owning Worker explicit control over nested Workers created by a
 * dependency that does not expose its own shutdown contract.
 */
export class OwnedWorkerRegistry {
  private readonly host: WorkerConstructorHost;
  private readonly originalWorker: typeof Worker;
  private readonly originalDescriptor: PropertyDescriptor | undefined;
  private readonly trackedWorker: typeof Worker;
  private readonly workers = new Set<Worker>();
  private installed = false;

  constructor(host: WorkerConstructorHost) {
    this.host = host;
    this.originalWorker = host.Worker;
    this.originalDescriptor = Object.getOwnPropertyDescriptor(host, "Worker");
    const workers = this.workers;
    this.trackedWorker = new Proxy(this.originalWorker, {
      construct(target, argumentsList, newTarget) {
        const worker = Reflect.construct(target, argumentsList, newTarget) as Worker;
        workers.add(worker);
        return worker;
      },
    });
  }

  install(): void {
    if (this.installed) throw new Error("Nested Worker ownership is already installed.");
    if (this.host.Worker !== this.originalWorker) {
      throw new Error("The Worker constructor changed before nested Worker ownership was installed.");
    }
    Object.defineProperty(this.host, "Worker", {
      configurable: true,
      enumerable: this.originalDescriptor?.enumerable ?? false,
      writable: true,
      value: this.trackedWorker,
    });
    if (this.host.Worker !== this.trackedWorker) {
      throw new Error("Unable to install nested Worker ownership.");
    }
    this.installed = true;
  }

  /** Restore the host constructor and synchronously terminate every child. */
  terminateAll(): void {
    if (!this.installed) {
      if (this.workers.size > 0) {
        throw new Error("Nested Workers exist without an installed owner.");
      }
      return;
    }
    if (this.host.Worker !== this.trackedWorker) {
      throw new Error("The Worker constructor changed while nested Worker ownership was active.");
    }

    if (this.originalDescriptor) {
      Object.defineProperty(this.host, "Worker", this.originalDescriptor);
    } else if (!Reflect.deleteProperty(this.host, "Worker")) {
      throw new Error("Unable to restore the inherited Worker constructor.");
    }
    if (this.host.Worker !== this.originalWorker) {
      throw new Error("The original Worker constructor was not restored.");
    }
    this.installed = false;

    const owned = [...this.workers];
    this.workers.clear();
    for (const worker of owned) worker.terminate();
  }

  get size(): number {
    return this.workers.size;
  }
}
