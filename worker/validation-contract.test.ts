import { describe, expect, it } from "vitest";
import { PROBLEMS } from "../src/judge/problems";
import type { ForgeValidationSource, VerifiedValidationSource } from "../src/online-judge/validation-source";
import { parseExecuteRequest } from "./container-job";
import {
  githubRepositoryCoordinates,
  parseValidationReport,
  parseValidationWorkflowParameters,
  parseValidationWorkflowResult,
  trustedGithubArchiveRedirect,
  verifyManagedProjectionBindings,
  type ValidationObjectReference,
} from "./validation-contract";

const IMPORT_ID = "00000000-0000-4000-8000-000000000001";
const PREDECESSOR_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const RELEASE_ID = "00000000-0000-4000-8000-000000000004";
const COMMIT = "a".repeat(40);
const MANIFEST = "b".repeat(64);
const IDENTITY = "c".repeat(64);
const TOKEN = "d".repeat(43);

function ref(character: string, bytes = 100): ValidationObjectReference {
  const digest = character.repeat(64);
  return { key: `snapshots/objects/${digest}`, digest, bytes };
}

function canonicalParameters() {
  return {
    importId: IMPORT_ID,
    expectedReleaseId: RELEASE_ID,
    expectedManifestSha256: MANIFEST,
    expectedContainerIdentitySha256: IDENTITY,
  } as const;
}

function resultFixture(schema: "forge-validation-workflow-result-v1" | "forge-collection-validation-report-v1") {
  const problem = PROBLEMS[0]!;
  const core = {
    schema,
    importId: IMPORT_ID,
    sourceKind: "canonical-successor",
    forgeReleaseId: RELEASE_ID,
    collectionRevision: "2".repeat(64),
    canonicalSource: { manifest: ref("1"), objects: [ref("3")] },
    projections: { practice: ref("4"), contestPublic: ref("5"), judge: ref("6") },
    outputs: [{
      id: problem.id,
      number: problem.number,
      title: problem.title,
      difficulty: problem.difficulty,
      tags: problem.tags,
      trackId: problem.trackId,
      track: problem.track,
      bundleDigest: "7".repeat(64),
      allowedProfiles: { c: { target: "wasip1", optimization: "release" } },
      practice: ref("8"),
      contestPublic: ref("9"),
      judge: ref("a"),
    }],
  };
  return schema === "forge-validation-workflow-result-v1"
    ? { ...core, report: ref("b") }
    : { ...core, problemCount: 1, checks: ["canonical-successor-source", "public-hidden-projection"] };
}

const expectation = {
  importId: IMPORT_ID,
  sourceKind: "canonical-successor" as const,
  forgeReleaseId: RELEASE_ID,
  canonicalSourceSha256: "1".repeat(64),
};

