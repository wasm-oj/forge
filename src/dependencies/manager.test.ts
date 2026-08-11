import { describe, expect, it } from "vitest";
import { sha256Hex } from "../core/hash.ts";
import { dependencyManifestSha256 } from "./lock.ts";
import { DEPENDENCY_RESOLUTION_LIMITS } from "./limits.ts";
import { ForgeDependencyManager, MemoryDependencyCache } from "./manager.ts";
import { DependencyNetworkError, NpmLockDependencyResolver } from "./resolvers.ts";
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
    expect([...await manager.materialize(lock)]).toEqual([["cargo:serde@1.0.228", payload]]);
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

  it("falls back only for a transport failure with a matching manifest and network scope", async () => {
    const payload = new TextEncoder().encode("cached archive");
    const digest = await sha256Hex(payload);
    const cache = new MemoryDependencyCache();
    const manifest = {
      requirements: [{ ecosystem: "npm" as const, name: "answer", requirement: "1.0.0" }],
    };
    const packageRecord = {
      id: "npm:answer@1.0.0",
      ecosystem: "npm" as const,
      name: "answer",
      version: "1.0.0",
      source: "https://registry.npmjs.org/answer/-/answer-1.0.0.tgz",
      integritySha256: digest,
      dependencies: [],
    };
    const priming = new ForgeDependencyManager(cache, [{
      ecosystem: "npm",
      resolve: async () => ({
        roots: [packageRecord.id],
        packages: [packageRecord],
        payloads: { [packageRecord.id]: payload },
      }),
    }]);
    const previousLock = await priming.resolve(manifest);
    const networkAccess = {
      sourceKey: "github:wasm-oj/fixture@main:collection/index.json",
      bundleDigest: "a".repeat(64),
      hosts: ["registry.npmjs.org"],
    };
    const transportFailure = new ForgeDependencyManager(cache, [{
      ecosystem: "npm",
      resolve: async () => { throw new DependencyNetworkError("registry.npmjs.org"); },
    }]);

    await expect(transportFailure.resolve(manifest, {
      previousLock,
      previousLockNetworkScope: networkAccess,
      networkAccess,
    })).resolves.toEqual(previousLock);
    await expect(transportFailure.resolve(manifest, {
      previousLock,
      previousLockNetworkScope: { ...networkAccess, sourceKey: "github:other/fork@main:collection/index.json" },
      networkAccess,
    })).rejects.toBeInstanceOf(DependencyNetworkError);
    await expect(transportFailure.resolve({
      requirements: [{ ecosystem: "npm", name: "answer", requirement: "2.0.0" }],
    }, {
      previousLock,
      previousLockNetworkScope: networkAccess,
      networkAccess,
    })).rejects.toBeInstanceOf(DependencyNetworkError);

    for (const failure of ["HTTP 503", "malformed registry metadata", "integrity mismatch"]) {
      const protocolFailure = new ForgeDependencyManager(cache, [{
        ecosystem: "npm",
        resolve: async () => { throw new Error(failure); },
      }]);
      await expect(protocolFailure.resolve(manifest, {
        previousLock,
        previousLockNetworkScope: networkAccess,
        networkAccess,
      })).rejects.toThrow(failure);
    }

    const emptyCacheFailure = new ForgeDependencyManager(new MemoryDependencyCache(), [{
      ecosystem: "npm",
      resolve: async () => { throw new DependencyNetworkError("registry.npmjs.org"); },
    }]);
    await expect(emptyCacheFailure.resolve(manifest, {
      previousLock,
      previousLockNetworkScope: networkAccess,
      networkAccess,
    })).rejects.toThrow("absent from the content cache");
  });

  it("never reuses a verified lock when the dependency endpoint redirects", async () => {
    const payload = new TextEncoder().encode("cached archive");
    const digest = await sha256Hex(payload);
    const resolved = "https://registry.npmjs.org/answer/-/answer-1.0.0.tgz";
    const manifest = {
      requirements: [{ ecosystem: "npm" as const, name: "answer", requirement: "1.0.0" }],
      sourceFiles: [{
        ecosystem: "npm" as const,
        role: "lockfile" as const,
        path: "package-lock.json",
        contents: JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { answer: "1.0.0" } },
            "node_modules/answer": {
              name: "answer",
              version: "1.0.0",
              resolved,
              integrity: "sha512-AA==",
            },
          },
        }),
      }],
    };
    const cache = new MemoryDependencyCache();
    const priming = new ForgeDependencyManager(cache, [{
      ecosystem: "npm",
      resolve: async () => ({
        roots: ["npm:answer@1.0.0"],
        packages: [{
          id: "npm:answer@1.0.0",
          ecosystem: "npm" as const,
          name: "answer",
          version: "1.0.0",
          source: resolved,
          integritySha256: digest,
          dependencies: [],
        }],
        payloads: { "npm:answer@1.0.0": payload },
      }),
    }]);
    const previousLock = await priming.resolve(manifest);
    const networkAccess = {
      sourceKey: "github:wasm-oj/fixture@main:collection/index.json",
      bundleDigest: "a".repeat(64),
      hosts: ["registry.npmjs.org"],
    };
    const fetcher = async () => new Response(null, {
      status: 302,
      headers: { location: "https://packages.example.com/answer-1.0.0.tgz" },
    });
    const manager = new ForgeDependencyManager(cache, [new NpmLockDependencyResolver({
      fetch: fetcher,
      networkAuthorizer: { authorize: async () => undefined },
    })]);

    const error = await manager.resolve(manifest, {
      previousLock,
      previousLockNetworkScope: networkAccess,
      networkAccess,
    }).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DependencyNetworkError);
    expect((error as Error).message).toContain("redirected unexpectedly");
  });

  it("rejects an oversized manifest before invoking a resolver", async () => {
    const resolver: ForgeDependencyResolver = {
      ecosystem: "npm",
      async resolve() { throw new Error("resolver must not run"); },
    };
    const manager = new ForgeDependencyManager(new MemoryDependencyCache(), [resolver]);
    const requirements = Array.from(
      { length: DEPENDENCY_RESOLUTION_LIMITS.requirements + 1 },
      (_, index) => ({ ecosystem: "npm" as const, name: `package-${index}`, requirement: "1.0.0" }),
    );
    await expect(manager.resolve({ requirements })).rejects.toThrow(
      `${DEPENDENCY_RESOLUTION_LIMITS.requirements}-item limit`,
    );
  });

  it("accepts the exact manifest-count boundary for canonical hashing", async () => {
    const requirements = Array.from(
      { length: DEPENDENCY_RESOLUTION_LIMITS.requirements },
      (_, index) => ({ ecosystem: "npm" as const, name: `package-${index}`, requirement: "1.0.0" }),
    );
    await expect(dependencyManifestSha256({ requirements })).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});
