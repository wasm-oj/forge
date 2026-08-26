import { canonicalJsonBytes, parseCanonicalJsonBytes } from "../core/canonical-json.ts";
import { WASM_OJ_CONTRACT_VERSION } from "../core/contract.ts";
import { sha256Hex } from "../core/sha256.ts";
import type { BuiltinLanguage } from "../core/types.ts";
import {
  parseJudgeAllowedProfiles,
  type JudgeAllowedProfile,
  type JudgeAllowedProfiles,
} from "./compile-profiles.ts";
import { parseJudgeData, type JudgeData } from "./judge-data.ts";
import { isUnicodeScalarString } from "./unicode-scalar.ts";
import {
  TRUSTED_JUDGE_RUNTIME_PROFILES,
  TRUSTED_JUDGE_WASM_MAX_BYTES,
  validateTrustedJudgeWasm,
  type TrustedJudgeRuntimeProfile,
} from "./trusted-judge-wasm.ts";

export const WASM_OJ_JUDGE_PACKAGE_SCHEMA = "wasm-oj-v2/judge-package";
export const WASM_OJ_JUDGE_PACKAGE_MAGIC = "WOJJDG02";
export const WASM_OJ_JUDGE_PACKAGE_MAX_BYTES = 32 * 1024 * 1024;

const MAGIC = new TextEncoder().encode(WASM_OJ_JUDGE_PACKAGE_MAGIC);
const HEADER_BYTES = MAGIC.byteLength + 4 + 4;
const BLOB_HEADER_BYTES = 32 + 8;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_BLOBS = 258;
const MAX_ASSETS = 256;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_TOTAL_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

export interface JudgePackageBlobReference {
  readonly bytes: number;
  readonly sha256: string;
}

export interface JudgePackageAssetReference extends JudgePackageBlobReference {
  readonly guestPath: string;
}

export type JudgePackageAllowedProfile = JudgeAllowedProfile;

export type JudgePackageManifestJudge =
  | { readonly kind: "text" }
  | {
    readonly kind: "checker";
    readonly runtimeProfile: TrustedJudgeRuntimeProfile;
    readonly artifact: JudgePackageBlobReference;
    readonly assets: readonly JudgePackageAssetReference[];
    readonly args: readonly string[];
  }
  | {
    readonly kind: "interactive";
    readonly runtimeProfile: TrustedJudgeRuntimeProfile;
    readonly artifact: JudgePackageBlobReference;
    readonly assets: readonly JudgePackageAssetReference[];
    readonly args: readonly string[];
    readonly inputPath: string;
  };

export interface JudgePackageManifest {
  readonly schema: typeof WASM_OJ_JUDGE_PACKAGE_SCHEMA;
  readonly wasmOjContract: typeof WASM_OJ_CONTRACT_VERSION;
  readonly judgeData: JudgePackageBlobReference;
  readonly allowedProfiles: JudgeAllowedProfiles;
  readonly judge: JudgePackageManifestJudge;
}

export interface JudgePackageAssetInput {
  readonly guestPath: string;
  readonly contents: Uint8Array;
}

export type JudgePackageInputJudge =
  | { readonly kind: "text" }
  | {
    readonly kind: "checker";
    readonly runtimeProfile: TrustedJudgeRuntimeProfile;
    readonly artifact: Uint8Array;
    readonly assets: readonly JudgePackageAssetInput[];
    readonly args: readonly string[];
  }
  | {
    readonly kind: "interactive";
    readonly runtimeProfile: TrustedJudgeRuntimeProfile;
    readonly artifact: Uint8Array;
    readonly assets: readonly JudgePackageAssetInput[];
    readonly args: readonly string[];
    readonly inputPath: string;
  };

export interface JudgePackageInput {
  readonly judgeData: JudgeData;
  readonly allowedProfiles: JudgeAllowedProfiles;
  readonly judge: JudgePackageInputJudge;
}

