import type { BuiltinLanguage, Project, ProjectFile } from "@/src/core/types";
import { canonicalProjectFiles } from "../core/project-files";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { DEFAULT_RESOURCE_POLICY } from "../core/resources";
import {
  broadestPolicy,
  sampleCases,
  type JudgeProblem,
} from "./problem-model";

export function judgeStarterSource(problem: JudgeProblem, language: BuiltinLanguage): string {
  const template = problem.starterTemplates[language];
  const source = template.files[template.entry];
  if (source === undefined) {
    throw new Error(`Problem '${problem.id}' has no entry source for '${language}'.`);
  }
  return source;
}

export interface JudgeProjectIdentity {
  readonly problemId: string;
  readonly bundleSha256: string;
}

export function judgeProjectId(collectionKey: string, bundleSha256: string, problemId: string, language: BuiltinLanguage): string {
  return `judge:${encodeURIComponent(collectionKey)}:${bundleSha256}:${problemId}:${language}`;
}

export function problemIdentityFromProject(project: Project, collectionKey: string): JudgeProjectIdentity | undefined {
  const prefix = `judge:${encodeURIComponent(collectionKey)}:`;
  if (!project.id.startsWith(prefix)) return undefined;
  const match = /^([0-9a-f]{64}):([^:]+):(?:c|cpp|rust|python|javascript|typescript|go)$/.exec(project.id.slice(prefix.length));
  return match ? { bundleSha256: match[1], problemId: match[2] } : undefined;
}

export function latestJudgeProjectForCollection(
  projects: readonly Project[],
  collectionKey: string,
  currentProblemDigests: ReadonlyMap<string, string>,
): Project | undefined {
  return projects
    .filter((project) => {
      const identity = problemIdentityFromProject(project, collectionKey);
      return identity !== undefined && currentProblemDigests.get(identity.problemId) === identity.bundleSha256;
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

export function createJudgeProject(collectionKey: string, bundleSha256: string, problem: JudgeProblem, language: BuiltinLanguage): Project {
  const baseline = broadestPolicy(problem);
  const sample = sampleCases(problem)[0];
  if (!sample) throw new Error(`Problem '${problem.id}' has no sample case.`);
  const template = problem.starterTemplates[language];
  const entry = template.entry;
  judgeStarterSource(problem, language);
  const files: ProjectFile[] = canonicalProjectFiles(Object.entries(template.files).map(([path, content]) => ({
    path,
    language,
    content,
  })));
  return {
    id: judgeProjectId(collectionKey, bundleSha256, problem.id, language),
    name: `judge-${String(problem.number).padStart(2, "0")}-${problem.id}`,
    files,
    activeFile: entry,
    updatedAt: Date.now(),
    config: {
      language,
      target: "wasip1",
      optimization: "release",
      entry,
      args: [],
      stdin: sample.input,
      env: {},
      determinism: { ...DEFAULT_DETERMINISM },
      resources: {
        ...DEFAULT_RESOURCE_POLICY,
        instructionBudget: baseline.limits.instructionBudget,
        memoryLimitBytes: baseline.limits.memoryLimitBytes,
        wallTimeLimitMs: problem.scoring.safetyLimits.wallTimeLimitMs,
        ...(baseline.limits.logicalTimeLimitMs === undefined
          ? {}
          : { logicalTimeLimitMs: baseline.limits.logicalTimeLimitMs }),
      },
    },
  };
}