describe("canonical successor protocol", () => {
  it("uses an exact opaque workflow reference without repository or Organizer context", () => {
    expect(parseValidationWorkflowParameters(canonicalParameters())).toEqual(canonicalParameters());
    expect(() => parseValidationWorkflowParameters({ ...canonicalParameters(), installationId: 99 })).toThrow("invalid shape");
    expect(() => parseValidationWorkflowParameters({
      ...canonicalParameters(),
      source: { kind: "canonical-successor", predecessorImportId: PREDECESSOR_ID },
    })).toThrow("invalid shape");
  });

  it("bounds the exact validation result and rejects role-swapped references", () => {
    expect(parseValidationWorkflowResult(resultFixture("forge-validation-workflow-result-v1"), expectation).outputs).toHaveLength(1);
    expect(() => parseValidationWorkflowResult({ ...resultFixture("forge-validation-workflow-result-v1"), privateBytes: "hidden" }, expectation)).toThrow("invalid shape");
    const swapped = structuredClone(resultFixture("forge-validation-workflow-result-v1"));
    swapped.outputs[0]!.contestPublic = swapped.outputs[0]!.judge;
    expect(() => parseValidationWorkflowResult(swapped, expectation)).toThrow("roles are not distinct");
  });

  it("rejects extra container keys and R2 keys not bound to immutable job coordinates", () => {
    const job = {
      kind: "validation",
      jobId: IMPORT_ID,
      attempt: 1,
      attemptToken: TOKEN,
      outputPrefix: "snapshots/objects",
      forgeReleaseId: RELEASE_ID,
      githubRepositoryId: 42,
      commitSha: COMMIT,
      indexPath: "collection/index.json",
      expectedReleaseId: RELEASE_ID,
      expectedManifestSha256: MANIFEST,
      expectedContainerIdentitySha256: IDENTITY,
      source: {
        kind: "canonical-successor",
        predecessorImportId: PREDECESSOR_ID,
        canonicalSourceR2Key: `snapshots/objects/${"1".repeat(64)}`,
        canonicalSourceSha256: "1".repeat(64),
      },
    } as const;
    expect(parseExecuteRequest(job).kind).toBe("validation");
    expect(() => parseExecuteRequest({ ...job, legacyArchiveKey: "imports/x" })).toThrow("invalid shape");
    expect(() => parseExecuteRequest({
      ...job,
      source: { ...job.source, canonicalSourceR2Key: `snapshots/objects/${"2".repeat(64)}` },
    })).toThrow("content addressed");
    expect(() => parseExecuteRequest({
      kind: "submission",
      jobId: IMPORT_ID,
      submissionId: IMPORT_ID,
      attempt: 1,
      attemptToken: TOKEN,
      expectedReleaseId: RELEASE_ID,
      expectedManifestSha256: MANIFEST,
      expectedContainerIdentitySha256: IDENTITY,
      expectedProblemBundleDigest: "1".repeat(64),
      sourceOwnerId: USER_ID,
      sourceR2Key: `sources/${USER_ID}/${PREDECESSOR_ID}.${"2".repeat(64)}.json`,
      sourceSha256: "2".repeat(64),
      judgeR2Key: `snapshots/objects/${"3".repeat(64)}`,
      judgeSha256: "3".repeat(64),
    })).toThrow("submission and digest");
  });

  it("accepts only an exactly owner/submission/digest-bound formal source key", () => {
    const request = {
      kind: "submission",
      jobId: IMPORT_ID,
      submissionId: IMPORT_ID,
      attempt: 1,
      attemptToken: TOKEN,
      expectedReleaseId: RELEASE_ID,
      expectedManifestSha256: MANIFEST,
      expectedContainerIdentitySha256: IDENTITY,
      expectedProblemBundleDigest: "1".repeat(64),
      sourceOwnerId: USER_ID,
      sourceR2Key: `sources/${USER_ID}/${IMPORT_ID}.${"2".repeat(64)}.json`,
      sourceSha256: "2".repeat(64),
      judgeR2Key: `snapshots/objects/${"3".repeat(64)}`,
      judgeSha256: "3".repeat(64),
    } as const;
    expect(parseExecuteRequest(request)).toMatchObject({
      kind: "submission",
      submissionId: IMPORT_ID,
      sourceOwnerId: USER_ID,
      sourceSha256: "2".repeat(64),
    });
    expect(() => parseExecuteRequest({ ...request, sourceOwnerId: PREDECESSOR_ID })).toThrow("submission and digest");
    expect(() => parseExecuteRequest({ ...request, sourceR2Key: `sources/${USER_ID}/${PREDECESSOR_ID}.${"2".repeat(64)}.json` })).toThrow("submission and digest");
    expect(() => parseExecuteRequest({ ...request, sourceSha256: "4".repeat(64) })).toThrow("submission and digest");
  });

  it("rebinds owner/name paths to the exact numeric GitHub repository and rejects credentialed redirects", () => {
    expect(githubRepositoryCoordinates({ id: 42, name: "fixture", owner: { login: "wasm-oj" } }, 42, "wasm-oj", "fixture")).toEqual({ owner: "wasm-oj", repository: "fixture" });
    expect(() => githubRepositoryCoordinates({ id: 43, name: "fixture", owner: { login: "wasm-oj" } }, 42, "wasm-oj", "fixture")).toThrow("numeric identity");
    expect(() => githubRepositoryCoordinates({ id: 42, name: "rebound", owner: { login: "attacker" } }, 42, "wasm-oj", "fixture")).toThrow("coordinates changed");
    expect(trustedGithubArchiveRedirect("https://codeload.github.com/wasm-oj/fixture/tar.gz/abc")).toContain("codeload.github.com");
    expect(() => trustedGithubArchiveRedirect("https://token@codeload.github.com/wasm-oj/fixture")).toThrow("not trusted");
    expect(() => trustedGithubArchiveRedirect("https://codeload.github.com:8443/wasm-oj/fixture")).toThrow("not trusted");
    expect(() => trustedGithubArchiveRedirect("https://githubusercontent.com.attacker.example/archive")).toThrow("not trusted");
  });
});