export interface EncodedJudgePackage {
  readonly bytes: Uint8Array;
  readonly manifest: JudgePackageManifest;
  readonly executionSemanticSha256: string;
}

export type JudgePackageByteSource = Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface ValidateJudgePackageOptions {
  readonly expectedBytes?: number;
  readonly expectedSha256?: string;
  readonly memoryLimitBytes?: number;
}

export interface ValidatedJudgePackage {
  readonly manifest: JudgePackageManifest;
  readonly judgeData: JudgeData;
  readonly bytes: number;
  readonly executionSemanticSha256: string;
}

export interface TrustedJudgeAsset {
  readonly guestPath: string;
  readonly bytes: Uint8Array;
}

export type TrustedJudgeExecutable =
  | { readonly kind: "text" }
  | {
    readonly kind: "checker";
    readonly runtimeProfile: TrustedJudgeRuntimeProfile;
    readonly artifact: Uint8Array;
    readonly assets: readonly TrustedJudgeAsset[];
    readonly args: readonly string[];
  }
  | {
    readonly kind: "interactive";
    readonly runtimeProfile: TrustedJudgeRuntimeProfile;
    readonly artifact: Uint8Array;
    readonly assets: readonly TrustedJudgeAsset[];
    readonly args: readonly string[];
    readonly inputPath: string;
  };

export interface DecodedJudgePackageForExecution extends ValidatedJudgePackage {
  readonly allowedProfiles: JudgePackageManifest["allowedProfiles"];
  readonly judge: TrustedJudgeExecutable;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new TypeError(`${label} has an invalid shape.`);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function byteLength(value: unknown, label: string, maximum = WASM_OJ_JUDGE_PACKAGE_MAX_BYTES): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`${label} is outside its byte limit.`);
  }
  return value as number;
}

function blobReference(value: unknown, label: string, maximum?: number): JudgePackageBlobReference {
  const reference = record(value, label);
  exact(reference, ["bytes", "sha256"], label);
  return {
    bytes: byteLength(reference.bytes, `${label}.bytes`, maximum),
    sha256: digest(reference.sha256, `${label}.sha256`),
  };
}

function guestPath(value: unknown, label: string, namespace: "/checker/assets/" | "/interactor/assets/" | "/interactor/input/"): string {
  if (
    typeof value !== "string"
    || value.length > 512
    || !isUnicodeScalarString(value)
    || !value.startsWith(namespace)
    || value.endsWith("/")
    || value.includes("//")
    || value.includes("\\")
    || value.includes("\0")
    || value.split("/").some((component) => component === "." || component === "..")
  ) {
    throw new TypeError(`${label} must be inside '${namespace}'.`);
  }
  return value;
}

function args(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => (
    typeof item !== "string"
    || !isUnicodeScalarString(item)
    || item.includes("\0")
    || new TextEncoder().encode(item).byteLength > 4_096
  ))) throw new TypeError(`${label} must be a bounded string array.`);
  return [...value] as string[];
}

