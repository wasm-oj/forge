import { describe, expect, it } from "vitest";
import type { Project } from "../../../core/types";
import type { JudgeProblem } from "../../../judge/problem-model";
import {
  createPromptAssistRequest,
  parsePromptAssistResponse,
  projectHasNonTemplateSources,
  replaceProjectWithPromptAssistDraft,
  type PracticePromptAssistWorkspaceContext,
} from "./prompt-assist-contract";

const context: PracticePromptAssistWorkspaceContext = {
  kind: "practice",
  problemId: "11111111-1111-4111-8111-111111111111",
  catalogCommit: "a".repeat(40),
  publicContextSha256: "b".repeat(64),
};

const project = {
  id: "judge:test",
  name: "sum",
  files: [{ path: "main.c", language: "c", content: "int main(void) { return 0; }" }],
  activeFile: "main.c",
  updatedAt: 1,
  config: {
    language: "c",
    target: "wasip1",
    optimization: "release",
    entry: "main.c",
    args: [],
    stdin: "",
    env: {},
    determinism: { randomSeed: 1, realtimeEpochMs: 0, clockStepNs: 1 },
    resources: {
      instructionBudget: 1,
      logicalTimeLimitMs: 1,
      memoryLimitBytes: 1,
      wallTimeLimitMs: 1,
      outputLimitBytes: 1,
      filesystemWriteLimitBytes: 1,
      filesystemEntryLimit: 1,
    },
  },
} satisfies Project;

describe("Prompt Assist browser contract", () => {
  it("strictly parses a non-official editable draft and rejects identity leakage", () => {
    const request = createPromptAssistRequest(context, "c", "main.c", "solve it");
    const value = {
      schema: "wasm-oj-platform/prompt-assist-result/v1",
      context,
      output: { language: "c", target: "wasip1", optimization: "release", entry: "main.c" },
      entry: "main.c",
      sourceFiles: [{ path: "main.c", encoding: "utf8", content: "int main(void) { return 1; }" }],
    };
    const draft = parsePromptAssistResponse(value, request);
    draft.sourceFiles[0]!.content = "int main(void) { return 2; }";
    expect(draft.sourceFiles[0]!.content).toContain("return 2");
    expect(() => parsePromptAssistResponse({ ...value, compilerConfigId: "hidden" }, request)).toThrow(/invalid shape/);
  });

  it("rejects stale context and output-profile substitution", () => {
    const request = createPromptAssistRequest(context, "c", "main.c", "solve it");
    const value = {
      schema: "wasm-oj-platform/prompt-assist-result/v1",
      context,
      output: { language: "c", target: "wasip1", optimization: "release", entry: "main.c" },
      entry: "main.c",
      sourceFiles: [{ path: "main.c", encoding: "utf8", content: "int main(void) {}" }],
    };
    expect(() => parsePromptAssistResponse({
      ...value,
      context: { ...context, catalogCommit: "c".repeat(40) },
    }, request)).toThrow(/context is stale/);
    expect(() => parsePromptAssistResponse({
      ...value,
      output: { ...value.output, language: "rust" },
    }, request)).toThrow(/output profile/);
  });

  it("detects non-template work before replacement and keeps the result ordinary/editable", () => {
    const problem = {
      starterTemplates: {
        c: { entry: "main.c", files: { "main.c": "int main(void) { return 0; }" } },
      },
    } as unknown as JudgeProblem;
    expect(projectHasNonTemplateSources(project, problem)).toBe(false);
    expect(projectHasNonTemplateSources({
      ...project,
      files: [{ ...project.files[0]!, content: "/* user work */" }],
    }, problem)).toBe(true);

    const replaced = replaceProjectWithPromptAssistDraft(project, {
      output: { language: "c", target: "wasip1", optimization: "release", entry: "src/main.c" },
      entry: "src/main.c",
      sourceFiles: [{ path: "src/main.c", encoding: "utf8", content: "int main(void) { return 3; }" }],
    });
    expect(replaced.files).toEqual([{ path: "src/main.c", language: "c", content: "int main(void) { return 3; }" }]);
    replaced.files[0]!.content = "/* editable */";
    expect(replaced.files[0]!.content).toContain("editable");
    expect(replaced).not.toHaveProperty("promptAttemptId");
  });
});
