import type { BuiltinLanguage, Project, ProjectFile } from "@/src/core/types";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { DEFAULT_RESOURCE_POLICY } from "../core/resources";
import {
  broadestPolicy,
  DEFAULT_PROBLEM_LOCALE,
  sampleCases,
  type JudgeProblem,
} from "./problem-model";

const ENTRY_BY_LANGUAGE: Record<BuiltinLanguage, string> = {
  c: "src/main.c",
  cpp: "src/main.cpp",
  rust: "src/main.rs",
  python: "src/main.py",
  javascript: "src/main.js",
  typescript: "src/main.ts",
  go: "src/main.go",
};

export function judgeStarterSource(problem: JudgeProblem, language: BuiltinLanguage): string {
  const heading = `Problem ${problem.number}: ${problem.title[DEFAULT_PROBLEM_LOCALE]}`;
  switch (language) {
    case "c":
      return [
        "#include <stdio.h>",
        "",
        "int main(void) {",
        `    // ${heading}`,
        "    // TODO: read from stdin and print the required answer.",
        "    return 0;",
        "}",
        "",
      ].join("\n");
    case "cpp":
      return [
        "#include <iostream>",
        "using namespace std;",
        "",
        "int main() {",
        "    ios::sync_with_stdio(false);",
        "    cin.tie(nullptr);",
        `    // ${heading}`,
        "    // TODO: read from cin and print the required answer.",
        "    return 0;",
        "}",
        "",
      ].join("\n");
    case "rust":
      return [
        "use std::io::{self, Read};",
        "",
        "fn main() {",
        `    // ${heading}`,
        "    let mut input = String::new();",
        "    io::stdin().read_to_string(&mut input).unwrap();",
        "    // TODO: parse input, compute, and print the required answer.",
        "}",
        "",
      ].join("\n");
    case "python":
      return [
        "import sys",
        "",
        "input_data = sys.stdin.read()",
        `# ${heading}`,
        "# TODO: compute and print the required answer.",
        "",
      ].join("\n");
    case "javascript":
      return [
        "import * as std from \"std\";",
        "",
        "const input = std.in.readAsString();",
        `// ${heading}`,
        "// TODO: compute and print the required answer.",
        "",
      ].join("\n");
    case "typescript":
      return [
        "import * as std from \"std\";",
        "",
        "const input: string = std.in.readAsString();",
        `// ${heading}`,
        "// TODO: compute and print the required answer.",
        "",
      ].join("\n");
    case "go":
      return [
        "package main",
        "",
        "import (",
        "    \"bufio\"",
        "    \"fmt\"",
        "    \"os\"",
        ")",
        "",
        "func main() {",
        `    // ${heading}`,
        "    in := bufio.NewReader(os.Stdin)",
        "    _ = in",
        "    // TODO: read input, compute, and print the required answer.",
        "    fmt.Print(\"\")",
        "}",
        "",
      ].join("\n");
  }
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
  const entry = ENTRY_BY_LANGUAGE[language];
  const file: ProjectFile = {
    path: entry,
    language,
    content: judgeStarterSource(problem, language),
  };
  return {
    id: judgeProjectId(collectionKey, bundleSha256, problem.id, language),
    name: `judge-${String(problem.number).padStart(2, "0")}-${problem.id}`,
    files: [file],
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
