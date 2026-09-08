import { describe, expect, it, vi } from "vitest";
import { createSdkProject } from "../sdk/project";
import { buildProject, configureWasmerCompilerHost, type WasmerCompilerHost } from "./wasmer-engine";

describe("JavaScript packaging matches the native execution phase", () => {
  it.each(['let value=1;value="42";console.log(value);', 'const = ;', 'await Promise.resolve();'])("preserves source without invoking a TypeScript checker: %s", async (source) => {
    const loadToolchainAsset = vi.fn(() => { throw new Error("JavaScript must not load a compiler"); });
    configureWasmerCompilerHost({ progress: vi.fn(), loadToolchainAsset } as unknown as WasmerCompilerHost);
    const project = createSdkProject({ language: "javascript", target: "wasip1", entry: "main.js", files: { "main.js": source } });
    const result = await buildProject(project, "test", "test");
    expect(result.success).toBe(true);
    expect(result.artifact?.kind).toBe("runtime-bundle");
    if (result.artifact?.kind !== "runtime-bundle") throw new Error("Missing runtime bundle");
    expect(result.artifact.files[result.artifact.entry]).toBe(source);
    expect(loadToolchainAsset).not.toHaveBeenCalled();
  });
});
