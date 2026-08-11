import { describe, expect, it } from "vitest";
import { canonicalJsonBytes } from "../core/canonical-json";
import { sha256Hex } from "../core/sha256";
import {
  BROWSER_COLLECTION_SCHEMA,
  BROWSER_PROBLEM_SCHEMA,
  problemCollectionRevision,
} from "../judge/problem-catalog-loader";
import { PROBLEMS } from "../judge/problems";
import {
  createForgeValidationSource,
  forgeValidationSourceBytes,
  parseForgeValidationSource,
  VALIDATION_SOURCE_SCHEMA,
  verifyForgeValidationSourceBytes,
  verifyForgeValidationSourceObjects,
} from "./validation-source";

const ref = (character: string, repositoryPath: string) => ({ bytes: 1, repositoryPath, sha256: character.repeat(64) });

function fixture() {
  return {
    schema: VALIDATION_SOURCE_SCHEMA,
    provenance: { provider: "github", githubRepositoryId: 1, commitSha: "a".repeat(40), indexPath: "collection/index.json", archiveSha256: "f".repeat(64) },
    collectionRevision: "e".repeat(64),
    index: ref("1", "collection/index.json"),
    managed: ref("2", "collection/managed.json"),
    problems: [{
      id: "sum-two",
      bundle: ref("3", "collection/problems/sum.3.json"),
      references: [{ language: "c", target: "wasip1", optimization: "release", entry: "main.c", files: [{ path: "main.c", ...ref("4", "problems/sum/main.c") }] }],
      judge: { kind: "text" },
    }],
    objects: ["1", "2", "3", "4"].map((character) => ({ bytes: 1, sha256: character.repeat(64) })),
  };
}

