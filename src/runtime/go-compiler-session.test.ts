import { describe, expect, it } from "vitest";
import {
  BrowserGoCompilerSession,
  type RuntimeCoreCompileStage,
  type RuntimeCoreGoSessionBinding,
  type RuntimeCoreGoSessionEnvelope,
} from "./go-compiler-session";

const DIGEST = "a".repeat(64);

interface FakeResult {
  stages: [];
}

class FakeRuntimeCoreGoSession implements RuntimeCoreGoSessionBinding<FakeResult> {
  static instances: FakeRuntimeCoreGoSession[] = [];
  readonly digest: string;
  generation = 0;
  readonly hydration: ConstructorParameters<typeof FakeRuntimeCoreGoSession>[0];
  readonly requests: Parameters<RuntimeCoreGoSessionBinding<FakeResult>["compilePipeline"]>[0][] = [];
  freeCount = 0;

  constructor(config: {
    digest: string;
    toolchain: { package: Uint8Array; memoryLimitBytes: number };
    standardLibraryFiles: Record<string, Uint8Array>;
  }) {
    this.digest = config.digest;
    this.hydration = config;
    FakeRuntimeCoreGoSession.instances.push(this);
  }

  async compilePipeline(
    request: Parameters<RuntimeCoreGoSessionBinding<FakeResult>["compilePipeline"]>[0],
  ): Promise<RuntimeCoreGoSessionEnvelope<FakeResult>> {
    this.requests.push(request);
    this.generation = request.sourceDelta.generation;
    return {
      digest: this.digest,
      generation: this.generation,
      response: { ok: true, result: { stages: [] } },
    };
  }

  free(): void {
    this.freeCount += 1;
  }
}

const stage: RuntimeCoreCompileStage = {
  command: "go-compile",
  args: [],
  env: {},
  stdin: new Uint8Array(),
  files: {},
  cwd: "/work",
  outputPaths: ["/work/build/main.a"],
  outputLimitBytes: 1024,
};

function hydrate() {
  FakeRuntimeCoreGoSession.instances = [];
  const standardLibraryFiles = {
    "/go/VERSION": new TextEncoder().encode("go1.26.5\n"),
    "/go/pkg/fmt.a": new Uint8Array([1, 2, 3]),
  };
  const session = BrowserGoCompilerSession.hydrate(FakeRuntimeCoreGoSession, {
    digest: DIGEST,
    toolchain: { package: new Uint8Array([0, 97, 115, 109]), memoryLimitBytes: 65_536 },
    standardLibraryFiles,
  });
  return { session, binding: FakeRuntimeCoreGoSession.instances[0], standardLibraryFiles };
}

describe("BrowserGoCompilerSession", () => {
  it("hydrates immutable toolchain bytes once and never includes stdlib in compile requests", async () => {
    const { session, binding, standardLibraryFiles } = hydrate();
    const first = {
      "/work/main.go": new TextEncoder().encode("package main\nfunc main() {}\n"),
      "/work/importcfg": new TextEncoder().encode("packagefile fmt=/go/pkg/fmt.a\n"),
    };
    await session.compile(first, [stage]);
    await session.compile(first, [stage]);

    expect(FakeRuntimeCoreGoSession.instances).toHaveLength(1);
    expect(binding.hydration.standardLibraryFiles).toBe(standardLibraryFiles);
    expect(Object.keys(binding.requests[0].sourceDelta.upsertFiles).sort()).toEqual([
      "/work/importcfg",
      "/work/main.go",
    ]);
    expect(binding.requests[1].sourceDelta).toEqual({
      generation: 2,
      upsertFiles: {},
      removePaths: [],
    });
    expect(binding.requests.every((request) => !("standardLibraryFiles" in request))).toBe(true);
    expect(binding.requests
      .flatMap((request) => Object.keys(request.sourceDelta.upsertFiles))
      .every((path) => path.startsWith("/work/"))).toBe(true);
  });

  it("sends only changed and removed mutable files after the first snapshot", async () => {
    const { session, binding } = hydrate();
    await session.compile({
      "/work/main.go": new Uint8Array([1]),
      "/work/old.go": new Uint8Array([2]),
    }, [stage]);
    await session.compile({
      "/work/main.go": new Uint8Array([3]),
      "/work/new.go": new Uint8Array([4]),
    }, [stage]);

    expect(binding.requests[1].sourceDelta).toEqual({
      generation: 2,
      upsertFiles: {
        "/work/main.go": new Uint8Array([3]),
        "/work/new.go": new Uint8Array([4]),
      },
      removePaths: ["/work/old.go"],
    });
  });

  it("owns its source snapshot so caller-side byte mutation becomes a delta", async () => {
    const { session, binding } = hydrate();
    const source = new Uint8Array([1]);
    await session.compile({ "/work/main.go": source }, [stage]);
    source[0] = 2;
    await session.compile({ "/work/main.go": source }, [stage]);

    expect(binding.requests[1].sourceDelta).toEqual({
      generation: 2,
      upsertFiles: { "/work/main.go": new Uint8Array([2]) },
      removePaths: [],
    });
  });

  it("frees the process-local handle exactly once and rejects later builds", async () => {
    const { session, binding } = hydrate();
    session.dispose();
    session.dispose();
    expect(binding.freeCount).toBe(1);
    await expect(session.compile({ "/work/main.go": new Uint8Array([1]) }, [stage]))
      .rejects.toThrow("disposed");
  });

  it("refuses disposal while a build owns the session", async () => {
    const { session, binding } = hydrate();
    const compilePipeline = binding.compilePipeline.bind(binding);
    let releaseBuild: (() => void) | undefined;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    binding.compilePipeline = async (request) => {
      await buildGate;
      return compilePipeline(request);
    };

    const pending = session.compile({ "/work/main.go": new Uint8Array([1]) }, [stage]);
    expect(() => session.dispose()).toThrow("during a build");
    releaseBuild?.();
    await pending;
    session.dispose();
    expect(binding.freeCount).toBe(1);
  });

  it("fails closed on an invalid session digest", () => {
    expect(() => BrowserGoCompilerSession.hydrate(FakeRuntimeCoreGoSession, {
      digest: "invalid",
      toolchain: { package: new Uint8Array([1]), memoryLimitBytes: 65_536 },
      standardLibraryFiles: { "/go/VERSION": new Uint8Array([1]) },
    })).toThrow("lowercase SHA-256");
  });
});
