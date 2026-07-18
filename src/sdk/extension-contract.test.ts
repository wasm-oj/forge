import { describe, expect, it, vi } from "vitest";
import {
  costProfileId,
  createForgeEngine,
  FORGE_CONTRACT_VERSION,
  ForgeCompilerRegistry,
  type BuildResult,
  type ForgeCompiler,
  type ForgeRunner,
  type Project,
  type RunResult,
} from "./core";

const ZIG_TOOLCHAIN_CONTENT = "zig-0.13.0-sha256-deadbeef";

function zigCompiler() {
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  return {
    cacheIdentity: vi.fn((project: Project) => [
      "forge-test-zig-compiler-1",
      ZIG_TOOLCHAIN_CONTENT,
      project.config.target,
      project.config.optimization,
    ].join(":")),
    ready: vi.fn(() => Promise.resolve()),
    build: vi.fn(async (project: Project, cacheKey: string): Promise<BuildResult> => ({
      success: true,
      diagnostics: [],
      artifact: {
        kind: "wasm",
        forgeContract: FORGE_CONTRACT_VERSION,
        id: `zig:${cacheKey}`,
        projectId: project.id,
        cacheKey,
        name: project.name,
        language: project.config.language,
        target: project.config.target,
        optimization: project.config.optimization,
        createdAt: 0,
        durationMs: 0,
        size: bytes.byteLength,
        toolchains: [ZIG_TOOLCHAIN_CONTENT],
        costProfile: costProfileId(
          project.config.language,
          project.config.target,
          project.config.optimization,
          ZIG_TOOLCHAIN_CONTENT,
        ),
        bytes,
      },
      stdout: "",
      stderr: "",
      cacheHit: false,
    })),
    onProgress: vi.fn(() => () => undefined),
    clearToolchainCache: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(),
    restart: vi.fn(),
    dispose: vi.fn(),
  } satisfies ForgeCompiler;
}

function unusedRunner() {
  return {
    ready: vi.fn(() => Promise.resolve()),
    run: vi.fn(async (): Promise<RunResult> => {
      throw new Error("The compile contract test does not execute an artifact.");
    }),
    interact: vi.fn(),
    onProgress: vi.fn(() => () => undefined),
    onStream: vi.fn(() => () => undefined),
    clearRuntimeCache: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(),
    cancelAndWait: vi.fn(() => Promise.resolve()),
    restart: vi.fn(),
    dispose: vi.fn(),
  } satisfies ForgeRunner;
}

describe("downstream language library contract", () => {
  it("compiles a seventh language through the public ForgeEngine contract", async () => {
    const compiler = zigCompiler();
    const runner = unusedRunner();
    const registry = new ForgeCompilerRegistry([{
      languages: ["zig"],
      compiler,
    }]);
    const engine = await createForgeEngine({ compiler: registry, runner });

    try {
      const result = await engine.compile({
        language: "zig",
        target: "wasip1",
        optimization: "release",
        entry: "src/main.zig",
        files: { "src/main.zig": "pub fn main() void {}" },
      }, { cache: false });

      expect(result.success).toBe(true);
      expect(result.artifact).toMatchObject({
        forgeContract: FORGE_CONTRACT_VERSION,
        language: "zig",
        target: "wasip1",
        optimization: "release",
        toolchains: [ZIG_TOOLCHAIN_CONTENT],
      });
      expect(compiler.cacheIdentity).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({ language: "zig" }),
      }));
      expect(compiler.build).toHaveBeenCalledTimes(1);
      expect(result.artifact?.cacheKey).toBe(compiler.build.mock.calls[0]?.[1]);
      expect(compiler.ready).toHaveBeenCalledTimes(1);
      expect(runner.ready).toHaveBeenCalledTimes(1);
      expect(runner.run).not.toHaveBeenCalled();
    } finally {
      engine.dispose();
    }
  });
});