describe("canonical validation source", () => {
  it("contains exactly its declared content-addressed object graph", async () => {
    const source = parseForgeValidationSource(fixture());
    await expect(verifyForgeValidationSourceBytes(forgeValidationSourceBytes(source))).resolves.toEqual(source);
    await expect(verifyForgeValidationSourceBytes(new TextEncoder().encode("not-json"), "0".repeat(64))).rejects.toThrow("expected digest");
  });

  it("rejects undeclared bytes and reordered object inventories", () => {
    const value = fixture();
    value.objects.push({ bytes: 1, sha256: "5".repeat(64) });
    expect(() => parseForgeValidationSource(value)).toThrow("exactly its declared bytes");
    const reordered = fixture();
    reordered.objects.reverse();
    expect(() => parseForgeValidationSource(reordered)).toThrow("canonical digest order");
  });

  it("binds custom judge source and assets into the exact object graph", () => {
    const value = fixture();
    value.problems[0]!.judge = {
      kind: "checker",
      program: {
        language: "c",
        target: "wasip1",
        optimization: "release",
        entry: "checker.c",
        files: [{ path: "checker.c", ...ref("5", "problems/sum/checker.c") }],
        assets: [{ path: "/checker/assets/policy.dat", ...ref("6", "problems/sum/policy.dat") }],
        args: ["/checker/assets/policy.dat"],
      },
    } as never;
    value.objects.push(
      { bytes: 1, sha256: "5".repeat(64) },
      { bytes: 1, sha256: "6".repeat(64) },
    );
    expect(parseForgeValidationSource(value).problems[0]?.judge).toMatchObject({ kind: "checker" });

    const hiddenAssetMissing = structuredClone(value);
    hiddenAssetMissing.objects.pop();
    expect(() => parseForgeValidationSource(hiddenAssetMissing)).toThrow("exactly its declared bytes");
  });

  it("rejects judge assets outside their role-specific namespace", () => {
    const value = fixture();
    value.problems[0]!.judge = {
      kind: "interactive",
      inputPath: "/interactor/input/case.txt",
      program: {
        language: "c",
        target: "wasip1",
        optimization: "release",
        entry: "interactor.c",
        files: [{ path: "interactor.c", ...ref("5", "problems/sum/interactor.c") }],
        assets: [{ path: "/checker/assets/leak.dat", ...ref("6", "problems/sum/secret.dat") }],
        args: [],
      },
    } as never;
    value.objects.push(
      { bytes: 1, sha256: "5".repeat(64) },
      { bytes: 1, sha256: "6".repeat(64) },
    );
    expect(() => parseForgeValidationSource(value)).toThrow("/interactor/assets/");
  });

  it("extracts and reconstructs only explicitly declared checker source and assets", async () => {
    const problem = PROBLEMS[0]!;
    const bundle = canonicalJsonBytes({ schema: BROWSER_PROBLEM_SCHEMA, problem });
    const bundleSha256 = await sha256Hex(bundle);
    const withoutRevision = {
      schema: BROWSER_COLLECTION_SCHEMA,
      problemSchema: BROWSER_PROBLEM_SCHEMA,
      localization: { defaultLocale: "zh-TW", supportedLocales: ["zh-TW", "en"] },
      problems: [{
        id: problem.id,
        number: problem.number,
        title: problem.title,
        trackId: problem.trackId,
        track: problem.track,
        statementPaths: { "zh-TW": "statements/problem.zh-TW.md", en: "statements/problem.en.md" },
        difficulty: problem.difficulty,
        tags: problem.tags,
        caseCount: problem.judgeCases.length,
        bundle: { path: `problems/${problem.id}.${bundleSha256}.json`, sha256: bundleSha256, bytes: bundle.byteLength },
      }],
    } as const;
    const index = { ...withoutRevision, revision: await problemCollectionRevision(withoutRevision) };
    const reference = new TextEncoder().encode("int main(void) { return 0; }\n");
    const checker = new TextEncoder().encode("int main(void) { return 0; }\n");
    const asset = new Uint8Array([0, 255, 1, 2]);
    const managed = {
      schema: "forge-managed-collection-v1",
      collectionRevision: index.revision,
      problems: [{
        id: problem.id,
        allowedLanguages: ["c"],
        references: [{
          language: "c",
          target: "wasip1",
          optimization: "release",
          entry: "main.c",
          files: [{ path: "main.c", repositoryPath: "reference/main.c", bytes: reference.byteLength, sha256: await sha256Hex(reference) }],
        }],
        judge: {
          kind: "checker",
          program: {
            language: "c",
            target: "wasip1",
            optimization: "release",
            entry: "checker.c",
            files: [{ path: "checker.c", repositoryPath: "judge/checker.c", bytes: checker.byteLength, sha256: await sha256Hex(checker) }],
            assets: [{ path: "/checker/assets/policy.bin", repositoryPath: "judge/policy.bin", bytes: asset.byteLength, sha256: await sha256Hex(asset) }],
            args: ["/checker/assets/policy.bin"],
          },
        },
      }],
    };
    const repositoryFiles = new Map<string, Uint8Array>([
      ["collection/index.json", canonicalJsonBytes(index)],
      [`collection/problems/${problem.id}.${bundleSha256}.json`, bundle],
      ["collection/managed.json", canonicalJsonBytes(managed)],
      ["reference/main.c", reference],
      ["judge/checker.c", checker],
      ["judge/policy.bin", asset],
      ["undeclared/ignored.sh", new TextEncoder().encode("exit 1\n")],
    ]);
    const created = await createForgeValidationSource({
      githubRepositoryId: 123,
      commitSha: "a".repeat(40),
      indexPath: "collection/index.json",
      archiveSha256: "b".repeat(64),
    }, repositoryFiles);
    expect(created.source.problems[0]?.judge).toMatchObject({
      kind: "checker",
      program: {
        files: [{ repositoryPath: "judge/checker.c", bytes: checker.byteLength }],
        assets: [{ path: "/checker/assets/policy.bin", repositoryPath: "judge/policy.bin", bytes: asset.byteLength }],
      },
    });
    expect([...created.source.problems.flatMap((item) => item.judge.kind === "text" ? [] : [
      ...item.judge.program.files,
      ...item.judge.program.assets,
    ]).map((item) => item.repositoryPath)]).not.toContain("undeclared/ignored.sh");
    const verified = await verifyForgeValidationSourceObjects(created.source, created.objects);
    expect(verified.repositoryFiles.get("judge/policy.bin")).toEqual(asset);
    expect(verified.repositoryFiles.has("undeclared/ignored.sh")).toBe(false);
  });
});
