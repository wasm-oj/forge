import { describe, expect, it, vi } from "vitest";
import { OwnedWorkerRegistry, type WorkerConstructorHost } from "./owned-worker-registry";

class FakeWorker {
  readonly url: string | URL;
  readonly options: WorkerOptions | undefined;
  readonly terminate = vi.fn();

  constructor(url: string | URL, options?: WorkerOptions) {
    this.url = url;
    this.options = options;
  }
}

function hostWithOwnConstructor(): WorkerConstructorHost {
  return { Worker: FakeWorker as unknown as typeof Worker };
}

describe("OwnedWorkerRegistry", () => {
  it("tracks dependency-created Workers and restores the exact constructor", () => {
    const host = hostWithOwnConstructor();
    const original = host.Worker;
    const registry = new OwnedWorkerRegistry(host);

    registry.install();
    const first = new host.Worker("first.js") as unknown as FakeWorker;
    const second = new host.Worker("second.js", { type: "module" }) as unknown as FakeWorker;

    expect(registry.size).toBe(2);
    expect(first.url).toBe("first.js");
    expect(second.options).toEqual({ type: "module" });

    registry.terminateAll();

    expect(host.Worker).toBe(original);
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(second.terminate).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });

  it("restores an inherited constructor without leaving an own property", () => {
    const prototype = { Worker: FakeWorker as unknown as typeof Worker };
    const host = Object.create(prototype) as WorkerConstructorHost;
    const registry = new OwnedWorkerRegistry(host);

    registry.install();
    expect(Object.hasOwn(host, "Worker")).toBe(true);
    registry.terminateAll();

    expect(Object.hasOwn(host, "Worker")).toBe(false);
    expect(host.Worker).toBe(prototype.Worker);
  });

  it("fails closed when another owner replaces the constructor", () => {
    const host = hostWithOwnConstructor();
    const registry = new OwnedWorkerRegistry(host);
    registry.install();
    host.Worker = class extends FakeWorker {} as unknown as typeof Worker;

    expect(() => registry.terminateAll()).toThrow(
      "The Worker constructor changed while nested Worker ownership was active.",
    );
  });
});