function judgeManifest(value: unknown): JudgePackageManifestJudge {
  const judge = record(value, "judge package judge");
  if (judge.kind === "text") {
    exact(judge, ["kind"], "judge package text judge");
    return { kind: "text" };
  }
  if (judge.kind !== "checker" && judge.kind !== "interactive") throw new TypeError("Judge package kind is unsupported.");
  exact(judge, judge.kind === "checker"
    ? ["args", "artifact", "assets", "kind", "runtimeProfile"]
    : ["args", "artifact", "assets", "inputPath", "kind", "runtimeProfile"], `judge package ${judge.kind}`);
  if (typeof judge.runtimeProfile !== "string" || !TRUSTED_JUDGE_RUNTIME_PROFILES.has(judge.runtimeProfile as TrustedJudgeRuntimeProfile)) {
    throw new TypeError(`Judge package ${judge.kind} runtimeProfile is unsupported.`);
  }
  if (!Array.isArray(judge.assets) || judge.assets.length > MAX_ASSETS) throw new TypeError(`Judge package ${judge.kind} assets are invalid.`);
  const namespace = judge.kind === "checker" ? "/checker/assets/" : "/interactor/assets/";
  const assets = judge.assets.map((candidate, index) => {
    const asset = record(candidate, `judge package ${judge.kind} asset ${index}`);
    exact(asset, ["bytes", "guestPath", "sha256"], `judge package ${judge.kind} asset ${index}`);
    return {
      guestPath: guestPath(asset.guestPath, `judge package ${judge.kind} asset ${index}.guestPath`, namespace),
      ...blobReference({ bytes: asset.bytes, sha256: asset.sha256 }, `judge package ${judge.kind} asset ${index}`, MAX_ASSET_BYTES),
    };
  });
  const paths = assets.map((asset) => asset.guestPath);
  const sortedPaths = [...paths].sort();
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify(sortedPaths)) {
    throw new TypeError(`Judge package ${judge.kind} assets must be unique and sorted by guestPath.`);
  }
  if (assets.reduce((total, asset) => total + asset.bytes, 0) > MAX_ASSET_TOTAL_BYTES) {
    throw new TypeError(`Judge package ${judge.kind} assets exceed 4 MiB.`);
  }
  const runtimeProfile = judge.runtimeProfile as TrustedJudgeRuntimeProfile;
  const artifact = blobReference(judge.artifact, `judge package ${judge.kind} artifact`, TRUSTED_JUDGE_WASM_MAX_BYTES);
  const judgeArgs = args(judge.args, `judge package ${judge.kind} args`);
  if (judge.kind === "checker") return { kind: "checker", runtimeProfile, artifact, assets, args: judgeArgs };
  return {
    kind: "interactive",
    runtimeProfile,
    artifact,
    assets,
    args: judgeArgs,
    inputPath: guestPath(judge.inputPath, "judge package interactive inputPath", "/interactor/input/"),
  };
}

export function parseJudgePackageManifest(value: unknown): JudgePackageManifest {
  const manifest = record(value, "judge package manifest");
  exact(manifest, ["allowedProfiles", "wasmOjContract", "judge", "judgeData", "schema"], "judge package manifest");
  if (manifest.schema !== WASM_OJ_JUDGE_PACKAGE_SCHEMA || manifest.wasmOjContract !== WASM_OJ_CONTRACT_VERSION) {
    throw new TypeError("Judge package manifest contract is unsupported.");
  }
  return {
    schema: WASM_OJ_JUDGE_PACKAGE_SCHEMA,
    wasmOjContract: WASM_OJ_CONTRACT_VERSION,
    judgeData: blobReference(manifest.judgeData, "judge package judgeData"),
    allowedProfiles: parseJudgeAllowedProfiles(manifest.allowedProfiles, "judge package allowedProfiles"),
    judge: judgeManifest(manifest.judge),
  };
}

