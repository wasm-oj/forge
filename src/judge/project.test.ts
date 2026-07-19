import { describe, expect, it } from "vitest";
import { LANGUAGES } from "../core/types";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { createJudgeProject, judgeProjectId, latestJudgeProjectForCollection, problemIdentityFromProject } from "./project";
import { PROBLEMS, broadestPolicy, sampleCases } from "./problems";

describe("judge project drafts", () => {
  const collectionKey = "github:wasm-oj/problems@main:collection/index.json";
  const bundleSha256 = "a".repeat(64);

  it("creates a deterministic, compilable draft contract for every built-in language", () => {
    const problem = PROBLEMS[0];
    for (const language of LANGUAGES) {
      const project = createJudgeProject(collectionKey, bundleSha256, problem, language);
      expect(project.id).toBe(judgeProjectId(collectionKey, bundleSha256, problem.id, language));
      expect(problemIdentityFromProject(project, collectionKey)).toEqual({ problemId: problem.id, bundleSha256 });
      expect(project.files).toHaveLength(1);
      expect(project.files[0].language).toBe(language);
      expect(project.config.entry).toBe(project.files[0].path);
      expect(project.config.stdin).toBe(sampleCases(problem)[0].input);
      expect(project.config.target).toBe("wasip1");
      expect(project.config.determinism).toEqual(DEFAULT_DETERMINISM);
      expect(project.config.resources.instructionBudget).toBe(
        broadestPolicy(problem).limits.instructionBudget,
      );
      expect(project.config.resources.memoryLimitBytes).toBe(
        broadestPolicy(problem).limits.memoryLimitBytes,
      );
    }
  });

  it("keeps generic text input because the catalog is not integer-only", () => {
    expect(createJudgeProject(collectionKey, bundleSha256, PROBLEMS[0], "javascript").files[0].content).toContain("readAsString()");
    expect(createJudgeProject(collectionKey, bundleSha256, PROBLEMS[0], "javascript").files[0].content).not.toContain("map(BigInt)");
    expect(createJudgeProject(collectionKey, bundleSha256, PROBLEMS[0], "typescript").files[0].content).toContain("const input: string");
  });

  it("isolates drafts from collections that reuse the same problem id", () => {
    const project = createJudgeProject(collectionKey, bundleSha256, PROBLEMS[0], "cpp");
    expect(problemIdentityFromProject(project, "github:other/problems@main:collection/index.json")).toBeUndefined();
  });

  it("isolates changed problems while restoring the latest current collection draft", () => {
    const unchanged = createJudgeProject(collectionKey, bundleSha256, PROBLEMS[0], "c");
    const changed = { ...createJudgeProject(collectionKey, "b".repeat(64), PROBLEMS[1], "rust"), updatedAt: 300 };
    const current = { ...createJudgeProject(collectionKey, bundleSha256, PROBLEMS[1], "cpp"), updatedAt: 200 };
    const otherSource = { ...createJudgeProject("github:other/problems@main:index.json", bundleSha256, PROBLEMS[0], "go"), updatedAt: 400 };
    expect(latestJudgeProjectForCollection(
      [{ ...unchanged, updatedAt: 100 }, changed, current, otherSource],
      collectionKey,
      new Map([[PROBLEMS[0].id, bundleSha256], [PROBLEMS[1].id, bundleSha256]]),
    )).toEqual(current);
  });
});
