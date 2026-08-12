import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonBytes } from "./core/canonical-json";
import { BROWSER_PROBLEM_SCHEMA } from "./judge/problem-catalog-loader";
import { PROBLEMS } from "./judge/problems";
import { validateJudgePackage } from "./online-judge/judge-package";
import { runCollectionCli } from "./collection-cli";

const temporaryDirectories: string[] = [];
const TRUSTED_COMMAND_WASM = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x13, 0x02,
  0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
  0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00,
  0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
]);

async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("wasm-oj-collection CLI", () => {
  it("consumes the shared WOJJDG02 v2 golden vector", async () => {
    const hex = (await readFile(new URL("../testdata/wojjdg02-v2-text.hex", import.meta.url), "utf8")).trim();
    if (!/^(?:[0-9a-f]{2})+$/.test(hex)) throw new Error("WOJJDG02 golden vector is not lowercase hexadecimal.");
    const validated = await validateJudgePackage(new Uint8Array(Buffer.from(hex, "hex")));
    expect(validated.bytes).toBe(863);
    expect(validated.executionSemanticSha256).toBe("0039034e813284b1a22fa6c11c1351097cb9141e5954f03f1b2bea98a9b5f12e");
  });

  it("builds and verifies a canonical collection with the browser parser", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-collection-test-"));
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

    await runCollectionCli([
      "build",
      root,
      "--source",
      "collection-source.json",
    ]);
    await runCollectionCli(["verify", root]);

    const index = JSON.parse(await readFile(path.join(root, "collection/index.json"), "utf8")) as {
      revision: string;
      problems: Array<{ bundle: { path: string; sha256: string } }>;
    };
    expect(index.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(index.problems[0]?.bundle.path).toContain(index.problems[0]?.bundle.sha256);
    const publicBundle = JSON.parse(await readFile(
      path.join(root, "collection", index.problems[0]!.bundle.path),
      "utf8",
    )) as { problem: { judgeCases: Array<{ kind: string }> } };
    expect(publicBundle.problem.judgeCases.every((testCase) => testCase.kind === "sample")).toBe(true);
    expect(publicBundle.problem.judgeCases.length).toBeLessThan(problem.judgeCases.length);
  });

  it("fails verification after published bytes are changed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-collection-test-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "collection/problems"), { recursive: true });
    await writeFile(path.join(root, "collection/index.json"), "{}\n");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(runCollectionCli(["verify", root])).rejects.toThrow("invalid shape");
  });

  it("rejects an external source bundle that omits required starter templates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-collection-old-bundle-test-"));
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

    await expect(runCollectionCli([
      "build",
      root,
      "--source",
      "collection-source.json",
    ])).rejects.toThrow("invalid shape");
  });

  it("builds and verifies immutable managed v2 projections from prebuilt inputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-managed-collection-test-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "authoring"), { recursive: true });
    await mkdir(path.join(root, "statements"), { recursive: true });
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
    const checkerAsset = new Uint8Array([0, 255, 1, 2]);
    await writeFile(path.join(root, "judge/checker.wasm"), TRUSTED_COMMAND_WASM);
    await writeFile(path.join(root, "judge/policy.bin"), checkerAsset);
    await writeFile(path.join(root, "collection/managed-source.json"), JSON.stringify({
      schema: "wasm-oj-platform/managed-collection-source/v1",
      problems: [{
        slug: problem.id,
        allowedProfiles: { c: { target: "wasip1", optimization: "release" } },
        judge: {
          kind: "checker",
          artifact: {
            path: "judge/checker.wasm",
            bytes: TRUSTED_COMMAND_WASM.byteLength,
            sha256: await digest(TRUSTED_COMMAND_WASM),
            runtimeProfile: "c-wasip1-release",
          },
          assets: [{
            path: "judge/policy.bin",
            guestPath: "/checker/assets/policy.bin",
            bytes: checkerAsset.byteLength,
            sha256: await digest(checkerAsset),
          }],
          args: ["/checker/assets/policy.bin"],
        },
      }],
    }));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCollectionCli(["build", root, "--managed-source", "collection/managed-source.json"]);
    await runCollectionCli(["verify", root, "--managed", "collection/managed.json"]);

    const managed = JSON.parse(await readFile(path.join(root, "collection/managed.json"), "utf8")) as {
      schema: string;
      problems: Array<{
        allowedProfiles: { c: { target: "wasip1"; optimization: "debug" | "release" } };
        contestPublic: { repositoryPath: string };
        judgePackage: { repositoryPath: string };
      }>;
    };
    expect(managed.schema).toBe("wasm-oj-platform/managed-collection/v2");
    expect(managed.problems[0]?.contestPublic.repositoryPath).toMatch(/^managed\/.+\.contest\.json$/);
    expect(managed.problems[0]?.judgePackage.repositoryPath).toMatch(/^managed\/.+\.wasmojjudge$/);
    const initialPackage = await validateJudgePackage(new Uint8Array(await readFile(
      path.join(root, "collection", managed.problems[0]!.judgePackage.repositoryPath),
    )), {
      expectedSha256: await digest(new Uint8Array(await readFile(
        path.join(root, "collection", managed.problems[0]!.judgePackage.repositoryPath),
      ))),
    });
    expect(initialPackage.judgeData.cases).toHaveLength(problem.judgeCases.length);

    const originalManagedBytes = new Uint8Array(await readFile(path.join(root, "collection/managed.json")));
    managed.problems[0]!.allowedProfiles.c.optimization = "debug";
    await writeFile(path.join(root, "collection/managed.json"), canonicalJsonBytes(managed));
    await expect(runCollectionCli(["verify", root, "--managed", "collection/managed.json"])).rejects.toThrow("allowedProfiles disagree");
    await writeFile(path.join(root, "collection/managed.json"), originalManagedBytes);

    // Source inputs are author-only after build; verification reads only published objects.
    await writeFile(path.join(root, "judge/policy.bin"), "tampered\n");
    await runCollectionCli(["verify", root, "--managed", "collection/managed.json"]);

    const packagePath = managed.problems[0]!.judgePackage.repositoryPath;
    const packageFile = path.join(root, "collection", packagePath);
    const packageBytes = new Uint8Array(await readFile(packageFile));
    packageBytes[packageBytes.byteLength - 1] ^= 1;
    await writeFile(packageFile, packageBytes);
    await expect(runCollectionCli(["verify", root, "--managed", "collection/managed.json"])).rejects.toThrow("integrity verification");
  });
});