function manifestReferences(manifest: JudgePackageManifest): JudgePackageBlobReference[] {
  return [
    manifest.judgeData,
    ...(manifest.judge.kind === "text" ? [] : [manifest.judge.artifact, ...manifest.judge.assets]),
  ];
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function hexBytes(value: string): Uint8Array {
  digest(value, "blob digest");
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function bytesHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeTotal(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > WASM_OJ_JUDGE_PACKAGE_MAX_BYTES) throw new TypeError("Judge package exceeds 32 MiB.");
  return result;
}

async function reference(contents: Uint8Array): Promise<JudgePackageBlobReference> {
  if (!(contents instanceof Uint8Array) || contents.byteLength < 1) throw new TypeError("Judge package blobs must be non-empty Uint8Array values.");
  return { bytes: contents.byteLength, sha256: await sha256Hex(contents) };
}

/** Author-side deterministic package builder. It never executes the trusted module. */
export async function encodeJudgePackage(input: JudgePackageInput): Promise<EncodedJudgePackage> {
  const blobs = new Map<string, Uint8Array>();
  const add = async (contents: Uint8Array): Promise<JudgePackageBlobReference> => {
    const descriptor = await reference(contents);
    const existing = blobs.get(descriptor.sha256);
    if (existing && !equalBytes(existing, contents)) throw new TypeError("Judge package encountered a SHA-256 collision.");
    if (!existing) blobs.set(descriptor.sha256, contents.slice());
    return descriptor;
  };
  const languageKeys = Object.keys(input.allowedProfiles).sort() as BuiltinLanguage[];
  const judgeDataValue = parseJudgeData(input.judgeData, languageKeys);
  const judgeData = await add(canonicalJsonBytes(judgeDataValue));
  let judge: JudgePackageManifestJudge;
  if (input.judge.kind === "text") {
    judge = { kind: "text" };
  } else {
    validateTrustedJudgeWasm(input.judge.artifact, {
      memoryLimitBytes: Math.max(...judgeDataValue.scoring.policies.map((policy) => policy.limits.memoryLimitBytes)),
    });
    const artifact = await add(input.judge.artifact);
    const assetInputs = [...input.judge.assets].sort((left, right) => left.guestPath.localeCompare(right.guestPath));
    const assets = await Promise.all(assetInputs.map(async (asset) => ({ guestPath: asset.guestPath, ...await add(asset.contents) })));
    judge = input.judge.kind === "checker"
      ? { kind: "checker", runtimeProfile: input.judge.runtimeProfile, artifact, assets, args: [...input.judge.args] }
      : { kind: "interactive", runtimeProfile: input.judge.runtimeProfile, artifact, assets, args: [...input.judge.args], inputPath: input.judge.inputPath };
  }
  const manifest = parseJudgePackageManifest({
    schema: WASM_OJ_JUDGE_PACKAGE_SCHEMA,
    wasmOjContract: WASM_OJ_CONTRACT_VERSION,
    judgeData,
    allowedProfiles: input.allowedProfiles,
    judge,
  });
  const manifestBytes = canonicalJsonBytes(manifest);
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new TypeError("Judge package manifest exceeds 256 KiB.");
  const ordered = [
    [judgeData.sha256, blobs.get(judgeData.sha256)!] as const,
    ...[...blobs].filter(([sha256]) => sha256 !== judgeData.sha256).sort(([left], [right]) => left.localeCompare(right)),
  ];
  if (ordered.length > MAX_BLOBS) throw new TypeError("Judge package contains too many blobs.");
  let total = safeTotal(HEADER_BYTES, manifestBytes.byteLength);
  for (const [, contents] of ordered) total = safeTotal(total, BLOB_HEADER_BYTES + contents.byteLength);
  const encoded = new Uint8Array(total);
  encoded.set(MAGIC, 0);
  const view = new DataView(encoded.buffer);
  view.setUint32(MAGIC.byteLength, manifestBytes.byteLength, false);
  view.setUint32(MAGIC.byteLength + 4, ordered.length, false);
  let offset = HEADER_BYTES;
  encoded.set(manifestBytes, offset);
  offset += manifestBytes.byteLength;
  for (const [sha256, contents] of ordered) {
    encoded.set(hexBytes(sha256), offset);
    offset += 32;
    view.setBigUint64(offset, BigInt(contents.byteLength), false);
    offset += 8;
    encoded.set(contents, offset);
    offset += contents.byteLength;
  }
  return {
    bytes: encoded,
    manifest,
    executionSemanticSha256: await judgePackageSemanticDigest(encoded),
  };
}

function readHeader(bytes: Uint8Array): { readonly manifestLength: number; readonly blobCount: number } {
  if (bytes.byteLength < HEADER_BYTES || !equalBytes(bytes.subarray(0, MAGIC.byteLength), MAGIC)) {
    throw new TypeError("Judge package transport magic is invalid.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const manifestLength = view.getUint32(MAGIC.byteLength, false);
  const blobCount = view.getUint32(MAGIC.byteLength + 4, false);
  if (manifestLength < 1 || manifestLength > MAX_MANIFEST_BYTES || blobCount > MAX_BLOBS) {
    throw new TypeError("Judge package transport header exceeds its limits.");
  }
  return { manifestLength, blobCount };
}

/** Read only the bounded canonical manifest from complete package bytes. */
export function readJudgePackageManifest(bytes: Uint8Array): JudgePackageManifest {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > WASM_OJ_JUDGE_PACKAGE_MAX_BYTES) throw new TypeError("Judge package bytes exceed 32 MiB.");
  const { manifestLength } = readHeader(bytes);
  if (HEADER_BYTES + manifestLength > bytes.byteLength) throw new TypeError("Judge package manifest is truncated.");
  return parseJudgePackageManifest(parseCanonicalJsonBytes(
    bytes.subarray(HEADER_BYTES, HEADER_BYTES + manifestLength),
    "judge package manifest",
  ));
}

async function* sourceChunks(source: JudgePackageByteSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        yield result.value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  for await (const chunk of source as AsyncIterable<Uint8Array>) yield chunk;
}

class PackageStreamReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Uint8Array = new Uint8Array();
  private currentOffset = 0;
  private ended = false;
  private received = 0;
  private readonly sha256 = new IncrementalSha256();

  constructor(source: JudgePackageByteSource) {
    this.iterator = sourceChunks(source)[Symbol.asyncIterator]();
  }

  get byteLength(): number { return this.received; }

  async take(length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0 || length > WASM_OJ_JUDGE_PACKAGE_MAX_BYTES) throw new TypeError("Judge package read length is invalid.");
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (this.currentOffset === this.current.byteLength) await this.pull();
      if (this.ended) throw new TypeError("Judge package transport is truncated.");
      const count = Math.min(length - written, this.current.byteLength - this.currentOffset);
      result.set(this.current.subarray(this.currentOffset, this.currentOffset + count), written);
      this.currentOffset += count;
      written += count;
    }
    return result;
  }

  async finish(): Promise<{ readonly bytes: number; readonly sha256: string }> {
    if (this.currentOffset !== this.current.byteLength) throw new TypeError("Judge package transport contains trailing bytes.");
    await this.pull();
    if (!this.ended) throw new TypeError("Judge package transport contains trailing bytes.");
    return { bytes: this.received, sha256: this.sha256.finishHex() };
  }

  private async pull(): Promise<void> {
    while (!this.ended) {
      const result = await this.iterator.next();
      if (result.done) {
        this.ended = true;
        this.current = new Uint8Array();
        this.currentOffset = 0;
        return;
      }
      if (!(result.value instanceof Uint8Array)) throw new TypeError("Judge package stream chunks must be Uint8Array values.");
      if (result.value.byteLength === 0) continue;
      this.received = safeTotal(this.received, result.value.byteLength);
      this.sha256.update(result.value);
      this.current = result.value;
      this.currentOffset = 0;
      return;
    }
  }
}

