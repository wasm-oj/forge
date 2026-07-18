import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { FORGE_CONTRACT_VERSION } from "../core/contract";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { costProfileId } from "../core/cost-profile";
import { CostBaselineRegistry, createExtendedCostBaselineRegistry } from "../core/cost";
import { DEFAULT_RESOURCE_POLICY } from "../core/resources";
import type { Project, RuntimeBundleArtifact, WasmArtifact } from "../core/types";
import { createRuntimeBundleManifest } from "../core/artifact-validation";
import { GO_RUNTIME_STARTUP_ENTROPY_BYTES } from "../compiler/go-toolchain";
import {
  PYTHON_PACKAGE,
  PYTHON_RUNTIME_FILES_ARCHIVE_SHA256,
  QUICKJS_PACKAGE,
  toolchainPackageIdentities,
} from "../core/toolchains";
import { PYTHON_RUNTIME_FILES_CACHE_KEY } from "./runtime-files";
import {
  createDefaultRuntimeDrivers,
  prepareArtifactInteraction,
  prepareArtifactRun,
  quickJsBundle,
  RUN_INPUT_LIMITS,
  RuntimeDriverRegistry,
} from "./artifact";

const base = {
  forgeContract: FORGE_CONTRACT_VERSION,
  id: "artifact",
  projectId: "project",
  cacheKey: "cache",
  name: "program",
  language: "c" as const,
  target: "wasip1" as const,
  optimization: "release" as const,
  createdAt: 0,
  durationMs: 0,
  size: 1,
  toolchains: toolchainPackageIdentities("c"),
  costProfile: costProfileId("c", "wasip1", "release"),
};
const config = {
  args: ["one"],
  stdin: "input",
  env: { USER_VALUE: "ok" },
  determinism: { ...DEFAULT_DETERMINISM },
  resources: { ...DEFAULT_RESOURCE_POLICY },
};
const resolver = {
  quickJs: vi.fn(async () => new Uint8Array([2])),
  packageCommand: vi.fn(async () => new Uint8Array([3])),
  packageFileSystem: vi.fn(async () => ({
    "/cpython/lib/python3.14/encodings/__init__.py": new Uint8Array([4]),
  })),
};
const cProfile = costProfileId("c", "wasip1", "release");
const pythonProfile = costProfileId("python", "wasip1", "release");
const builtInDrivers = createDefaultRuntimeDrivers(new CostBaselineRegistry({
  [cProfile]: 123,
  [pythonProfile]: 456,
}));