describe("managed projection publication binding", () => {
  function fixture() {
    const problem = PROBLEMS[0]!;
    const report = parseValidationReport(resultFixture("forge-collection-validation-report-v1"), expectation);
    const output = report.outputs[0]!;
    const source = {
      collectionRevision: report.collectionRevision,
    } as ForgeValidationSource;
    const managedProblem = { id: problem.id, allowedLanguages: ["c"], references: [], judge: { kind: "text" } } as never;
    const verified = {
      index: {
        revision: report.collectionRevision,
        problems: [{ id: problem.id, number: problem.number, title: problem.title, bundle: { path: `problems/${problem.id}.${output.bundleDigest}.json`, sha256: output.bundleDigest, bytes: 1 } }],
      },
      managed: { problems: [managedProblem] },
      problems: [{ problem, managed: managedProblem }],
      repositoryFiles: new Map(),
    } as unknown as VerifiedValidationSource;
    const contestProblem = {
      ...problem,
      editorial: { "zh-TW": "", en: "" },
      judgeCases: problem.judgeCases.filter((item) => item.kind === "sample"),
    };
    const values = new Map<string, unknown>([
      [output.practice.key, { schema: "forge-practice-problem-projection-v1", problem, digest: output.bundleDigest }],
      [output.contestPublic.key, { schema: "forge-contest-public-problem-projection-v1", problem: contestProblem, digest: output.bundleDigest }],
      [output.judge.key, { schema: "forge-server-judge-projection-v1", forgeReleaseId: RELEASE_ID, allowedProfiles: output.allowedProfiles, problem, judge: { kind: "text" }, digest: output.bundleDigest }],
      [report.projections.practice.key, { schema: "forge-practice-collection-projection-v1", collectionRevision: report.collectionRevision, problems: [{ id: output.id, projection: output.practice }] }],
      [report.projections.contestPublic.key, { schema: "forge-contest-public-collection-projection-v1", collectionRevision: report.collectionRevision, problems: [{ id: output.id, projection: output.contestPublic }] }],
      [report.projections.judge.key, { schema: "forge-server-judge-collection-projection-v1", collectionRevision: report.collectionRevision, forgeReleaseId: RELEASE_ID, problems: [{ id: output.id, projection: output.judge }] }],
    ]);
    return { problem, report, source, verified, values };
  }

  it("accepts projections only when every role, revision, release, bundle and inventory agree", () => {
    const value = fixture();
    expect(() => verifyManagedProjectionBindings(value.report, value.source, value.verified, value.values)).not.toThrow();
  });

  it("rejects a hidden canary even when the attacker relabels it with the contest-public schema", () => {
    const value = fixture();
    const output = value.report.outputs[0]!;
    value.values.set(output.contestPublic.key, {
      schema: "forge-contest-public-problem-projection-v1",
      problem: {
        ...value.problem,
        judgeCases: [...value.problem.judgeCases, { id: "hidden-canary", kind: "regression", input: "TOP-SECRET", output: "never-public" }],
      },
      digest: output.bundleDigest,
    });
    expect(() => verifyManagedProjectionBindings(value.report, value.source, value.verified, value.values)).toThrow("outside its public role");
  });

  it("rejects collection-level public/judge projection swaps", () => {
    const value = fixture();
    const contest = value.values.get(value.report.projections.contestPublic.key);
    value.values.set(value.report.projections.contestPublic.key, value.values.get(value.report.projections.judge.key));
    value.values.set(value.report.projections.judge.key, contest);
    expect(() => verifyManagedProjectionBindings(value.report, value.source, value.verified, value.values)).toThrow(/invalid shape|not bound to its role/);
  });
});