/**
 * Stream-validates one package while retaining at most the manifest and one
 * bounded blob. This is the Worker-facing admission API used before R2 publish.
 */
export async function validateJudgePackage(
  source: JudgePackageByteSource,
  options: ValidateJudgePackageOptions = {},
): Promise<ValidatedJudgePackage> {
  if (options.expectedBytes !== undefined && (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes < 1 || options.expectedBytes > WASM_OJ_JUDGE_PACKAGE_MAX_BYTES)) {
    throw new TypeError("Expected judge package byte length is invalid.");
  }
  if (options.expectedSha256 !== undefined) digest(options.expectedSha256, "expected judge package digest");
  const reader = new PackageStreamReader(source);
  const headerBytes = await reader.take(HEADER_BYTES);
  const { manifestLength, blobCount } = readHeader(headerBytes);
  const manifest = parseJudgePackageManifest(parseCanonicalJsonBytes(await reader.take(manifestLength), "judge package manifest"));

  const references = new Map<string, JudgePackageBlobReference>();
  for (const referenceValue of manifestReferences(manifest)) {
    const existing = references.get(referenceValue.sha256);
    if (existing && existing.bytes !== referenceValue.bytes) throw new TypeError("Judge package repeats one digest with different lengths.");
    references.set(referenceValue.sha256, referenceValue);
  }
  const orderedDigests = [manifest.judgeData.sha256, ...[...references.keys()].filter((sha256) => sha256 !== manifest.judgeData.sha256).sort()];
  if (blobCount !== orderedDigests.length) throw new TypeError("Judge package blob count disagrees with its manifest.");
  let judgeData: JudgeData | undefined;
  for (const expectedDigest of orderedDigests) {
    const blobHeader = await reader.take(BLOB_HEADER_BYTES);
    const actualDigest = bytesHex(blobHeader.subarray(0, 32));
    const lengthValue = new DataView(blobHeader.buffer, blobHeader.byteOffset + 32, 8).getBigUint64(0, false);
    if (lengthValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("Judge package blob length exceeds the safe integer range.");
    const length = Number(lengthValue);
    const expected = references.get(expectedDigest)!;
    if (actualDigest !== expectedDigest || length !== expected.bytes) throw new TypeError("Judge package blob header disagrees with its manifest.");
    const contents = await reader.take(length);
    if (await sha256Hex(contents) !== expectedDigest) throw new TypeError(`Judge package blob '${expectedDigest}' failed integrity verification.`);
    if (expectedDigest === manifest.judgeData.sha256) {
      judgeData = parseJudgeData(
        parseCanonicalJsonBytes(contents, "judge package judgeData"),
        Object.keys(manifest.allowedProfiles).sort() as BuiltinLanguage[],
      );
    }
    if (manifest.judge.kind !== "text" && expectedDigest === manifest.judge.artifact.sha256) {
      if (!judgeData) throw new TypeError("Judge package judgeData must precede its executable blobs.");
      const packageMemoryLimit = Math.max(...judgeData.scoring.policies.map((policy) => policy.limits.memoryLimitBytes));
      validateTrustedJudgeWasm(contents, {
        memoryLimitBytes: options.memoryLimitBytes === undefined
          ? packageMemoryLimit
          : Math.min(packageMemoryLimit, options.memoryLimitBytes),
      });
    }
  }
  const completed = await reader.finish();
  if (options.expectedBytes !== undefined && completed.bytes !== options.expectedBytes) throw new TypeError("Judge package byte length disagrees with its descriptor.");
  if (options.expectedSha256 !== undefined && completed.sha256 !== options.expectedSha256) throw new TypeError("Judge package digest disagrees with its descriptor.");
  if (!judgeData) throw new TypeError("Judge package is missing its judgeData blob.");
  return { manifest, judgeData, bytes: completed.bytes, executionSemanticSha256: completed.sha256 };
}

/** Decode a fully verified package into the exact trusted executable contract consumed by the container runtime. */
export async function decodeJudgePackageForExecution(bytes: Uint8Array): Promise<DecodedJudgePackageForExecution> {
  const validated = await validateJudgePackage(bytes);
  const { manifestLength, blobCount } = readHeader(bytes);
  let offset = HEADER_BYTES + manifestLength;
  const blobs = new Map<string, Uint8Array>();
  const executableDigests = validated.manifest.judge.kind === "text"
    ? new Set<string>()
    : new Set([validated.manifest.judge.artifact.sha256, ...validated.manifest.judge.assets.map((asset) => asset.sha256)]);
  for (let index = 0; index < blobCount; index += 1) {
    const digestValue = bytesHex(bytes.subarray(offset, offset + 32));
    const lengthValue = new DataView(bytes.buffer, bytes.byteOffset + offset + 32, 8).getBigUint64(0, false);
    const length = Number(lengthValue);
    offset += BLOB_HEADER_BYTES;
    if (executableDigests.has(digestValue)) blobs.set(digestValue, bytes.slice(offset, offset + length));
    offset += length;
  }
  let judge: TrustedJudgeExecutable;
  if (validated.manifest.judge.kind === "text") {
    judge = { kind: "text" };
  } else {
    const manifestJudge = validated.manifest.judge;
    const artifact = blobs.get(manifestJudge.artifact.sha256);
    if (!artifact) throw new TypeError("Verified judge package is missing its executable artifact.");
    const assets = manifestJudge.assets.map((asset): TrustedJudgeAsset => {
      const assetBytes = blobs.get(asset.sha256);
      if (!assetBytes) throw new TypeError(`Verified judge package is missing asset '${asset.guestPath}'.`);
      return { guestPath: asset.guestPath, bytes: assetBytes.slice() };
    });
    const base = {
      kind: manifestJudge.kind,
      runtimeProfile: manifestJudge.runtimeProfile,
      artifact: artifact.slice(),
      assets,
      args: [...manifestJudge.args],
    } as const;
    judge = manifestJudge.kind === "checker"
      ? { ...base, kind: "checker" }
      : { ...base, kind: "interactive", inputPath: manifestJudge.inputPath };
  }
  return { ...validated, allowedProfiles: validated.manifest.allowedProfiles, judge };
}

/** Execution identity is the digest of the exact canonical WOJJDG02 bytes. */
export function judgePackageSemanticDigest(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_BYTES || bytes.byteLength > WASM_OJ_JUDGE_PACKAGE_MAX_BYTES) {
    return Promise.reject(new TypeError("Judge package bytes are outside the transport limit."));
  }
  return sha256Hex(bytes);
}

