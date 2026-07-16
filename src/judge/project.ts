import type { Language, Project, ProjectFile } from "@/src/core/types";
import type { JudgeProblem } from "./problems";

const ENTRY_BY_LANGUAGE: Record<Language, string> = {
  c: "src/main.c",
  cpp: "src/main.cpp",
  rust: "src/main.rs",
  python: "src/main.py",
  javascript: "src/main.js",
  typescript: "src/main.ts",
};

function starterSource(problem: JudgeProblem, language: Language): string {
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
        "fn main() {",
        `    // ${heading}`,
        "    // read_int() is provided by the LocalWASI Rust core profile.",
        "    // TODO: read each integer and print the required answer.",
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
  }
}

export function judgeProjectId(problemId: string, language: Language): string {
  return `judge:${problemId}:${language}`;
}

export function problemIdFromProject(project: Project): string | undefined {
  const match = /^judge:([^:]+):(?:c|cpp|rust|python|javascript|typescript)$/.exec(project.id);
  return match?.[1];
}

export function createJudgeProject(problem: JudgeProblem, language: Language): Project {
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
      target: language === "python" ? "wasix" : "wasi",
      optimization: "release",
      entry,
      args: [],
      stdin: problem.examples[0].input,
      env: {},
    },
  };
}
