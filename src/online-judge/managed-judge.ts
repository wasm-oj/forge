import { assertValidBuildArtifact } from "../core/artifact-validation.ts";
import { FORGE_CONTRACT_VERSION } from "../core/contract.ts";
import { sha256Hex } from "../core/sha256.ts";
import type { BuildArtifact, ExecutionTermination } from "../core/types.ts";
import type { JudgeCaseResult } from "../judge/engine.ts";
import type { JudgeProblem } from "../judge/problem-model.ts";
import {
  assertJudgeGuestFilePath,
  textMatcher,
  wasmCheckerMatcher,
  type JudgeSpec,
} from "../judge/spec.ts";
import type { ManagedJudgeContract } from "./managed-collection.ts";

export const TRUSTED_WASM_ARTIFACT_SCHEMA = "forge-trusted-wasm-artifact-v1";
export const MANAGED_JUDGE_RUNTIME_SCHEMA = "forge-managed-judge-runtime-v1";

const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = (() => {
  const values = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) values[BASE64_ALPHABET.charCodeAt(index)] = index;
  return values;
})();

export interface TrustedWasmArtifactProjection {
  readonly schema: typeof TRUSTED_WASM_ARTIFACT_SCHEMA;
  readonly forgeContract: typeof FORGE_CONTRACT_VERSION;
  readonly sha256: string;
  readonly bytes: number;
  readonly bytesBase64: string;
  readonly cacheKey: string;
  readonly name: string;
  readonly language: string;
  readonly target: "wasip1" | "wasix";
  readonly optimization: "debug" | "release";
  readonly toolchains: readonly string[];
  readonly costProfile: string;
}

export interface ManagedJudgeAssetProjection {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly contentBase64: string;
}

export type ManagedJudgeRuntimeProjection =
  | { readonly schema: typeof MANAGED_JUDGE_RUNTIME_SCHEMA; readonly kind: "text" }
  | {
    readonly schema: typeof MANAGED_JUDGE_RUNTIME_SCHEMA;
    readonly kind: "checker";
    readonly artifact: TrustedWasmArtifactProjection;
    readonly args: readonly string[];
    readonly assets: readonly ManagedJudgeAssetProjection[];
  }
  | {
    readonly schema: typeof MANAGED_JUDGE_RUNTIME_SCHEMA;
    readonly kind: "interactive";
    readonly artifact: TrustedWasmArtifactProjection;
    readonly args: readonly string[];
    readonly assets: readonly ManagedJudgeAssetProjection[];
    readonly inputPath: string;
  };

export interface RedactedJudgeAuditCase {
  readonly verdict: JudgeCaseResult["verdict"];
  readonly termination: ExecutionTermination | null;
  readonly cost: number | null;
  readonly memoryBytes: number | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function boundedString(value: unknown, label: string, maximum = 16_384): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function byteLength(value: unknown, label: string, maximum = 8 * 1024 * 1024): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new TypeError(`${label} is outside its byte limit.`);
  return value as number;
}

function parseBase64(value: unknown, expectedBytes: number, label: string): string {
  if (typeof value !== "string" || !BASE64.test(value)) throw new TypeError(`${label} must be canonical base64.`);
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if ((value.length / 4) * 3 - padding !== expectedBytes) throw new TypeError(`${label} byte length disagrees.`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== "string" || item.includes("\0") || new TextEncoder().encode(item).byteLength > 4_096)) {
    throw new TypeError(`${label} must be a bounded string array.`);
  }
  return [...value] as string[];
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let chunk = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    chunk += BASE64_ALPHABET[first >>> 2]
      + BASE64_ALPHABET[((first & 3) << 4) | ((second ?? 0) >>> 4)]
      + (second === undefined ? "=" : BASE64_ALPHABET[((second & 15) << 2) | ((third ?? 0) >>> 6)])
      + (third === undefined ? "=" : BASE64_ALPHABET[third & 63]);
    if (chunk.length >= 16_384) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  chunks.push(chunk);
  return chunks.join("");
}