// Small environment-neutral streaming SHA-256 used by Worker validation.
const SHA256_INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

class IncrementalSha256 {
  private readonly state = SHA256_INITIAL.slice();
  private readonly buffer = new Uint8Array(64);
  private bufferLength = 0;
  private totalBytes = 0;
  private finished = false;

  update(bytes: Uint8Array): void {
    if (this.finished) throw new TypeError("SHA-256 state is already finalized.");
    this.totalBytes += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = Math.min(64 - this.bufferLength, bytes.byteLength - offset);
      this.buffer.set(bytes.subarray(offset, offset + count), this.bufferLength);
      this.bufferLength += count;
      offset += count;
      if (this.bufferLength === 64) {
        this.compress(this.buffer);
        this.bufferLength = 0;
      }
    }
  }

  finishHex(): string {
    if (this.finished) throw new TypeError("SHA-256 state is already finalized.");
    this.finished = true;
    const bitLength = BigInt(this.totalBytes) * 8n;
    this.buffer[this.bufferLength++] = 0x80;
    if (this.bufferLength > 56) {
      this.buffer.fill(0, this.bufferLength);
      this.compress(this.buffer);
      this.bufferLength = 0;
    }
    this.buffer.fill(0, this.bufferLength, 56);
    new DataView(this.buffer.buffer).setBigUint64(56, bitLength, false);
    this.compress(this.buffer);
    const output = new Uint8Array(32);
    const view = new DataView(output.buffer);
    for (let index = 0; index < this.state.length; index += 1) view.setUint32(index * 4, this.state[index]!, false);
    return bytesHex(output);
  }

  private compress(block: Uint8Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]!;
      const right = words[index - 2]!;
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temporary1 = (h! + sum1 + choice + SHA256_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temporary1) >>> 0;
      d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    this.state[0] = (this.state[0]! + a!) >>> 0;
    this.state[1] = (this.state[1]! + b!) >>> 0;
    this.state[2] = (this.state[2]! + c!) >>> 0;
    this.state[3] = (this.state[3]! + d!) >>> 0;
    this.state[4] = (this.state[4]! + e!) >>> 0;
    this.state[5] = (this.state[5]! + f!) >>> 0;
    this.state[6] = (this.state[6]! + g!) >>> 0;
    this.state[7] = (this.state[7]! + h!) >>> 0;
  }
}
