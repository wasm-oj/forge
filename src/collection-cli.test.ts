import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PROBLEM_SCHEMA } from "./judge/problem-catalog-loader";
import { PROBLEMS } from "./judge/problems";
import { runCollectionCli } from "./collection-cli";
import { parseRepositoryProblems, parseRepositoryRoot } from "./online-judge/repository-contract";

const temporaryDirectories: string[] = [];

async function repositoryFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-repository-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "authoring"), { recursive: true });
  await mkdir(path.join(root, "collection"), { recursive: true });
  const problem = PROBLEMS[0]!;
  await writeFile(path.join(root, "authoring/problem.json"), JSON.stringify({ schema: BROWSER_PROBLEM_SCHEMA, problem }));
  await writeFile(path.join(root, "collection/source.json"), JSON.stringify({
    schema: "wasm-oj-platform/repository-authoring/v1",
    problems: [{
      slug: problem.id,
      order: 1,
      title: problem.title,
      summary: { "zh-TW": "測試題目", en: "Test problem" },
      practiceEnabled: true,
      authoringBundle: "authoring/problem.json",
      allowedProfiles: { c: { target: "wasip1", optimization: "release" } },
      judge: { kind: "text" },
    }],
    contests: [],
  }));
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("repository collection authoring", () => {
  it("builds root, problem, contest, public, and WOJJDG02 artifacts then verifies them", async () => {
    const root = await repositoryFixture();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCollectionCli(["build", root]);
    await runCollectionCli(["verify", root]);
    const repository = parseRepositoryRoot(new Uint8Array(await readFile(path.join(root, "wasm-oj.json"))));
    const problems = parseRepositoryProblems(new Uint8Array(await readFile(path.join(root, repository.problems))));
    expect(problems.problems).toHaveLength(1);
    expect(problems.problems[0]?.judgePackage.path).toMatch(/\.wasmojjudge$/);
  });

  it("accepts non-canonical manifest JSON but fails closed on descriptor corruption", async () => {
    const root = await repositoryFixture();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCollectionCli(["build", root]);
    const manifestPath = path.join(root, "collection/problems.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      problems: Array<{
        practiceBundle: { path: string };
        contestBundle: { path: string; bytes: number; sha256: string };
      }>;
    };
    const contestDescriptor = manifest.problems[0]!.contestBundle;
    const contestValue = JSON.parse(await readFile(path.join(root, contestDescriptor.path), "utf8")) as unknown;
    const nonCanonicalContest = Buffer.from(`${JSON.stringify(contestValue, null, 2)}\n`);
    await writeFile(path.join(root, contestDescriptor.path), nonCanonicalContest);
    contestDescriptor.bytes = nonCanonicalContest.byteLength;
    contestDescriptor.sha256 = createHash("sha256").update(nonCanonicalContest).digest("hex");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await runCollectionCli(["verify", root]);
    await writeFile(path.join(root, manifest.problems[0]!.practiceBundle.path), "tampered\n");
    await expect(runCollectionCli(["verify", root])).rejects.toThrow("invalid size");
  });
});