function decodeBase64(value: string, bytes: number): Uint8Array {
  const output = new Uint8Array(bytes);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const first = BASE64_VALUES[value.charCodeAt(index)]!;
    const second = BASE64_VALUES[value.charCodeAt(index + 1)]!;
    const thirdCharacter = value[index + 2]!;
    const fourthCharacter = value[index + 3]!;
    const third = thirdCharacter === "=" ? 0 : BASE64_VALUES[thirdCharacter.charCodeAt(0)]!;
    const fourth = fourthCharacter === "=" ? 0 : BASE64_VALUES[fourthCharacter.charCodeAt(0)]!;
    if (outputIndex < bytes) output[outputIndex++] = (first << 2) | (second >>> 4);
    if (outputIndex < bytes) output[outputIndex++] = ((second & 15) << 4) | (third >>> 2);
    if (outputIndex < bytes) output[outputIndex++] = ((third & 3) << 6) | fourth;
  }
  return output;
}

export async function createTrustedWasmArtifactProjection(artifact: BuildArtifact): Promise<TrustedWasmArtifactProjection> {
  assertValidBuildArtifact(artifact);
  if (artifact.kind !== "wasm") throw new TypeError("Trusted checker and interactor programs must compile to standalone Wasm.");
  if (artifact.dependencyLockSha256 !== undefined) throw new TypeError("Trusted judge programs cannot carry dependencies in v1.");
  const bytes = artifact.bytes.slice();
  return parseTrustedWasmArtifactProjection({
    schema: TRUSTED_WASM_ARTIFACT_SCHEMA,
    forgeContract: FORGE_CONTRACT_VERSION,
    sha256: await sha256Hex(bytes),
    bytes: bytes.byteLength,
    bytesBase64: encodeBase64(bytes),
    cacheKey: artifact.cacheKey,
    name: artifact.name,
    language: artifact.language,
    target: artifact.target,
    optimization: artifact.optimization,
    toolchains: [...artifact.toolchains],
    costProfile: artifact.costProfile,
  });
}

export function parseTrustedWasmArtifactProjection(value: unknown): TrustedWasmArtifactProjection {
  const artifact = record(value, "trusted Wasm artifact");
  exact(artifact, ["bytes", "bytesBase64", "cacheKey", "costProfile", "forgeContract", "language", "name", "optimization", "schema", "sha256", "target", "toolchains"], "trusted Wasm artifact");
  if (artifact.schema !== TRUSTED_WASM_ARTIFACT_SCHEMA || artifact.forgeContract !== FORGE_CONTRACT_VERSION) throw new TypeError("Trusted Wasm artifact contract is unsupported.");
  const bytes = byteLength(artifact.bytes, "trusted Wasm artifact bytes");
  if (artifact.target !== "wasip1" && artifact.target !== "wasix") throw new TypeError("Trusted Wasm artifact target is unsupported.");
  if (artifact.optimization !== "debug" && artifact.optimization !== "release") throw new TypeError("Trusted Wasm artifact optimization is unsupported.");
  if (!Array.isArray(artifact.toolchains) || artifact.toolchains.length < 1 || artifact.toolchains.some((item) => typeof item !== "string" || !item || item !== item.trim()) || new Set(artifact.toolchains).size !== artifact.toolchains.length) {
    throw new TypeError("Trusted Wasm artifact toolchains are invalid.");
  }
  return {
    schema: TRUSTED_WASM_ARTIFACT_SCHEMA,
    forgeContract: FORGE_CONTRACT_VERSION,
    sha256: digest(artifact.sha256, "trusted Wasm artifact digest"),
    bytes,
    bytesBase64: parseBase64(artifact.bytesBase64, bytes, "trusted Wasm artifact payload"),
    cacheKey: boundedString(artifact.cacheKey, "trusted Wasm artifact cacheKey"),
    name: boundedString(artifact.name, "trusted Wasm artifact name", 4_096),
    language: boundedString(artifact.language, "trusted Wasm artifact language", 128),
    target: artifact.target,
    optimization: artifact.optimization,
    toolchains: [...artifact.toolchains] as string[],
    costProfile: boundedString(artifact.costProfile, "trusted Wasm artifact costProfile"),
  };
}

export async function decodeTrustedWasmArtifactProjection(value: unknown): Promise<BuildArtifact> {
  const projection = parseTrustedWasmArtifactProjection(value);
  const bytes = decodeBase64(projection.bytesBase64, projection.bytes);
  if (await sha256Hex(bytes) !== projection.sha256) throw new TypeError("Trusted Wasm artifact payload failed integrity verification.");
  const artifact: BuildArtifact = {
    forgeContract: FORGE_CONTRACT_VERSION,
    kind: "wasm",
    id: `managed-judge:${projection.sha256}`,
    projectId: `managed-judge:${projection.sha256}`,
    cacheKey: projection.cacheKey,
    name: projection.name,
    language: projection.language,
    target: projection.target,
    optimization: projection.optimization,
    createdAt: 0,
    durationMs: 0,
    size: projection.bytes,
    toolchains: [...projection.toolchains],
    costProfile: projection.costProfile,
    bytes,
  };
  assertValidBuildArtifact(artifact);
  return artifact;
}

