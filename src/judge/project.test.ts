import { describe, expect, it } from "vitest";
import { LANGUAGES } from "../core/types";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { createJudgeProject, judgeProjectId, problemIdFromProject } from "./project";
import { PROBLEMS, broadestPolicy, sampleCases } from "./problems";

describe("judge project drafts", () => {
  it("creates a deterministic, compilable draft contract for every built-in language", () => {
    const problem = PROBLEMS[0];
    for (const language of LANGUAGES) {
      const project = createJudgeProject(problem, language);
      expect(project.id).toBe(judgeProjectId(problem.id, language));
      expect(problemIdFromProject(project)).toBe(problem.id);
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
    expect(createJudgeProject(PROBLEMS[0], "javascript").files[0].content).toContain("readAsString()");
    expect(createJudgeProject(PROBLEMS[0], "javascript").files[0].content).not.toContain("map(BigInt)");
    expect(createJudgeProject(PROBLEMS[0], "typescript").files[0].content).toContain("const input: string");
  });
});
