import { describe, expect, it, vi } from "vitest";
import { createSdkProject } from "../sdk/project";
import { buildProject, configureWasmerCompilerHost, type WasmerCompilerHost } from "./wasmer-engine";

describe("Python packaging matches native source execution", () => {
  it.each<Record<string, string>>([
    { "main.py": "def invalid(:" },
    { "main.py": "print(42)", "unused.py": "def invalid(:" },
    { "main.py": "from helper import answer\nprint(answer)", "helper.py": "answer=42" },
  ])("preserves sources without eager parsing", async (files) => {
    const loadToolchainAsset = vi.fn(() => { throw new Error("Python packaging must not load a compiler"); });
    configureWasmerCompilerHost({ progress: vi.fn(), loadToolchainAsset } as unknown as WasmerCompilerHost);
    const project = createSdkProject({ language: "python", target: "wasip1", entry: "main.py", files });
    const result = await buildProject(project, "test", "test");
    expect(result.success).toBe(true);
    if (result.artifact?.kind !== "runtime-bundle") throw new Error("Missing source bundle");
    expect(result.artifact.entry).toBe("main.py");
    expect(result.artifact.files).toMatchObject(files);
    expect(Object.keys(result.artifact.files).some((name) => name.endsWith(".pyc"))).toBe(false);
    expect(loadToolchainAsset).not.toHaveBeenCalled();
  });
});
