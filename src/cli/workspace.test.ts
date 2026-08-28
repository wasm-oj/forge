import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace, parseWorkspace, WOJ_WORKSPACE_SCHEMA } from "./workspace";
import { CliError } from "./errors";

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});
describe("woj workspace pins", () => {
  it("creates a local workspace with the real WASI target vocabulary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "woj-workspace-"));
    temporary.push(root);
    const workspace = await createWorkspace(root, { language: "rust" });
    expect(workspace.target).toBe("wasip1");
    expect(await readFile(path.join(root, "main.rs"), "utf8")).toContain("fn main");
  });

  it("requires a stable problem and exact catalog commit for pulled problems", () => {
    const workspace = parseWorkspace({
      schema: WOJ_WORKSPACE_SCHEMA,
      name: "pinned",
      language: "cpp",
      target: "wasix",
      optimization: "release",
      entry: "main.cpp",
      sources: ["main.cpp"],
      problem: {
        problemId: "11111111-1111-4111-8111-111111111111",
        catalogCommit: "a".repeat(40),
        serverOrigin: "https://judge.example",
        contentUrl: "/api/problems/11111111-1111-4111-8111-111111111111/content?role=practice",
        contentSha256: "a".repeat(64),
        contentFile: "problem.json",
        context: { kind: "practice" },
        locale: "zh-TW",
      },
    });
    expect(workspace.problem?.catalogCommit).toBe("a".repeat(40));
    expect(workspace.problem?.serverOrigin).toBe("https://judge.example");
  });

  it("maps obsolete or malformed workspace schemas to integrity exit 4", () => {
    try {
      parseWorkspace({ schema: WOJ_WORKSPACE_SCHEMA, name: "old", language: "cpp", target: "wasm32-wasi", optimization: "debug", entry: "main.cpp", sources: ["main.cpp"] });
      throw new Error("expected parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(4);
    }
  });
});
