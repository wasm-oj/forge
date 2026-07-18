import type { BuiltinLanguage, Project, ProjectFile } from "@/src/core/types";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { DEFAULT_RESOURCE_POLICY } from "../core/resources";
import type { JudgeProblem } from "./problems";

const ENTRY_BY_LANGUAGE: Record<BuiltinLanguage, string> = {
  c: "src/main.c",
  cpp: "src/main.cpp",
  rust: "src/main.rs",
  python: "src/main.py",
  javascript: "src/main.js",
  typescript: "src/main.ts",
  go: "src/main.go",
};

function starterSource(problem: JudgeProblem, language: BuiltinLanguage): string {
  const heading = `Problem ${problem.number}: ${problem.title}`;
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
        "    let data: Vec<i64> = input.split_whitespace()",
        "        .map(|value| value.parse().unwrap())",
        "        .collect();",
        "    // TODO: compute and print the required answer from data.",
        "}",
        "",
      ].join("\n");
    case "python":
      return [
        "import sys",
        "",
        "data = list(map(int, sys.stdin.read().split()))",
        `# ${heading}`,
        "# TODO: compute and print the required answer.",
        "",
      ].join("\n");
    case "javascript":
      return [
        "import * as std from \"std\";",
        "",
        "const input = std.in.readAsString().trim();",
        "const data = input ? input.split(/\\s+/).map(BigInt) : [];",
        `// ${heading}`,
        "// TODO: compute and print the required answer.",
        "",
      ].join("\n");
    case "typescript":
      return [
        "import * as std from \"std\";",
        "",
        "const input: string = std.in.readAsString().trim();",
        "const data: bigint[] = input ? input.split(/\\s+/).map(BigInt) : [];",
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

export function judgeProjectId(problemId: string, language: BuiltinLanguage): string {
  return `judge:${problemId}:${language}`;
}

export function problemIdFromProject(project: Project): string | undefined {
  const match = /^judge:([^:]+):(?:c|cpp|rust|python|javascript|typescript|go)$/.exec(project.id);
  return match?.[1];
}

export function createJudgeProject(problem: JudgeProblem, language: BuiltinLanguage): Project {
  const entry = ENTRY_BY_LANGUAGE[language];
  const file: ProjectFile = {
    path: entry,
    language,
    content: starterSource(problem, language),
  };
  return {
    id: judgeProjectId(problem.id, language),
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
      stdin: problem.examples[0].input,
      env: {},
      determinism: { ...DEFAULT_DETERMINISM },
      resources: { ...DEFAULT_RESOURCE_POLICY, instructionBudget: problem.instructionBudget },
    },
  };
}
