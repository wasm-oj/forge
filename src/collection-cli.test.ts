import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PROBLEM_SCHEMA } from "./judge/problem-catalog-loader";
import { PROBLEMS } from "./judge/problems";
import { runForgeCollectionCli } from "./collection-cli";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("forge-collection CLI", () => {
  it("builds and verifies a canonical collection with the browser parser", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-collection-test-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "authoring"), { recursive: true });
    await mkdir(path.join(root, "statements"), { recursive: true });
    const problem = PROBLEMS[0];
    await writeFile(path.join(root, "authoring/problem.json"), JSON.stringify({
      problem,
      schema: BROWSER_PROBLEM_SCHEMA,
    }));
    await writeFile(path.join(root, "statements/problem.en.md"), "# Example\n");
    await writeFile(path.join(root, "statements/problem.zh-TW.md"), "# 範例\n");
    await writeFile(path.join(root, "collection-source.json"), JSON.stringify({
      schema: "wasm-oj-browser-collection-source-v1",
      localization: { defaultLocale: "zh-TW", supportedLocales: ["zh-TW", "en"] },
      problems: [{
        statementPaths: {
          "zh-TW": "statements/problem.zh-TW.md",
          en: "statements/problem.en.md",
        },
        bundlePath: "authoring/problem.json",
      }],
    }));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runForgeCollectionCli([
      "build",
      root,
      "--source",
      "collection-source.json",
    ]);
    await runForgeCollectionCli(["verify", root]);

    const index = JSON.parse(await readFile(path.join(root, "collection/index.json"), "utf8")) as {
      revision: string;
      problems: Array<{ bundle: { path: string; sha256: string } }>;
    };
    expect(index.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(index.problems[0]?.bundle.path).toContain(index.problems[0]?.bundle.sha256);
  });

  it("fails verification after published bytes are changed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-collection-test-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "collection/problems"), { recursive: true });
    await writeFile(path.join(root, "collection/index.json"), "{}\n");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(runForgeCollectionCli(["verify", root])).rejects.toThrow("invalid shape");
  });

  it("rejects an external source bundle that omits required starter templates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-collection-old-bundle-test-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "authoring"), { recursive: true });
    await mkdir(path.join(root, "statements"), { recursive: true });
    const oldProblem: Record<string, unknown> = { ...PROBLEMS[0] };
    delete oldProblem.starterTemplates;
    await writeFile(path.join(root, "authoring/problem.json"), JSON.stringify({
      schema: BROWSER_PROBLEM_SCHEMA,
      problem: oldProblem,
    }));
    await writeFile(path.join(root, "statements/problem.en.md"), "# Example\n");
    await writeFile(path.join(root, "statements/problem.zh-TW.md"), "# 範例\n");
    await writeFile(path.join(root, "collection-source.json"), JSON.stringify({
      schema: "wasm-oj-browser-collection-source-v1",
      localization: { defaultLocale: "zh-TW", supportedLocales: ["zh-TW", "en"] },
      problems: [{
        statementPaths: {
          "zh-TW": "statements/problem.zh-TW.md",
          en: "statements/problem.en.md",
        },
        bundlePath: "authoring/problem.json",
      }],
    }));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runForgeCollectionCli([
      "build",
      root,
      "--source",
      "collection-source.json",
    ])).rejects.toThrow("invalid shape");
  });

  it("verifies the managed contract and reference source with the shared parser", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-managed-collection-test-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "authoring"), { recursive: true });
    await mkdir(path.join(root, "statements"), { recursive: true });
    await mkdir(path.join(root, "references"), { recursive: true });
    await mkdir(path.join(root, "judge"), { recursive: true });
    await mkdir(path.join(root, "collection"), { recursive: true });
    const problem = PROBLEMS[0];
    await writeFile(path.join(root, "authoring/problem.json"), JSON.stringify({ problem, schema: BROWSER_PROBLEM_SCHEMA }));
    await writeFile(path.join(root, "statements/problem.en.md"), "# Example\n");
    await writeFile(path.join(root, "statements/problem.zh-TW.md"), "# 範例\n");
    await writeFile(path.join(root, "collection/source.json"), JSON.stringify({
      schema: "wasm-oj-browser-collection-source-v1",
      localization: { defaultLocale: "zh-TW", supportedLocales: ["zh-TW", "en"] },
      problems: [{ statementPaths: { "zh-TW": "statements/problem.zh-TW.md", en: "statements/problem.en.md" }, bundlePath: "authoring/problem.json" }],
    }));
    const reference = new TextEncoder().encode("int main(void) { return 0; }\n");
    const checker = new TextEncoder().encode("int main(void) { return 0; }\n");
    const checkerAsset = new Uint8Array([0, 255, 1, 2]);
    await writeFile(path.join(root, "references/main.c"), reference);
    await writeFile(path.join(root, "judge/checker.c"), checker);
    await writeFile(path.join(root, "judge/policy.bin"), checkerAsset);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runForgeCollectionCli(["build", root]);
    const index = JSON.parse(await readFile(path.join(root, "collection/index.json"), "utf8")) as { revision: string };
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", reference)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const checkerDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", checker)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const checkerAssetDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", checkerAsset)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await writeFile(path.join(root, "collection/managed.json"), JSON.stringify({
      schema: "forge-managed-collection-v1",
      collectionRevision: index.revision,
      problems: [{
        id: problem.id,
        allowedLanguages: ["c"],
        references: [{ language: "c", target: "wasip1", optimization: "release", entry: "main.c", files: [{ path: "main.c", repositoryPath: "references/main.c", bytes: reference.byteLength, sha256: digest }] }],
        judge: {
          kind: "checker",
          program: {
            language: "c",
            target: "wasip1",
            optimization: "release",
            entry: "checker.c",
            files: [{ path: "checker.c", repositoryPath: "judge/checker.c", bytes: checker.byteLength, sha256: checkerDigest }],
            assets: [{ path: "/checker/assets/policy.bin", repositoryPath: "judge/policy.bin", bytes: checkerAsset.byteLength, sha256: checkerAssetDigest }],
            args: ["/checker/assets/policy.bin"],
          },
        },
      }],
    }));
    await runForgeCollectionCli(["verify", root, "--managed", "collection/managed.json"]);
    await writeFile(path.join(root, "judge/policy.bin"), "tampered\n");
    await expect(runForgeCollectionCli(["verify", root, "--managed", "collection/managed.json"])).rejects.toThrow("checker asset");
    await writeFile(path.join(root, "judge/policy.bin"), checkerAsset);
    await writeFile(path.join(root, "references/main.c"), "tampered\n");
    await expect(runForgeCollectionCli(["verify", root, "--managed", "collection/managed.json"])).rejects.toThrow("integrity verification");
  });
});