async function createAssetProjection(
  asset: { readonly path: string; readonly repositoryPath: string; readonly bytes: number; readonly sha256: string },
  repositoryFiles: ReadonlyMap<string, Uint8Array>,
): Promise<ManagedJudgeAssetProjection> {
  const contents = repositoryFiles.get(asset.repositoryPath)?.slice();
  if (!contents || contents.byteLength !== asset.bytes || await sha256Hex(contents) !== asset.sha256) {
    throw new TypeError(`Trusted judge asset '${asset.repositoryPath}' failed integrity verification.`);
  }
  return { path: asset.path, sha256: asset.sha256, bytes: asset.bytes, contentBase64: encodeBase64(contents) };
}

export async function createManagedJudgeRuntimeProjection(
  contract: ManagedJudgeContract,
  artifact: BuildArtifact | undefined,
  repositoryFiles: ReadonlyMap<string, Uint8Array>,
): Promise<ManagedJudgeRuntimeProjection> {
  if (contract.kind === "text") {
    if (artifact !== undefined) throw new TypeError("Text judges must not carry a trusted artifact.");
    return { schema: MANAGED_JUDGE_RUNTIME_SCHEMA, kind: "text" };
  }
  if (!artifact) throw new TypeError(`Managed ${contract.kind} judge is missing its compiled artifact.`);
  if (artifact.language !== contract.program.language || artifact.target !== contract.program.target || artifact.optimization !== contract.program.optimization) {
    throw new TypeError(`Managed ${contract.kind} artifact compile profile disagrees with its contract.`);
  }
  const [trustedArtifact, assets] = await Promise.all([
    createTrustedWasmArtifactProjection(artifact),
    Promise.all(contract.program.assets.map((asset) => createAssetProjection(asset, repositoryFiles))),
  ]);
  const base = {
    schema: MANAGED_JUDGE_RUNTIME_SCHEMA,
    artifact: trustedArtifact,
    args: [...contract.program.args],
    assets,
  } as const;
  return contract.kind === "checker"
    ? { ...base, kind: "checker" }
    : { ...base, kind: "interactive", inputPath: contract.inputPath };
}

function parseAsset(value: unknown, kind: "checker" | "interactive", index: number): ManagedJudgeAssetProjection {
  const asset = record(value, `managed ${kind} asset ${index}`);
  exact(asset, ["bytes", "contentBase64", "path", "sha256"], `managed ${kind} asset ${index}`);
  const path = assertJudgeGuestFilePath(asset.path, `managed ${kind} asset ${index} path`);
  const namespace = kind === "checker" ? "/checker/assets/" : "/interactor/assets/";
  if (!path.startsWith(namespace)) throw new TypeError(`Managed ${kind} assets must be inside '${namespace}'.`);
  const bytes = byteLength(asset.bytes, `managed ${kind} asset ${index} bytes`, 4 * 1024 * 1024);
  return {
    path,
    sha256: digest(asset.sha256, `managed ${kind} asset ${index} digest`),
    bytes,
    contentBase64: parseBase64(asset.contentBase64, bytes, `managed ${kind} asset ${index} payload`),
  };
}

