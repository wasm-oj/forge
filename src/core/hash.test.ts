import { describe, expect, it } from "vitest";
import type { Project } from "./types";
import { DEFAULT_DETERMINISM } from "./determinism";
import { DEFAULT_RESOURCE_POLICY } from "./resources";
import { projectBuildIdentity, projectCacheKey } from "./hash";
import { toolchainCacheIdentity } from "./toolchains";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("project build cache key", () => {
  it("includes the pinned compiler and runtime identity", async () => {
    const project: Project = {
      id: "cache-test",
      name: "cache-test",
      files: [{ path: "src/main.ts", language: "typescript", content: "console.log(1);\n" }],
      config: {
        language: "typescript",
        target: "wasip1",
        optimization: "release",
        entry: "src/main.ts",
        args: [],
        stdin: "",
        env: {},
        determinism: { ...DEFAULT_DETERMINISM },
        resources: { ...DEFAULT_RESOURCE_POLICY },
      },
      activeFile: "src/main.ts",
      updatedAt: 0,
    };
    const canonical = JSON.stringify({
      project: {
        id: project.id,
        name: project.name,
      },
      config: {
        language: project.config.language,
        target: project.config.target,
        optimization: project.config.optimization,
        entry: project.config.entry,
      },
      compiler: JSON.stringify(toolchainCacheIdentity("typescript")),
      files: project.files.map(({ path, language, content }) => ({ path, language, content })),
    });

    expect(projectBuildIdentity(project)).toBe(canonical);
    expect(await projectCacheKey(project)).toBe(await sha256(canonical));
  });

  it("canonicalizes file insertion order and binds project id and name", async () => {
    const project: Project = {
      id: "identity-a",
      name: "program-a",
      files: [
        { path: "src/z.ts", language: "typescript", content: "export const z = 1;\n" },
        { path: "src/main.ts", language: "typescript", content: "import './z';\n" },
      ],
      config: {
        language: "typescript",
        target: "wasip1",
        optimization: "release",
        entry: "src/main.ts",
        args: [],
        stdin: "",
        env: {},
        determinism: { ...DEFAULT_DETERMINISM },
        resources: { ...DEFAULT_RESOURCE_POLICY },
      },
      activeFile: "src/main.ts",
      updatedAt: 0,
    };
    const original = await projectCacheKey(project);
    expect(await projectCacheKey({ ...project, files: [...project.files].reverse() })).toBe(original);
    expect(await projectCacheKey({ ...project, id: "identity-b" })).not.toBe(original);
    expect(await projectCacheKey({ ...project, name: "program-b" })).not.toBe(original);
  });

  it("does not rebuild when only execution inputs change", async () => {
    const project = {
      id: "runtime-input-test",
      name: "runtime-input-test",
      files: [{ path: "src/main.c", language: "c" as const, content: "int main(void) { return 0; }\n" }],
      config: {
        language: "c" as const,
        target: "wasip1" as const,
        optimization: "release" as const,
        entry: "src/main.c",
        args: [],
        stdin: "first",
        env: {},
        determinism: { ...DEFAULT_DETERMINISM },
        resources: { ...DEFAULT_RESOURCE_POLICY },
      },
      activeFile: "src/main.c",
      updatedAt: 0,
    };
    const original = await projectCacheKey(project);
    project.config.stdin = "second";
    project.config.determinism = {
      randomSeed: 42,
      realtimeEpochMs: DEFAULT_DETERMINISM.realtimeEpochMs + 86_400_000,
      clockStepNs: DEFAULT_DETERMINISM.clockStepNs + 1,
    };
    expect(await projectCacheKey(project)).toBe(original);
  });

  it("uses a downstream compiler identity for custom languages", async () => {
    const project: Project = {
      id: "custom-cache-test",
      name: "custom-cache-test",
      files: [{ path: "main.zig", language: "zig", content: "pub fn main() void {}\n" }],
      config: {
        language: "zig",
        target: "wasip1",
        optimization: "release",
        entry: "main.zig",
        args: [],
        stdin: "",
        env: {},
        determinism: { ...DEFAULT_DETERMINISM },
        resources: { ...DEFAULT_RESOURCE_POLICY },
      },
      activeFile: "main.zig",
      updatedAt: 0,
    };

    expect(() => projectBuildIdentity(project)).toThrow("no built-in toolchain");
    const first = projectBuildIdentity(project, "acme-zig-content-a");
    const second = projectBuildIdentity(project, "acme-zig-content-b");
    expect(first).not.toBe(second);
    expect(() => projectBuildIdentity(project, " untrimmed ")).toThrow("Compiler cache identities");
  });
});
