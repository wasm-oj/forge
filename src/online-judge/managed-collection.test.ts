import { describe, expect, it } from "vitest";
import { parseManagedCollectionContract } from "./managed-collection";

function contract() {
  return {
    schema: "forge-managed-collection-v1",
    collectionRevision: "a".repeat(64),
    problems: [{
      id: "sum-two",
      allowedLanguages: ["c", "rust"],
      references: ["c", "rust"].map((language) => ({
        language,
        target: "wasip1",
        optimization: "release",
        entry: language === "c" ? "main.c" : "main.rs",
        files: [{
          path: language === "c" ? "main.c" : "main.rs",
          repositoryPath: `problems/sum-two/solutions/${language}/${language === "c" ? "main.c" : "main.rs"}`,
          bytes: 100,
          sha256: "b".repeat(64),
        }],
      })),
      judge: { kind: "text" },
    }],
  };
}

describe("managed collection contract", () => {
  it("accepts one integrity-addressed reference per allowed language", () => {
    expect(parseManagedCollectionContract(contract()).problems[0]?.references).toHaveLength(2);
  });

  it("rejects missing references and repository path traversal", () => {
    expect(() => parseManagedCollectionContract({
      ...contract(),
      problems: [{ ...contract().problems[0], references: contract().problems[0]?.references.slice(0, 1) }],
    })).toThrow("exactly one reference");
    const traversed = contract();
    const file = traversed.problems[0]?.references[0]?.files[0];
    if (!file) throw new Error("fixture is missing");
    file.repositoryPath = "../secret";
    expect(() => parseManagedCollectionContract(traversed)).toThrow("normalized relative");
  });

  it("rejects undeclared judge implementations instead of guessing a fallback", () => {
    expect(() => parseManagedCollectionContract({
      ...contract(),
      problems: [{ ...contract().problems[0], judge: { kind: "shell" } }],
    })).toThrow("unsupported judge kind");
  });

  it.each(["checker", "interactive"] as const)("accepts an integrity-addressed %s program and runtime assets", (kind) => {
    const value = contract();
    value.problems[0]!.judge = {
      kind,
      ...(kind === "interactive" ? { inputPath: "/interactor/input/case.txt" } : {}),
      program: {
        language: "c",
        target: "wasip1",
        optimization: "release",
        entry: "judge.c",
        files: [{
          path: "judge.c",
          repositoryPath: `problems/sum-two/${kind}/judge.c`,
          bytes: 101,
          sha256: "c".repeat(64),
        }],
        assets: [{
          path: kind === "checker" ? "/checker/assets/policy.dat" : "/interactor/assets/policy.dat",
          repositoryPath: `problems/sum-two/${kind}/policy.dat`,
          bytes: 17,
          sha256: "d".repeat(64),
        }],
        args: [kind === "checker" ? "/checker/assets/policy.dat" : "/interactor/assets/policy.dat"],
      },
    } as never;
    const parsed = parseManagedCollectionContract(value);
    expect(parsed.problems[0]?.judge.kind).toBe(kind);
  });

  it("rejects prebuilt and runtime-bundle judge programs at the schema boundary", () => {
    const value = contract();
    value.problems[0]!.judge = {
      kind: "checker",
      program: {
        language: "python",
        target: "wasip1",
        optimization: "release",
        entry: "checker.py",
        files: [{ path: "checker.py", repositoryPath: "checker.py", bytes: 10, sha256: "c".repeat(64) }],
        assets: [],
        args: [],
      },
    } as never;
    expect(() => parseManagedCollectionContract(value)).toThrow("standalone Wasm");
  });

  it("keeps trusted assets in role-specific guest namespaces", () => {
    const value = contract();
    value.problems[0]!.judge = {
      kind: "checker",
      program: {
        language: "c",
        target: "wasip1",
        optimization: "release",
        entry: "checker.c",
        files: [{ path: "checker.c", repositoryPath: "checker.c", bytes: 10, sha256: "c".repeat(64) }],
        assets: [{ path: "/interactor/assets/leak", repositoryPath: "secret", bytes: 10, sha256: "d".repeat(64) }],
        args: [],
      },
    } as never;
    expect(() => parseManagedCollectionContract(value)).toThrow("/checker/assets/");
  });
});
