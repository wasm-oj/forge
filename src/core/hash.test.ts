import { describe, expect, it } from "vitest";
import type { Project } from "./types";
import { projectCacheKey } from "./hash";
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
        target: "wasi",
        optimization: "release",
        entry: "src/main.ts",
        args: [],
        stdin: "",
        env: {},
      },
      activeFile: "src/main.ts",
      updatedAt: 0,
    };
    const canonical = JSON.stringify({
      config: project.config,
      toolchain: toolchainCacheIdentity("typescript"),
      files: project.files.map(({ path, language, content }) => ({ path, language, content })),
    });

    expect(await projectCacheKey(project)).toBe(await sha256(canonical));
  });
});