describe("artifact runner preparation", () => {
  it("prepares standalone modules without a runtime lookup", async () => {
    const artifact: WasmArtifact = { ...base, kind: "wasm", bytes: new Uint8Array([1]) };
    const request = await prepareArtifactRun(artifact, config, resolver, builtInDrivers);
    expect(request.wasm).toEqual(new Uint8Array([1]));
    expect(request.stdin).toEqual(new TextEncoder().encode("input"));
    expect(request.cost.baselineCost).toBe(123);
    expect(request.startupEntropyBytes).toBe(0);
    expect(request.resources.instructionBudget).toBe(
      config.resources.instructionBudget + request.cost.baselineCost,
    );
    expect(resolver.quickJs).not.toHaveBeenCalled();
  });

  it("reserves Go runtime startup entropy without exposing it as caller determinism", async () => {
    const profile = costProfileId("go", "wasip1", "release");
    const artifact: WasmArtifact = {
      ...base,
      language: "go",
      toolchains: toolchainPackageIdentities("go"),
      costProfile: profile,
      kind: "wasm",
      bytes: new Uint8Array([1]),
    };
    const drivers = createDefaultRuntimeDrivers(new CostBaselineRegistry({ [profile]: 1 }));

    const request = await prepareArtifactRun(artifact, config, resolver, drivers);
    expect(request.startupEntropyBytes).toBe(GO_RUNTIME_STARTUP_ENTROPY_BYTES);
    expect(request.determinism).toEqual(config.determinism);
  });

  it("mounts isolated run files and captures normalized output paths", async () => {
    const artifact: WasmArtifact = { ...base, kind: "wasm", bytes: new Uint8Array([1]) };
    const inputFile = new Uint8Array([4, 2]);
    const request = await prepareArtifactRun(artifact, {
      ...config,
      files: { "/input/data.txt": inputFile },
      outputPaths: ["/output/result.txt"],
      cwd: "/",
    }, resolver, builtInDrivers);

    expect(request.files).toEqual({ "/input/data.txt": new Uint8Array([4, 2]) });
    expect(request.outputPaths).toEqual(["/output/result.txt"]);
    expect(request.cwd).toBe("/");
    expect(request.files["/input/data.txt"]).not.toBe(inputFile);
  });

  it("rejects non-canonical and duplicate run paths", async () => {
    const artifact: WasmArtifact = { ...base, kind: "wasm", bytes: new Uint8Array([1]) };
    await expect(prepareArtifactRun(artifact, {
      ...config,
      files: { "relative.txt": new Uint8Array() },
    }, resolver, builtInDrivers)).rejects.toThrow("absolute, normalized");
    await expect(prepareArtifactRun(artifact, {
      ...config,
      outputPaths: ["/output.txt", "/output.txt"],
    }, resolver, builtInDrivers)).rejects.toThrow("unique");
  });

  it("rejects excessive mounted input entries before runtime preparation", async () => {
    const artifact: WasmArtifact = { ...base, kind: "wasm", bytes: new Uint8Array([1]) };
    const files = Object.fromEntries(Array.from(
      { length: RUN_INPUT_LIMITS.files + 1 },
      (_, index) => [`/input/${index}.txt`, new Uint8Array()],
    ));

    await expect(prepareArtifactRun(artifact, {
      ...config,
      files,
    }, resolver, builtInDrivers)).rejects.toThrow(`at most ${RUN_INPUT_LIMITS.files} entries`);
  });

  it("mounts CPython bundles under a normalized project root", async () => {
    const project: Project = {
      id: "project",
      name: "program",
      files: [{ path: "main.py", language: "python", content: "print(1)\n" }],
      activeFile: "main.py",
      updatedAt: 0,
      config: {
        language: "python",
        target: "wasip1",
        optimization: "release",
        entry: "main.py",
        args: [],
        stdin: "",
        env: {},
        determinism: { ...DEFAULT_DETERMINISM },
        resources: { ...DEFAULT_RESOURCE_POLICY },
      },
    };
    const manifest = createRuntimeBundleManifest(project, PYTHON_PACKAGE, "python", "build/main.pyc");
    const files = {
      ".forge/deterministic_runner.py": "runner",
      "build/main.pyc": new Uint8Array([7]),
      "forge.manifest.json": manifest,
    };
    const artifact: RuntimeBundleArtifact = {
      ...base,
      kind: "runtime-bundle",
      language: "python",
      target: "wasip1",
      optimization: "release",
      costProfile: costProfileId("python", "wasip1", "release"),
      toolchains: toolchainPackageIdentities("python"),
      runtimePackage: PYTHON_PACKAGE,
      command: "python",
      entry: "build/main.pyc",
      files,
      manifest,
      size: Object.values(files).reduce(
        (total, value) => total + (typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength),
        0,
      ),
    };
    const request = await prepareArtifactRun(artifact, config, resolver, builtInDrivers);
    expect(request.cwd).toBe("/project");
    expect(request.args.slice(0, 2)).toEqual([
      "/project/.forge/deterministic_runner.py",
      "/project/build/main.pyc",
    ]);
    expect(request.files["/project/build/main.pyc"]).toEqual(new Uint8Array([7]));
    expect(request.files["/cpython/lib/python3.14/encodings/__init__.py"]).toEqual(new Uint8Array([4]));
    expect(resolver.packageFileSystem).toHaveBeenCalledWith(expect.objectContaining({
      cacheKey: PYTHON_RUNTIME_FILES_CACHE_KEY,
      expectedSha256: PYTHON_RUNTIME_FILES_ARCHIVE_SHA256,
    }));
  });

  it("refuses ambiguous runtime plugins", () => {
    const registry = new RuntimeDriverRegistry();
    registry.register({ id: "one", supports: () => true, prepare: vi.fn() });
    registry.register({ id: "two", supports: () => true, prepare: vi.fn() });
    const artifact: WasmArtifact = { ...base, kind: "wasm", bytes: new Uint8Array([1]) };
    expect(() => registry.driver(artifact)).toThrow("ambiguous");
    expect(() => registry.register({ id: "late", supports: () => false, prepare: vi.fn() }))
      .toThrow("sealed");
  });

  it("validates runtime plugin contracts before registration", () => {
    const registry = new RuntimeDriverRegistry();
    expect(() => registry.register({ id: " padded", supports: () => true, prepare: vi.fn() }))
      .toThrow("trimmed");
    expect(() => registry.register({ id: "broken", supports: undefined, prepare: vi.fn() } as never))
      .toThrow("supports() and prepare()");
    registry.register({ id: "valid", supports: () => true, prepare: vi.fn() });
    expect(() => registry.register({ id: "valid", supports: () => false, prepare: vi.fn() }))
      .toThrow("already registered");
  });

  it("requires runtime support predicates to return booleans", () => {
    const registry = new RuntimeDriverRegistry();
    registry.register({ id: "invalid-result", supports: (() => "yes") as never, prepare: vi.fn() });
    expect(() => registry.driver({ ...base, kind: "wasm", bytes: new Uint8Array([1]) }))
      .toThrow("must return a boolean");
  });

  it("rejects artifacts without a calibrated cost profile", async () => {
    const artifact: WasmArtifact = {
      ...base,
      costProfile: "unregistered",
      kind: "wasm",
      bytes: new Uint8Array([1]),
    };
    await expect(prepareArtifactRun(artifact, config, resolver)).rejects.toThrow("does not match c/wasip1/release");
  });

  it("prepares a calibrated standalone artifact from a downstream language", async () => {
    const profile = costProfileId("zig", "wasip1", "release", "zig-0.13.0-sha256-deadbeef");
    const artifact: WasmArtifact = {
      ...base,
      language: "zig",
      size: 8,
      toolchains: ["zig-0.13.0-sha256-deadbeef"],
      costProfile: profile,
      kind: "wasm",
      bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    };
    const drivers = createDefaultRuntimeDrivers(createExtendedCostBaselineRegistry({ [profile]: 42 }));

    const request = await prepareArtifactRun(artifact, config, resolver, drivers);
    expect(request.cost).toEqual({
      profile,
      baselineCost: 42,
      netInstructionBudget: config.resources.instructionBudget,
      rawInstructionBudget: config.resources.instructionBudget + 42,
    });
    expect(request.wasm).toEqual(artifact.bytes);
  });

  it("rejects QuickJS bundles for streaming interactive execution", async () => {
    const project: Project = {
      id: "javascript-project",
      name: "program",
      files: [{ path: "main.js", language: "javascript", content: "" }],
      activeFile: "main.js",
      updatedAt: 0,
      config: {
        language: "javascript",
        target: "wasip1",
        optimization: "release",
        entry: "main.js",
        args: [],
        stdin: "",
        env: {},
        determinism: { ...DEFAULT_DETERMINISM },
        resources: { ...DEFAULT_RESOURCE_POLICY },
      },
    };
    const manifest = createRuntimeBundleManifest(project, QUICKJS_PACKAGE, "qjs", "main.js");
    const files = { "main.js": "", "forge.manifest.json": manifest };
    const artifact: RuntimeBundleArtifact = {
      ...base,
      kind: "runtime-bundle",
      id: "javascript-artifact",
      projectId: project.id,
      cacheKey: "javascript-cache",
      name: "program.javascript-wasip1.json",
      language: "javascript",
      toolchains: toolchainPackageIdentities("javascript"),
      costProfile: costProfileId("javascript", "wasip1", "release"),
      runtimePackage: QUICKJS_PACKAGE,
      command: "qjs",
      entry: "main.js",
      files,
      manifest,
      size: Object.values(files).reduce((total, value) => total + new TextEncoder().encode(value).byteLength, 0),
    };

    await expect(prepareArtifactInteraction(
      artifact,
      config,
      resolver,
      createDefaultRuntimeDrivers(new CostBaselineRegistry({
        [artifact.costProfile]: 1,
      })),
    )).rejects.toThrow("does not support streaming interactive execution");
  });

  it("rejects artifacts from another or missing Forge contract", async () => {
    const artifact = {
      ...base,
      forgeContract: FORGE_CONTRACT_VERSION + 1,
      kind: "wasm",
      bytes: new Uint8Array([1]),
    } as unknown as WasmArtifact;
    await expect(prepareArtifactRun(artifact, config, resolver)).rejects.toThrow(
      `Artifact Forge contract '${FORGE_CONTRACT_VERSION + 1}' is unsupported; expected '${FORGE_CONTRACT_VERSION}'.`,
    );
  });

  it("rejects QuickJS imports that escape the canonical project root", () => {
    const artifact = {
      entry: "src/main.js",
      files: {
        "escape.js": "module.exports = 42;",
        "src/main.js": 'require("../../escape.js");',
      },
    } as unknown as RuntimeBundleArtifact;
    const source = quickJsBundle(artifact, "", config);
    const context = {
      __forge_determinism_seed: () => 0,
      __forge_determinism_epoch_ms: () => 0,
      __forge_determinism_step_ns: () => 1,
      __forge_write_stdout: vi.fn(),
      __forge_write_stderr: vi.fn(),
    };

    expect(() => runInNewContext(source, context)).toThrow("escapes the project root");
  });

  it("resolves a locked flat npm package by its canonical package main", () => {
    const artifact = {
      entry: "main.js",
      files: {
        "main.js": 'require("std").out.puts(String(require("answer")));',
        "node_modules/answer/package.json": JSON.stringify({ main: "lib/index.js" }),
        "node_modules/answer/lib/index.js": "module.exports = 42;",
      },
    } as unknown as RuntimeBundleArtifact;
    const source = quickJsBundle(artifact, "", config);
    const stdout = vi.fn();

    runInNewContext(source, {
      __forge_determinism_seed: () => 0,
      __forge_determinism_epoch_ms: () => 0,
      __forge_determinism_step_ns: () => 1,
      __forge_write_stdout: stdout,
      __forge_write_stderr: vi.fn(),
    });

    expect(stdout).toHaveBeenCalledWith("42");
  });

  it("rejects non-canonical QuickJS module separators", () => {
    const artifact = {
      entry: "main.js",
      files: { "main.js": 'require(".\\\\child.js");' },
    } as unknown as RuntimeBundleArtifact;
    const source = quickJsBundle(artifact, "", config);
    const context = {
      __forge_determinism_seed: () => 0,
      __forge_determinism_epoch_ms: () => 0,
      __forge_determinism_step_ns: () => 1,
      __forge_write_stdout: vi.fn(),
      __forge_write_stderr: vi.fn(),
    };

    expect(() => runInNewContext(source, context)).toThrow("canonical forward slashes");
  });
});
