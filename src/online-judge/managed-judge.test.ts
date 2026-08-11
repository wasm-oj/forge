import { describe, expect, it } from "vitest";
import { FORGE_CONTRACT_VERSION } from "../core/contract";
import { costProfileId } from "../core/cost-profile";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { WEIGHTED_METER_MODEL } from "../core/resources";
import { sha256Hex } from "../core/sha256";
import { toolchainPackageIdentities } from "../core/toolchains";
import { LANGUAGES, type BuildArtifact, type ExecutionMetrics } from "../core/types";
import type { JudgeCaseResult } from "../judge/engine";
import type { JudgeProblem } from "../judge/problem-model";
import type { ManagedJudgeContract } from "./managed-collection";
import {
  createManagedJudgeRuntimeProjection,
  createTrustedWasmArtifactProjection,
  decodeTrustedWasmArtifactProjection,
  managedJudgeSpec,
  redactJudgeCasesForAudit,
} from "./managed-judge";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const artifact: BuildArtifact = {
  kind: "wasm",
  forgeContract: FORGE_CONTRACT_VERSION,
  id: "nondeterministic-build-id",
  projectId: "validation:checker",
  cacheKey: "trusted-checker-cache-key",
  name: "checker.wasm",
  language: "c",
  target: "wasip1",
  optimization: "release",
  createdAt: 123_456,
  durationMs: 789,
  size: wasm.byteLength,
  toolchains: toolchainPackageIdentities("c"),
  costProfile: costProfileId("c", "wasip1", "release"),
  bytes: wasm,
};

const starterTemplates = Object.fromEntries(LANGUAGES.map((language) => [
  language,
  { entry: "main.txt", files: { "main.txt": "starter\n" } },
])) as unknown as JudgeProblem["starterTemplates"];

const problem: JudgeProblem = {
  id: "sum-two",
  number: 1,
  title: { "zh-TW": "加法", en: "Sum" },
  trackId: "test",
  track: { "zh-TW": "測試", en: "Test" },
  difficulty: "easy",
  tags: ["test"],
  statement: { "zh-TW": "statement", en: "statement" },
  editorial: { "zh-TW": "editorial", en: "editorial" },
  starterTemplates,
  judgeCases: [{ id: "hidden-canary-id", kind: "regression", input: "HIDDEN_INPUT", output: "HIDDEN_EXPECTED" }],
  scoring: {
    maximumPoints: 100,
    calibration: { method: "forge-v1-compiled-average-optimal-rounded-v1", profiles: { c: artifact.costProfile } },
    policies: [{
      id: "accepted",
      title: { "zh-TW": "通過", en: "Accepted" },
      points: 100,
      limits: { instructionBudget: 10_000, memoryLimitBytes: 64 * 1024 * 1024 },
    }],
    safetyLimits: { wallTimeLimitMs: 10_000 },
  },
  complexities: [],
};

async function contract(kind: "checker" | "interactive") {
  const source = new TextEncoder().encode("int main(void) { return 0; }\n");
  const asset = new Uint8Array([0, 255, 1, 2]);
  const namespace = kind === "checker" ? "/checker/assets/" : "/interactor/assets/";
  const value: ManagedJudgeContract = {
    kind,
    ...(kind === "interactive" ? { inputPath: "/interactor/input/case.txt" } : {}),
    program: {
      language: "c",
      target: "wasip1",
      optimization: "release",
      entry: "checker.c",
      files: [{ path: "checker.c", repositoryPath: "judge/checker.c", bytes: source.byteLength, sha256: await sha256Hex(source) }],
      assets: [{ path: `${namespace}policy.bin`, repositoryPath: "judge/policy.bin", bytes: asset.byteLength, sha256: await sha256Hex(asset) }],
      args: [`${namespace}policy.bin`],
    },
  } as ManagedJudgeContract;
  return { value, files: new Map<string, Uint8Array>([["judge/checker.c", source], ["judge/policy.bin", asset]]) };
}

