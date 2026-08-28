import { isBuiltinLanguage, type BuiltinLanguage, type Project } from "../../../core/types";
import { extensionLanguage } from "../../../core/toolchains";
import type { JudgeProblem } from "../../../judge/problem-model";
import {
  PROMPT_COMPILER_HARD_LIMITS,
  promptCompilerResultToAssistDraft,
  type PromptAssistDraft,
  type PromptCompilerOutputProfile,
} from "../../../online-judge/prompt-compiler";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface PracticePromptAssistWorkspaceContext {
  readonly kind: "practice";
  readonly problemId: string;
  readonly catalogCommit: string;
  readonly publicContextSha256: string;
}

export interface ContestPromptAssistWorkspaceContext {
  readonly kind: "contest";
  readonly contestId: string;
  readonly problemId: string;
  readonly contentCommit: string;
  readonly timelineGeneration: number;
  readonly ruleEpoch: number;
  readonly problemEpoch: number;
  readonly publicContextSha256: string;
}

export type PromptAssistWorkspaceContext =
  | PracticePromptAssistWorkspaceContext
  | ContestPromptAssistWorkspaceContext;

export interface PromptAssistCreateRequest {
  readonly context: PromptAssistWorkspaceContext;
  readonly language: BuiltinLanguage;
  readonly entry: string;
  readonly prompt: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function positiveEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function assertPromptAssistWorkspaceContext(value: unknown): asserts value is PromptAssistWorkspaceContext {
  const context = record(value, "Prompt Assist context");
  if (context.kind === "practice") {
    exact(context, ["catalogCommit", "kind", "problemId", "publicContextSha256"], "Practice Prompt Assist context");
    if (typeof context.problemId !== "string" || !UUID.test(context.problemId)
      || typeof context.catalogCommit !== "string" || !COMMIT.test(context.catalogCommit)
      || typeof context.publicContextSha256 !== "string" || !SHA256.test(context.publicContextSha256)) {
      throw new TypeError("Practice Prompt Assist context identity is invalid.");
    }
    return;
  }
  if (context.kind !== "contest") throw new TypeError("Prompt Assist context kind is invalid.");
  exact(context, [
    "contentCommit", "contestId", "kind", "problemEpoch", "problemId",
    "publicContextSha256", "ruleEpoch", "timelineGeneration",
  ], "Contest Prompt Assist context");
  if (typeof context.contestId !== "string" || !UUID.test(context.contestId)
    || typeof context.problemId !== "string" || !UUID.test(context.problemId)
    || typeof context.contentCommit !== "string" || !COMMIT.test(context.contentCommit)
    || typeof context.publicContextSha256 !== "string" || !SHA256.test(context.publicContextSha256)
    || !positiveEpoch(context.timelineGeneration)
    || !positiveEpoch(context.ruleEpoch)
    || !positiveEpoch(context.problemEpoch)) {
    throw new TypeError("Contest Prompt Assist context identity is invalid.");
  }
}

export function createPromptAssistRequest(
  context: PromptAssistWorkspaceContext,
  language: BuiltinLanguage,
  entry: string,
  prompt: string,
): PromptAssistCreateRequest {
  assertPromptAssistWorkspaceContext(context);
  if (!isBuiltinLanguage(language)) throw new TypeError("Prompt Assist language is unsupported.");
  if (typeof entry !== "string" || entry.length < 1) throw new TypeError("Prompt Assist entry is required.");
  if (typeof prompt !== "string") throw new TypeError("Prompt Assist prompt must be a string.");
  return { context, language, entry, prompt };
}

function sameContext(left: unknown, right: PromptAssistWorkspaceContext): boolean {
  try {
    assertPromptAssistWorkspaceContext(left);
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function parsePromptAssistResponse(
  value: unknown,
  expected: PromptAssistCreateRequest,
): PromptAssistDraft {
  const response = record(value, "Prompt Assist response");
  exact(response, ["context", "entry", "output", "schema", "sourceFiles"], "Prompt Assist response");
  if (response.schema !== "wasm-oj-platform/prompt-assist-result/v1") {
    throw new TypeError("Prompt Assist response schema is invalid.");
  }
  if (!sameContext(response.context, expected.context)) throw new TypeError("Prompt Assist response context is stale.");
  const output = record(response.output, "Prompt Assist output");
  exact(output, ["entry", "language", "optimization", "target"], "Prompt Assist output");
  if (typeof output.language !== "string" || !isBuiltinLanguage(output.language)
    || output.language !== expected.language || output.entry !== expected.entry
    || (output.target !== "wasip1" && output.target !== "wasix")
    || (output.optimization !== "debug" && output.optimization !== "release")
    || response.entry !== output.entry) {
    throw new TypeError("Prompt Assist response output profile is invalid.");
  }
  const fixedOutput: PromptCompilerOutputProfile = {
    language: output.language,
    target: output.target,
    optimization: output.optimization,
    entry: output.entry,
  };
  return promptCompilerResultToAssistDraft({
    output: fixedOutput,
    entry: fixedOutput.entry,
    sourceFiles: response.sourceFiles as PromptAssistDraft["sourceFiles"],
  });
}

export function promptAssistUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function projectHasNonTemplateSources(project: Project, problem: JudgeProblem): boolean {
  if (!isBuiltinLanguage(project.config.language)) return true;
  const template = problem.starterTemplates[project.config.language];
  if (!template || project.config.entry !== template.entry) return true;
  const expected = Object.entries(template.files).sort(([left], [right]) => left.localeCompare(right));
  const actual = project.files.map((file) => [file.path, file.content] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(actual) !== JSON.stringify(expected);
}

export function replaceProjectWithPromptAssistDraft(project: Project, draft: PromptAssistDraft): Project {
  if (project.config.language !== draft.output.language) {
    throw new TypeError("Prompt Assist draft language no longer matches the active editor.");
  }
  return {
    ...project,
    files: draft.sourceFiles.map((file) => ({
      path: file.path,
      language: extensionLanguage(file.path) ?? draft.output.language,
      content: file.content,
    })),
    activeFile: draft.entry,
    config: {
      ...project.config,
      language: draft.output.language,
      target: draft.output.target,
      optimization: draft.output.optimization,
      entry: draft.entry,
    },
  };
}

export const PROMPT_ASSIST_MAX_PROMPT_BYTES = PROMPT_COMPILER_HARD_LIMITS.promptBytes;
