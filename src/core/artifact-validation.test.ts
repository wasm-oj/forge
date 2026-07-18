import { describe, expect, it } from "vitest";
import {
  assertValidBuildArtifact,
  canonicalRuntimeBundleFiles,
  createRuntimeBundleManifest,
} from "./artifact-validation";
import { FORGE_CONTRACT_VERSION } from "./contract";
import { costProfileId } from "./cost-profile";
import { DEFAULT_DETERMINISM } from "./determinism";
import { DEFAULT_RESOURCE_POLICY } from "./resources";
import { PYTHON_PACKAGE, toolchainPackageIdentities } from "./toolchains";
import type { BuildArtifact, Project, RuntimeBundleArtifact } from "./types";

function project(files: Project["files"]): Project {
  return {
    id: "manifest-project",
    name: "manifest-program",
    files,
    activeFile: "src/main.py",
    updatedAt: 0,
    config: {
      language: "python",
      target: "wasip1",
      optimization: "release",
      entry: "src/main.py",
      args: [],
      stdin: "",
      env: {},
      determinism: { ...DEFAULT_DETERMINISM },
      resources: { ...DEFAULT_RESOURCE_POLICY },
    },
  };
}

function artifactBase(language: BuildArtifact["language"], target: BuildArtifact["target"]) {
  return {
    forgeContract: FORGE_CONTRACT_VERSION,
    id: "artifact",
    projectId: "project",
    cacheKey: "cache-key",
    name: "program",
    language,
    target,
    optimization: "release" as const,
    createdAt: 0,
    durationMs: 0,
  };
}

describe("BuildArtifact validation boundary", () => {
  it.each(["python", "javascript"] as const)(
    "rejects arbitrary Wasm mislabeled as built-in %s",
    (language) => {
      const target = "wasip1";
      const artifact: BuildArtifact = {
        ...artifactBase(language, target),
        kind: "wasm",
        size: 1,
        bytes: new Uint8Array([0]),
        toolchains: toolchainPackageIdentities(language),
        costProfile: costProfileId(language, target, "release"),
      };
      expect(() => assertValidBuildArtifact(artifact)).toThrow(
        `Built-in '${language}' artifacts must use kind 'runtime-bundle'`,
      );
    },
  );

  it("keeps downstream languages extensible under explicit cost and toolchain identities", () => {
    const contentIdentity = "zig-0.13.0-sha256-deadbeef";
    const artifact: BuildArtifact = {
      ...artifactBase("zig", "wasip1"),
      kind: "wasm",
      size: 8,
      bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      toolchains: [contentIdentity],
      costProfile: costProfileId("zig", "wasip1", "release", contentIdentity),
    };
    expect(() => assertValidBuildArtifact(artifact)).not.toThrow();
  });

  it("rejects unsafe bundle paths before runner filesystem preparation", () => {
    const source = project([{ path: "src/main.py", language: "python", content: "print(1)\n" }]);
    const manifest = createRuntimeBundleManifest(source, PYTHON_PACKAGE, "python", "build/src/main.pyc");
    const files = {
      "../escape.pyc": new Uint8Array([9]),
      "build/src/main.pyc": new Uint8Array([7]),
      "forge.manifest.json": manifest,
    };
    const artifact: RuntimeBundleArtifact = {
      ...artifactBase("python", "wasip1"),
      kind: "runtime-bundle",
      size: 0,
      toolchains: toolchainPackageIdentities("python"),
      costProfile: costProfileId("python", "wasip1", "release"),
      runtimePackage: PYTHON_PACKAGE,
      command: "python",
      entry: "build/src/main.pyc",
      files,
      manifest,
    };
    expect(() => assertValidBuildArtifact(artifact)).toThrow("cannot escape the project");
  });

  it("serializes manifests and bundle records independently of file insertion order", () => {
    const files = [
      { path: "src/z.py", language: "python" as const, content: "VALUE = 1\n" },
      { path: "src/main.py", language: "python" as const, content: "import z\n" },
    ];
    const forward = project(files);
    const reversed = project([...files].reverse());
    expect(createRuntimeBundleManifest(forward, PYTHON_PACKAGE, "python", "build/src/main.pyc"))
      .toBe(createRuntimeBundleManifest(reversed, PYTHON_PACKAGE, "python", "build/src/main.pyc"));
    expect(Object.keys(canonicalRuntimeBundleFiles({
      "z.js": "z",
      "a.js": "a",
      "forge.manifest.json": "manifest",
    }))).toEqual(["a.js", "forge.manifest.json", "z.js"]);
  });
});