describe("managed judge runtime projection", () => {
  it("preserves the existing text-judge case contract", async () => {
    const spec = await managedJudgeSpec(problem, { schema: "forge-managed-judge-runtime-v1", kind: "text" });
    expect(spec.cases).toEqual([expect.objectContaining({
      kind: "batch",
      id: "hidden-canary-id",
      input: { kind: "inline", value: "HIDDEN_INPUT" },
      matcher: { id: "text", config: { expected: "HIDDEN_EXPECTED", normalization: "lines" } },
    })]);
  });

  it("normalizes and verifies trusted Wasm artifacts", async () => {
    const projection = await createTrustedWasmArtifactProjection(artifact);
    const decoded = await decodeTrustedWasmArtifactProjection(projection);
    expect(decoded).toMatchObject({
      id: `managed-judge:${projection.sha256}`,
      projectId: `managed-judge:${projection.sha256}`,
      createdAt: 0,
      durationMs: 0,
      bytes: wasm,
    });

    const tampered = { ...projection, bytesBase64: `A${projection.bytesBase64[1] === "A" ? "B" : "A"}${projection.bytesBase64.slice(2)}` };
    await expect(decodeTrustedWasmArtifactProjection(tampered)).rejects.toThrow("integrity verification");
  });

  it("constructs a checker spec with binary assets kept in the trusted matcher", async () => {
    const fixture = await contract("checker");
    const projection = await createManagedJudgeRuntimeProjection(fixture.value, artifact, fixture.files);
    const spec = await managedJudgeSpec(problem, projection);
    const first = spec.cases[0];
    expect(first?.kind).toBe("batch");
    if (!first || first.kind !== "batch") throw new Error("missing checker case");
    expect(first.matcher.id).toBe("wasm-checker");
    expect(first.matcher.config.files).toEqual({ "/checker/assets/policy.bin": new Uint8Array([0, 255, 1, 2]) });
  });

  it("constructs an interactive spec that mounts secrets only for the interactor", async () => {
    const fixture = await contract("interactive");
    const projection = await createManagedJudgeRuntimeProjection(fixture.value, artifact, fixture.files);
    const spec = await managedJudgeSpec(problem, projection);
    const first = spec.cases[0];
    expect(first?.kind).toBe("interactive");
    if (!first || first.kind !== "interactive") throw new Error("missing interactive case");
    expect(first.contestant).not.toHaveProperty("files");
    expect(first.files).toEqual({
      "/interactor/assets/policy.bin": { kind: "inline-bytes", value: new Uint8Array([0, 255, 1, 2]) },
    });
    expect(first.interactor.args).toEqual(["/interactor/input/case.txt", "/interactor/assets/policy.bin"]);
  });

  it("redacts case identity, output, diagnostics, hidden data, and interactive protocol", () => {
    const metrics: ExecutionMetrics = {
      cost: 10,
      rawCost: 11,
      baselineCost: 1,
      costProfile: artifact.costProfile,
      costModel: WEIGHTED_METER_MODEL,
      operations: {},
      memoryBytes: 65_536,
      logicalTimeNs: 0,
      filesystemBytes: 0,
      filesystemEntries: 0,
      stdoutBytes: 99,
      stderrBytes: 88,
    };
    const cases: JudgeCaseResult[] = [{
      id: "HIDDEN_CASE_ID",
      verdict: "wrong-answer",
      message: "HIDDEN_EXPECTED HIDDEN_INPUT",
      interaction: {
        contestant: { code: 0, stderr: "SECRET_STDERR", termination: "exited", metrics },
        interactor: { code: 1, stderr: "SECRET_INTERACTOR_STDERR", termination: "exited", metrics },
        contestantToInteractor: "SECRET_PROTOCOL_OUT",
        interactorToContestant: "SECRET_PROTOCOL_IN",
        durationMs: 1,
        determinism: DEFAULT_DETERMINISM,
      },
    }];
    const encoded = JSON.stringify(redactJudgeCasesForAudit(cases));
    expect(encoded).toBe('[{"verdict":"wrong-answer","termination":"exited","cost":10,"memoryBytes":65536}]');
    for (const secret of ["HIDDEN", "SECRET", "protocol", "stderr", "stdout", "id", "message"]) {
      expect(encoded.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });
});
