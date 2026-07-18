import { describe, expect, it } from "vitest";
import { sha256Hex } from "../core/hash.ts";
import { ForgeDependencyManager, MemoryDependencyCache } from "./manager.ts";
import type { ForgeDependencyResolver } from "./types.ts";

describe("ForgeDependencyManager", () => {
  it("resolves, locks, exports, and imports one content-addressed graph", async () => {
    const payload = new TextEncoder().encode("serde archive");
    const digest = await sha256Hex(payload);
    const resolver: ForgeDependencyResolver = {
      ecosystem: "cargo",
      async resolve(_manifest, context) {
        expect(context.previousLock).toBeUndefined();
        return {
          roots: ["cargo:serde@1.0.228"],
          packages: [{
            id: "cargo:serde@1.0.228",
            ecosystem: "cargo",
            name: "serde",
            version: "1.0.228",
            source: "registry+https://github.com/rust-lang/crates.io-index",
            integritySha256: digest,
            dependencies: [],
          }],
          payloads: { "cargo:serde@1.0.228": payload },
        };
      },
    };
    const manager = new ForgeDependencyManager(new MemoryDependencyCache(), [resolver]);
    const manifest = {
      requirements: [{ ecosystem: "cargo" as const, name: "serde", requirement: "=1.0.228" }],
      sourceFiles: [{
        ecosystem: "cargo" as const,
        role: "lockfile" as const,
        path: "Cargo.lock",
        contents: "# generated\n",
      }],
    };
    const lock = await manager.resolve(manifest);
    expect(await manager.resolve(manifest, { offline: true, previousLock: lock })).toEqual(lock);
    const bundle = await manager.exportOffline(lock);
    const offline = new ForgeDependencyManager(new MemoryDependencyCache());
    const imported = await offline.importOffline(bundle);
    expect(imported).toEqual(lock);
    expect(await offline.resolve(manifest, { offline: true, previousLock: imported })).toEqual(lock);
  });

  it("fails closed before storing a corrupt resolver payload", async () => {
    const resolver: ForgeDependencyResolver = {
      ecosystem: "npm",
      async resolve() {
        return {
          roots: ["npm:answer@1.0.0"],
          packages: [{
            id: "npm:answer@1.0.0",
            ecosystem: "npm",
            name: "answer",
            version: "1.0.0",
            source: "https://registry.npmjs.org/answer/-/answer-1.0.0.tgz",
            integritySha256: "0".repeat(64),
            dependencies: [],
          }],
          payloads: { "npm:answer@1.0.0": new Uint8Array([42]) },
        };
      },
    };
    const manager = new ForgeDependencyManager(new MemoryDependencyCache(), [resolver]);
    await expect(manager.resolve({ requirements: [{ ecosystem: "npm", name: "answer", requirement: "1.0.0" }] }))
      .rejects.toThrow("corrupt payload");
  });

  it("never invokes a resolver for offline resolution and binds locks to the canonical manifest", async () => {
    const resolver: ForgeDependencyResolver = { ecosystem: "npm", resolve: async () => { throw new Error("network used"); } };
    const manager = new ForgeDependencyManager(new MemoryDependencyCache(), [resolver]);
    await expect(manager.resolve({
      requirements: [{ ecosystem: "npm", name: "@scope/package", requirement: "1.0.0" }],
    }, { offline: true })).rejects.toThrow("requires a previous lock");
  });
});
