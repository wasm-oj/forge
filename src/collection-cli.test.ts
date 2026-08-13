import { link, mkdtemp, mkdir, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonBytes } from "./core/canonical-json";
import {
  BROWSER_PROBLEM_SCHEMA,
  problemCollectionRevision,
  type ProblemCollectionIndex,
} from "./judge/problem-catalog-loader";
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

async function writeBasicCollection(root: string): Promise<void> {
  await mkdir(path.join(root, "authoring"), { recursive: true });
  await mkdir(path.join(root, "statements"), { recursive: true });
  await mkdir(path.join(root, "collection"), { recursive: true });
  const problem = PROBLEMS[0]!;
  await writeFile(path.join(root, "authoring/problem.json"), JSON.stringify({ problem, schema: BROWSER_PROBLEM_SCHEMA }));
  await writeFile(path.join(root, "statements/problem.en.md"), "# Example\n");
  await writeFile(path.join(root, "statements/problem.zh-TW.md"), "# 範例\n");
  await writeFile(path.join(root, "collection/source.json"), JSON.stringify({
    schema: "wasm-oj-browser-collection-source-v1",
    localization: { defaultLocale: "zh-TW", supportedLocales: ["zh-TW", "en"] },
    problems: [{
      statementPaths: { "zh-TW": "statements/problem.zh-TW.md", en: "statements/problem.en.md" },
      bundlePath: "authoring/problem.json",
    }],
  }));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("woj Organizer collection commands", () => {
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

    const indexFile = path.join(root, "collection/index.json");
    const indexBytes = new Uint8Array(await readFile(indexFile));
    const index = JSON.parse(new TextDecoder().decode(indexBytes)) as ProblemCollectionIndex;
    expect(indexBytes).toEqual(canonicalJsonBytes(index));
    expect(index.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(index.problems[0]?.bundle.path).toContain(index.problems[0]?.bundle.sha256);
    const publicBundleBytes = new Uint8Array(await readFile(path.join(root, "collection", index.problems[0]!.bundle.path)));
    const publicBundle = JSON.parse(new TextDecoder().decode(publicBundleBytes)) as {
      problem: { judgeCases: Array<{ kind: string }> };
    };
    expect(publicBundleBytes).toEqual(canonicalJsonBytes(publicBundle));
    expect(publicBundle.problem.judgeCases.every((testCase) => testCase.kind === "sample")).toBe(true);
    expect(publicBundle.problem.judgeCases.length).toBeLessThan(problem.judgeCases.length);

    await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`);
    await expect(runCollectionCli(["verify", root])).rejects.toThrow("collection/index.json is not canonical");

    const prettyBundleBytes = new TextEncoder().encode(`${JSON.stringify(publicBundle, null, 2)}\n`);
    const prettyBundleSha256 = await digest(prettyBundleBytes);
    const prettyBundlePath = index.problems[0]!.bundle.path.replace(index.problems[0]!.bundle.sha256, prettyBundleSha256);
    const indexWithPrettyBundle = {
      ...index,
      problems: [{
        ...index.problems[0]!,
        bundle: {
          path: prettyBundlePath,
          sha256: prettyBundleSha256,
          bytes: prettyBundleBytes.byteLength,
        },
      }],
    };
    const rewrittenIndex = {
      ...indexWithPrettyBundle,
      revision: await problemCollectionRevision(indexWithPrettyBundle),
    };
    await writeFile(path.join(root, "collection", prettyBundlePath), prettyBundleBytes);
    await writeFile(indexFile, canonicalJsonBytes(rewrittenIndex));
    await expect(runCollectionCli(["verify", root])).rejects.toThrow(`${prettyBundlePath} is not canonical`);
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

  it.each([
    ["collection/source.json", "collection/source.json", undefined, undefined],
    ["collection/Source.json", "collection/source.json", undefined, undefined],
    ["collection/index.json", "collection/source.json", "collection/managed-source.json", "collection/managed-source.json"],
  ])("rejects declared input/output overlap before changing the input", async (indexPath, sourcePath, managedPath, managedSourcePath) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-collection-overlap-test-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "collection"), { recursive: true });
    await writeFile(path.join(root, sourcePath), "source sentinel\n");
    if (managedSourcePath) await writeFile(path.join(root, managedSourcePath), "managed sentinel\n");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const arguments_ = ["build", root, "--index", indexPath, "--source", sourcePath];
    if (managedPath && managedSourcePath) arguments_.push("--managed", managedPath, "--managed-source", managedSourcePath);
    await expect(runCollectionCli(arguments_)).rejects.toThrow("must not be the same input and output path");
    expect(await readFile(path.join(root, managedSourcePath ?? sourcePath), "utf8")).toContain("sentinel");
  });

  it.runIf(process.platform === "darwin")("rejects an APFS Unicode alias between a declared source and output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-collection-apfs-alias-test-"));
    temporaryDirectories.push(root);
    await writeBasicCollection(root);
    const source = path.join(root, "collection/source.json");
    const longS = path.join(root, "collection/ſ.json");
    await rename(source, longS);
    const original = new Uint8Array(await readFile(longS));
    await expect(runCollectionCli([
      "build", root,
      "--source", "collection/ſ.json",
      "--index", "collection/s.json",
    ])).rejects.toThrow("aliases declared input");
    expect(new Uint8Array(await readFile(longS))).toEqual(original);
  });

  it("requires configurable output paths to use portable ASCII segments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-collection-portable-output-test-"));
    temporaryDirectories.push(root);
    await writeBasicCollection(root);
    await expect(runCollectionCli(["build", root, "--index", "collection/索引.json"])).rejects.toThrow("portable ASCII");
    expect(await readFile(path.join(root, "collection/source.json"), "utf8")).toContain("wasm-oj-browser-collection-source-v1");
  });

  it("rejects sparse oversized source and index files before allocating or writing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-collection-sparse-test-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "collection"), { recursive: true });
    const source = path.join(root, "collection/source.json");
    await writeFile(source, "{}");
    await truncate(source, 2 * 1024 * 1024 + 1);
    await expect(runCollectionCli(["build", root])).rejects.toThrow("allowed byte limit");
    expect(await readFile(source)).toHaveLength(2 * 1024 * 1024 + 1);
    const index = path.join(root, "collection/index.json");
    await writeFile(index, "{}");
    await truncate(index, 512 * 1024 + 1);
    await expect(runCollectionCli(["verify", root])).rejects.toThrow("allowed byte limit");
  });

  it("allows unrelated repository symlinks while fencing declared paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-collection-unrelated-link-test-"));
    temporaryDirectories.push(root);
    const outside = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-collection-unrelated-target-"));
    temporaryDirectories.push(outside);
    await writeBasicCollection(root);
    await symlink(outside, path.join(root, "node_modules"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCollectionCli(["build", root]);
    await runCollectionCli(["verify", root]);
  });

  it("atomically replaces a hardlinked generated bundle without truncating its peer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-collection-hardlink-test-"));
    temporaryDirectories.push(root);
    await writeBasicCollection(root);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCollectionCli(["build", root]);
    const index = JSON.parse(await readFile(path.join(root, "collection/index.json"), "utf8")) as ProblemCollectionIndex;
    const output = path.join(root, "collection", index.problems[0]!.bundle.path);
    const sentinel = path.join(root, "sentinel.txt");
    await writeFile(sentinel, "hardlink sentinel\n");
    await rm(output);
    await link(sentinel, output);
    await runCollectionCli(["build", root]);
    expect(await readFile(sentinel, "utf8")).toBe("hardlink sentinel\n");
    expect(await readFile(output, "utf8")).not.toBe("hardlink sentinel\n");
  });
});
