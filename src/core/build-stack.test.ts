import { describe, expect, it } from "vitest";
import { createSdkProject } from "../sdk/project";
import { assertValidProject } from "./project-validation";
import { projectCacheKey } from "./hash";

const input = { language: "c", entry: "main.c", files: { "main.c": "int main(void) { return 0; }" } };

describe("build stack size", () => {
  it.each(["c", "cpp"])("preserves the %s option through the SDK and project boundary", (language) => {
    const project = createSdkProject({ ...input, language, stackSizeBytes: 8 * 1024 * 1024 });
    expect(project.config.stackSizeBytes).toBe(8 * 1024 * 1024);
    expect(() => assertValidProject(project)).not.toThrow();
  });

  it("preserves omission and separates default and custom-size artifacts", async () => {
    const project = createSdkProject(input);
    expect(project.config).not.toHaveProperty("stackSizeBytes");
    const defaultKey = await projectCacheKey(project);
    project.config.stackSizeBytes = 1024 * 1024;
    const smallKey = await projectCacheKey(project);
    project.config.stackSizeBytes = 8 * 1024 * 1024;
    expect(new Set([defaultKey, smallKey, await projectCacheKey(project)]).size).toBe(3);
  });

  it.each([0, -16, 1, 17, 16.5, NaN, Infinity, 2 ** 32, "8388608", null])("rejects invalid size %j at both input boundaries", (value) => {
    expect(() => createSdkProject({ ...input, stackSizeBytes: value as number })).toThrow("stackSizeBytes");
    const project = createSdkProject(input);
    Object.assign(project.config, { stackSizeBytes: value });
    expect(() => assertValidProject(project)).toThrow("stackSizeBytes");
  });

  it.each(["rust", "python", "javascript", "java", "go"])("rejects rather than ignores the option for %s", (language) => {
    expect(() => createSdkProject({ ...input, language, stackSizeBytes: 1024 })).toThrow("only for C/C++");
    const project = createSdkProject({ ...input, language });
    project.config.stackSizeBytes = 1024;
    expect(() => assertValidProject(project)).toThrow("only for C/C++");
  });
});
