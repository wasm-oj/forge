import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PROBLEMS } from "../judge/problems";
import type { JudgeProblem } from "../judge/problem-model";
import { deriveJudgeData, type JudgeData } from "./judge-data";
import {
  decodeJudgePackageForExecution,
  encodeJudgePackage,
  WASM_OJ_JUDGE_PACKAGE_MAGIC,
  judgePackageSemanticDigest,
  readJudgePackageManifest,
  validateJudgePackage,
} from "./judge-package";

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

const GOLDEN_JUDGE_DATA: JudgeData = {
  schema: "wasm-oj-v2/judge-data",
  cases: [{ id: "case-1", input: "1\n", output: "1\n" }],
  scoring: {
    maximumPoints: 100,
    calibration: { method: "wasm-oj-v2/compiled-average-optimal-rounded/v1", profiles: { c: "golden-profile" } },
    policies: [
      { id: "baseline", points: 20, limits: { instructionBudget: 300, memoryLimitBytes: 196_608 } },
      { id: "efficient", points: 30, limits: { instructionBudget: 200, memoryLimitBytes: 131_072 } },
      { id: "optimal", points: 50, limits: { instructionBudget: 100, memoryLimitBytes: 65_536 } },
    ],
    safetyLimits: { wallTimeLimitMs: 1_000 },
  },
};

async function goldenPackageBytes(): Promise<Uint8Array> {
  const hex = (await readFile(new URL("../../testdata/wojjdg02-v2-text.hex", import.meta.url), "utf8")).trim();
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) throw new Error("WOJJDG02 golden vector is not lowercase hexadecimal.");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

async function packageFixture(problem: JudgeProblem = PROBLEMS[0]!) {
  return encodeJudgePackage({
    judgeData: deriveJudgeData(problem, ["c"]),
    allowedProfiles: { c: { target: "wasip1", optimization: "release" } },
    judge: { kind: "text" },
  });
}

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += 17) yield bytes.subarray(offset, offset + 17);
}

describe("WOJJDG02 judge package", () => {
  it("matches the v2 golden transport vector", async () => {
    const encoded = await encodeJudgePackage({
      judgeData: GOLDEN_JUDGE_DATA,
      allowedProfiles: { c: { target: "wasip1", optimization: "release" } },
      judge: { kind: "text" },
    });
    const golden = await goldenPackageBytes();
    expect(encoded.bytes).toEqual(golden);
    expect(encoded.bytes.byteLength).toBe(863);
    expect(encoded.executionSemanticSha256).toBe("0039034e813284b1a22fa6c11c1351097cb9141e5954f03f1b2bea98a9b5f12e");
    expect((await validateJudgePackage(golden)).executionSemanticSha256).toBe(encoded.executionSemanticSha256);
  });

  it("builds deterministic canonical bytes and exposes their execution identity", async () => {
    const first = await packageFixture();
    const second = await packageFixture();
    expect(new TextDecoder().decode(first.bytes.subarray(0, 8))).toBe(WASM_OJ_JUDGE_PACKAGE_MAGIC);
    expect(first.bytes.byteLength).toBe(second.bytes.byteLength);
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    expect(first.executionSemanticSha256).toBe(await judgePackageSemanticDigest(first.bytes));
    expect(readJudgePackageManifest(first.bytes)).toEqual(first.manifest);

    const metadataOnlyChange: JudgeProblem = {
      ...structuredClone(PROBLEMS[0]!),
      statement: { ...PROBLEMS[0]!.statement, en: "Changed statement text" },
      editorial: { ...PROBLEMS[0]!.editorial, en: "Changed editorial text" },
    };
    expect((await packageFixture(metadataOnlyChange)).executionSemanticSha256).toBe(first.executionSemanticSha256);
  });

  it("stream-validates bounded chunks without executing judge code", async () => {
    const encoded = await packageFixture();
    const validated = await validateJudgePackage(chunks(encoded.bytes), {
      expectedBytes: encoded.bytes.byteLength,
      expectedSha256: encoded.executionSemanticSha256,
    });
    expect(validated.judgeData.cases.map((testCase) => testCase.id)).toEqual(PROBLEMS[0]!.judgeCases.map((testCase) => testCase.id));
    expect(validated.executionSemanticSha256).toBe(encoded.executionSemanticSha256);
    expect((await decodeJudgePackageForExecution(encoded.bytes)).judge).toEqual({ kind: "text" });
  });

  it("decodes a verified trusted checker executable and immutable assets", async () => {
    const asset = new Uint8Array([0, 1, 2, 255]);
    const encoded = await encodeJudgePackage({
      judgeData: deriveJudgeData(PROBLEMS[0]!, ["c"]),
      allowedProfiles: { c: { target: "wasip1", optimization: "release" } },
      judge: {
        kind: "checker",
        runtimeProfile: "c-wasip1-release",
        artifact: TRUSTED_COMMAND_WASM,
        assets: [{ guestPath: "/checker/assets/policy.bin", contents: asset }],
        args: ["/checker/assets/policy.bin"],
      },
    });
    const decoded = await decodeJudgePackageForExecution(encoded.bytes);
    expect(decoded.judge.kind).toBe("checker");
    if (decoded.judge.kind !== "checker") throw new Error("fixture did not decode as a checker");
    expect(decoded.judge.runtimeProfile).toBe("c-wasip1-release");
    expect(decoded.judge.artifact).toEqual(TRUSTED_COMMAND_WASM);
    expect(decoded.judge.assets).toEqual([{ guestPath: "/checker/assets/policy.bin", bytes: asset }]);
  });

  it("rejects corruption, trailing bytes, and descriptor disagreement", async () => {
    const encoded = await packageFixture();
    const corrupted = encoded.bytes.slice();
    corrupted[corrupted.byteLength - 1] ^= 1;
    await expect(validateJudgePackage(corrupted)).rejects.toThrow("integrity verification");

    const trailing = new Uint8Array(encoded.bytes.byteLength + 1);
    trailing.set(encoded.bytes);
    await expect(validateJudgePackage(trailing)).rejects.toThrow("trailing bytes");
    await expect(validateJudgePackage(encoded.bytes, { expectedSha256: "b".repeat(64) })).rejects.toThrow("digest disagrees");
  });

  it("rejects a manifest larger than 256 KiB", async () => {
    await expect(encodeJudgePackage({
      judgeData: deriveJudgeData(PROBLEMS[0]!, ["c"]),
      allowedProfiles: { c: { target: "wasip1", optimization: "release" } },
      judge: {
        kind: "checker",
        runtimeProfile: "c-wasip1-release",
        artifact: TRUSTED_COMMAND_WASM,
        assets: [],
        args: Array.from({ length: 64 }, () => "x".repeat(4096)),
      },
    })).rejects.toThrow("exceeds 256 KiB");
  });
});