export function parseManagedJudgeRuntimeProjection(value: unknown): ManagedJudgeRuntimeProjection {
  const judge = record(value, "managed judge runtime");
  if (judge.schema !== MANAGED_JUDGE_RUNTIME_SCHEMA) throw new TypeError("Managed judge runtime schema is unsupported.");
  if (judge.kind === "text") {
    exact(judge, ["kind", "schema"], "managed text judge runtime");
    return { schema: MANAGED_JUDGE_RUNTIME_SCHEMA, kind: "text" };
  }
  if (judge.kind !== "checker" && judge.kind !== "interactive") throw new TypeError("Managed judge runtime kind is unsupported.");
  exact(judge, judge.kind === "checker"
    ? ["args", "artifact", "assets", "kind", "schema"]
    : ["args", "artifact", "assets", "inputPath", "kind", "schema"], `managed ${judge.kind} judge runtime`);
  if (!Array.isArray(judge.assets) || judge.assets.length > 256) throw new TypeError(`Managed ${judge.kind} assets are invalid.`);
  const assets = judge.assets.map((asset, index) => parseAsset(asset, judge.kind as "checker" | "interactive", index));
  if (new Set(assets.map((asset) => asset.path)).size !== assets.length) throw new TypeError(`Managed ${judge.kind} assets repeat a guest path.`);
  if (assets.reduce((total, asset) => total + asset.bytes, 0) > 4 * 1024 * 1024) throw new TypeError(`Managed ${judge.kind} assets exceed 4 MiB.`);
  const base = {
    schema: MANAGED_JUDGE_RUNTIME_SCHEMA,
    artifact: parseTrustedWasmArtifactProjection(judge.artifact),
    args: stringArray(judge.args, `managed ${judge.kind} args`),
    assets,
  } as const;
  if (judge.kind === "checker") return { ...base, kind: "checker" };
  const inputPath = assertJudgeGuestFilePath(judge.inputPath, "managed interactor inputPath");
  if (!inputPath.startsWith("/interactor/input/")) throw new TypeError("Managed interactor inputPath must be inside '/interactor/input/'.");
  return { ...base, kind: "interactive", inputPath };
}

async function decodeAssets(assets: readonly ManagedJudgeAssetProjection[]): Promise<Record<string, Uint8Array>> {
  const entries = await Promise.all(assets.map(async (asset) => {
    const contents = decodeBase64(asset.contentBase64, asset.bytes);
    if (await sha256Hex(contents) !== asset.sha256) throw new TypeError(`Trusted judge asset '${asset.path}' failed integrity verification.`);
    return [asset.path, contents] as const;
  }));
  return Object.fromEntries(entries);
}

export async function managedJudgeSpec(problem: JudgeProblem, value: unknown): Promise<JudgeSpec> {
  const judge = parseManagedJudgeRuntimeProjection(value);
  const broadest = problem.scoring.policies[0];
  if (!broadest) throw new TypeError(`Problem '${problem.id}' has no scoring policy.`);
  const resources = {
    instructionBudget: broadest.limits.instructionBudget,
    memoryLimitBytes: broadest.limits.memoryLimitBytes,
    wallTimeLimitMs: problem.scoring.safetyLimits.wallTimeLimitMs,
    ...(broadest.limits.logicalTimeLimitMs === undefined ? {} : { logicalTimeLimitMs: broadest.limits.logicalTimeLimitMs }),
  };
  if (judge.kind === "text") {
    return {
      version: FORGE_CONTRACT_VERSION,
      failFast: false,
      cases: problem.judgeCases.map((testCase) => ({
        kind: "batch",
        id: testCase.id,
        input: { kind: "inline", value: testCase.input },
        matcher: textMatcher(testCase.output, "lines"),
        args: [],
        env: {},
        resources,
      })),
    };
  }
  const [artifact, assets] = await Promise.all([
    decodeTrustedWasmArtifactProjection(judge.artifact),
    decodeAssets(judge.assets),
  ]);
  if (judge.kind === "checker") {
    return {
      version: FORGE_CONTRACT_VERSION,
      failFast: false,
      cases: problem.judgeCases.map((testCase) => ({
        kind: "batch",
        id: testCase.id,
        input: { kind: "inline", value: testCase.input },
        matcher: wasmCheckerMatcher(artifact, testCase.output, judge.args, assets),
        args: [],
        env: {},
        resources,
      })),
    };
  }
  const files = Object.fromEntries(Object.entries(assets).map(([path, contents]) => [path, { kind: "inline-bytes" as const, value: contents }]));
  return {
    version: FORGE_CONTRACT_VERSION,
    failFast: false,
    cases: problem.judgeCases.map((testCase) => ({
      kind: "interactive",
      id: testCase.id,
      input: { kind: "inline", value: testCase.input },
      files,
      contestant: { args: [], env: {}, resources },
      interactor: {
        artifact,
        inputPath: judge.inputPath,
        args: [judge.inputPath, ...judge.args],
        env: {},
        resources,
      },
    })),
  };
}

/** Permanent audit projection. It intentionally has no case ID, output, message, or protocol field. */
export function redactJudgeCasesForAudit(cases: readonly JudgeCaseResult[]): readonly RedactedJudgeAuditCase[] {
  return cases.map((item) => {
    const process = item.run ?? item.interaction?.contestant;
    return {
      verdict: item.verdict,
      termination: process?.termination ?? null,
      cost: process?.metrics.cost ?? null,
      memoryBytes: process?.metrics.memoryBytes ?? null,
    };
  });
}
