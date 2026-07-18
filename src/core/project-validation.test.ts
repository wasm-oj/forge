import { describe, expect, it } from "vitest";
import { DEFAULT_DETERMINISM } from "./determinism";
import { assertValidProject } from "./project-validation";
import { PROJECT_SOURCE_LIMITS } from "./project-files";
import { DEFAULT_RESOURCE_POLICY } from "./resources";
import type { Project } from "./types";

function project(): Project {
  return {
    id: "project-1",
    name: "program",
    files: [
      { path: "src/helper.py", language: "python", content: "answer = 42\n" },
      { path: "src/main.py", language: "python", content: "print(42)\n" },
    ],
    config: {
      language: "python",
      target: "wasip1",
      optimization: "release",
      entry: "src/main.py",
      args: ["--answer", "42"],
      stdin: "input\n",
      env: { MODE: "judge" },
      determinism: { ...DEFAULT_DETERMINISM },
      resources: { ...DEFAULT_RESOURCE_POLICY },
    },
    activeFile: "src/helper.py",
    updatedAt: 1_700_000_000_000,
  };
}

describe("Project validation boundary", () => {
  it("accepts an exact project without reordering or coercing it", () => {
    const candidate = project();
    const paths = candidate.files.map((file) => file.path);
    expect(() => assertValidProject(candidate)).not.toThrow();
    expect(candidate.files.map((file) => file.path)).toEqual(paths);
    expect(candidate.config.args).toEqual(["--answer", "42"]);
  });

  it("accepts an explicit downstream language project", () => {
    const candidate = project();
    candidate.config.language = "zig";
    candidate.files = [{ path: "src/main.zig", language: "zig", content: "pub fn main() void {}\n" }];
    candidate.config.entry = "src/main.zig";
    candidate.activeFile = "src/main.zig";
    expect(() => assertValidProject(candidate)).not.toThrow();
  });

  it.each([
    ["non-object", null, "Project must be a plain data object"],
    ["numeric id", { ...project(), id: 7 }, "Project id must be a non-empty, trimmed string"],
    ["untrimmed name", { ...project(), name: " program " }, "Project name must be a non-empty, trimmed string"],
    ["extra project field", { ...project(), version: 2 }, "Project must contain exactly"],
    [
      "unsafe file path",
      { ...project(), files: [{ path: "../main.py", language: "python", content: "" }] },
      "cannot escape the project",
    ],
    [
      "duplicate file path",
      { ...project(), files: [project().files[0], { ...project().files[0] }] },
      "Duplicate project path",
    ],
    [
      "non-string file content",
      { ...project(), files: [{ path: "src/main.py", language: "python", content: new Uint8Array() }] },
      "content must be a string",
    ],
    [
      "extra file field",
      { ...project(), files: [{ ...project().files[0], encoding: "utf8" }] },
      "Project file 0 must contain exactly",
    ],
    [
      "missing entry",
      { ...project(), config: { ...project().config, entry: "src/missing.py" } },
      "is not present in files",
    ],
    ["missing active file", { ...project(), activeFile: "src/missing.py" }, "is not present in files"],
    [
      "untrimmed language",
      { ...project(), config: { ...project().config, language: " python" } },
      "Language identifiers must be non-empty, trimmed",
    ],
    [
      "invalid target",
      { ...project(), config: { ...project().config, target: "preview2" } },
      "Project target must be 'wasip1' or 'wasix'",
    ],
    [
      "unsupported built-in target",
      { ...project(), config: { ...project().config, target: "wasix" } },
      "unsupported for built-in language 'python'",
    ],
    [
      "invalid optimization",
      { ...project(), config: { ...project().config, optimization: "fast" } },
      "Project optimization must be 'debug' or 'release'",
    ],
    [
      "non-string argument",
      { ...project(), config: { ...project().config, args: [1] } },
      "Project arguments must contain only strings",
    ],
    ["non-string stdin", { ...project(), config: { ...project().config, stdin: 7 } }, "stdin must be a string"],
    [
      "non-string environment value",
      { ...project(), config: { ...project().config, env: { MODE: true } } },
      "must be a NUL-free string",
    ],
    [
      "partial determinism",
      { ...project(), config: { ...project().config, determinism: { randomSeed: 1 } } },
      "Project determinism must contain exactly",
    ],
    [
      "coerced resource number",
      {
        ...project(),
        config: {
          ...project().config,
          resources: { ...DEFAULT_RESOURCE_POLICY, instructionBudget: "100" },
        },
      },
      "instructionBudget must be a positive safe integer",
    ],
    ["non-finite update time", { ...project(), updatedAt: Number.POSITIVE_INFINITY }, "non-negative finite number"],
  ])("rejects %s", (_label, candidate, message) => {
    expect(() => assertValidProject(candidate)).toThrow(message as string);
  });

  it("rejects sparse arrays and accessor-backed records as non-data shapes", () => {
    const sparseArguments = new Array<string>(1);
    expect(() => assertValidProject({
      ...project(),
      config: { ...project().config, args: sparseArguments },
    })).toThrow("dense array without custom properties");

    const environment = {} as Record<string, string>;
    Object.defineProperty(environment, "MODE", { enumerable: true, get: () => "judge" });
    expect(() => assertValidProject({
      ...project(),
      config: { ...project().config, env: environment },
    })).toThrow("must be an enumerable data property");
  });

  it("bounds source file count, per-file UTF-8 bytes, and aggregate source bytes", () => {
    const candidate = project();
    candidate.files = Array.from({ length: PROJECT_SOURCE_LIMITS.files + 1 }, (_, index) => ({
      path: `src/${index}.py`,
      language: "python",
      content: "",
    }));
    expect(() => assertValidProject(candidate)).toThrow("cannot contain more than 256 source files");

    candidate.files = [{
      path: "src/main.py",
      language: "python",
      content: "🙂".repeat(Math.floor(PROJECT_SOURCE_LIMITS.bytesPerFile / 4) + 1),
    }];
    candidate.config.entry = "src/main.py";
    candidate.activeFile = "src/main.py";
    expect(() => assertValidProject(candidate)).toThrow("byte source limit");

    const sharedMaximumFile = "a".repeat(PROJECT_SOURCE_LIMITS.bytesPerFile);
    candidate.files = Array.from({ length: 5 }, (_, index) => ({
      path: `src/${index}.py`,
      language: "python",
      content: index === 4 ? "a" : sharedMaximumFile,
    }));
    candidate.config.entry = "src/0.py";
    candidate.activeFile = "src/0.py";
    expect(() => assertValidProject(candidate)).toThrow("byte total limit");
  });
});
