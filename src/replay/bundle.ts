import { assertValidBuildArtifact } from "../core/artifact-validation.ts";
import { FORGE_CONTRACT_VERSION, FORGE_SCHEMAS } from "../core/contract.ts";
import { resolveDeterminism } from "../core/determinism.ts";
import { sha256Hex } from "../core/hash.ts";
import { assertValidProject } from "../core/project-validation.ts";
import { canonicalProjectFiles } from "../core/project-files.ts";
import { resolveResourcePolicy } from "../core/resources.ts";
import type {
  BuildArtifact,
  BuildResult,
  InteractiveRunResult,
  Project,
  RunConfig,
  RunResult,
} from "../core/types.ts";
import { artifactDigest, deterministicTranscript, type DeterministicTranscript } from "../conformance/matrix.ts";
import { assertValidDependencyLock } from "../dependencies/lock.ts";
import type { DependencyOfflineBundle } from "../dependencies/types.ts";
import type { JudgeResult } from "../judge/engine.ts";
import { validateJudgeSpec, type JudgeInputSpec, type JudgeSpec } from "../judge/spec.ts";

const MAGIC = new TextEncoder().encode("FORGRPL1");
const HEADER_BYTES = MAGIC.byteLength + 8 + 4;
const SHA256_BYTES = 32;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_BLOBS = 4_096;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SELF_CONTAINED_MATCHERS = new Set(["text", "sha256", "files", "tokens", "float", "set", "wasm-checker"]);

type PortableScalar = null | boolean | number | string;
type PortableNode = PortableScalar
  | ["a", PortableNode[]]
  | ["o", Array<[string, PortableNode]>]
  | ["b", string, number];

export interface ForgeReplayRunOperation {
  kind: "run";
  config: RunConfig;
  expected: DeterministicTranscript;
  expectedSha256: string;
}

export interface ForgeReplayJudgeCaseTranscript {
  id: string;
  verdict: JudgeResult["cases"][number]["verdict"];
  message?: string;
  run?: DeterministicTranscript;
  interaction?: Omit<InteractiveRunResult, "durationMs">;
}

export interface ForgeReplayJudgeTranscript {
  verdict: JudgeResult["verdict"];
  completed: number;
  total: number;
  cases: ForgeReplayJudgeCaseTranscript[];
  metrics: JudgeResult["metrics"];
}

export interface ForgeReplayJudgeOperation {
  kind: "judge";
  spec: JudgeSpec;
  expected: ForgeReplayJudgeTranscript;
  expectedSha256: string;
}

export type ForgeReplayOperation = ForgeReplayRunOperation | ForgeReplayJudgeOperation;

export interface ForgeReplayBundle {
  schema: typeof FORGE_SCHEMAS.replayBundle;
  forgeContract: typeof FORGE_CONTRACT_VERSION;
  projectSha256: string;
  artifactSha256: string;
  project: Project;
  artifact: BuildArtifact;
  dependencies?: DependencyOfflineBundle;
  operation: ForgeReplayOperation;
}

export type ForgeReplayBundleInput = {
  project: Project;
  artifact: BuildArtifact;
  dependencies?: DependencyOfflineBundle;
} & ({
  operation: { kind: "run"; config: RunConfig; result: RunResult };
} | {
  operation: { kind: "judge"; spec: JudgeSpec; result: JudgeResult };
});

export interface ForgeReplayHost {
  compileProject(project: Project, options?: { cache?: boolean }): Promise<BuildResult>;
  run(artifact: BuildArtifact, config: RunConfig): Promise<RunResult>;
  judge(artifact: BuildArtifact, spec: JudgeSpec): Promise<JudgeResult>;
}

export interface ForgeReplayOptions {
  /** Rebuild sources and compare the stable artifact digest before execution. Defaults to true. */
  recompile?: boolean;
}

export interface ForgeReplayResult {
  compatible: boolean;
  mismatches: readonly string[];
  build?: BuildResult;
  run?: RunResult;
  judge?: JudgeResult;
}

export interface ForgeReplayDecodeOptions {
  maxBundleBytes?: number;
  maxManifestBytes?: number;
  maxBlobs?: number;
}

export async function createForgeReplayBundle(input: ForgeReplayBundleInput): Promise<ForgeReplayBundle> {
  assertValidProject(input.project);
  const project = structuredClone(input.project);
  project.files = canonicalProjectFiles(project.files);
  project.updatedAt = 0;
  const artifactSha256 = await artifactDigest(input.artifact);
  const artifact = structuredClone(input.artifact);
  artifact.id = `replay:${artifactSha256}`;
  artifact.createdAt = 0;
  artifact.durationMs = 0;
  assertValidBuildArtifact(artifact, { project, cacheKey: artifact.cacheKey });
  const projectSha256 = await portableSha256(project);
  const dependencies = input.dependencies === undefined
    ? undefined
    : structuredClone(input.dependencies);
  if (dependencies) await assertOfflineDependencies(dependencies);

  let operation: ForgeReplayOperation;
  if (input.operation.kind === "run") {
    const config = canonicalRunConfig(input.operation.config);
    const expected = replayRunTranscript(input.operation.result);
    operation = {
      kind: "run",
      config,
      expected,
      expectedSha256: await portableSha256(expected),
    };
  } else {
    const spec = structuredClone(input.operation.spec);
    validateSelfContainedJudgeSpec(spec);
    const expected = judgeTranscript(input.operation.result);
    operation = {
      kind: "judge",
      spec,
      expected,
      expectedSha256: await portableSha256(expected),
    };
  }
  const bundle: ForgeReplayBundle = {
    schema: FORGE_SCHEMAS.replayBundle,
    forgeContract: FORGE_CONTRACT_VERSION,
    projectSha256,
    artifactSha256,
    project,
    artifact,
    ...(dependencies ? { dependencies } : {}),
    operation,
  };
  await assertValidForgeReplayBundle(bundle);
  return bundle;
}

export async function assertValidForgeReplayBundle(value: unknown): Promise<void> {
  if (!isRecord(value) || value.schema !== FORGE_SCHEMAS.replayBundle
    || value.forgeContract !== FORGE_CONTRACT_VERSION) {
    throw new Error("ForgeReplayBundle does not use the active Forge contract.");
  }
  const bundleKeys = Object.keys(value).sort();
  const expectedBundleKeys = [
    "artifact", "artifactSha256", "forgeContract", "operation", "project", "projectSha256", "schema",
    ...(value.dependencies === undefined ? [] : ["dependencies"]),
  ].sort();
  if (JSON.stringify(bundleKeys) !== JSON.stringify(expectedBundleKeys)) {
    throw new Error("ForgeReplayBundle contains unexpected fields.");
  }
  assertValidProject(value.project);
  const project = value.project;
  if (project.updatedAt !== 0) throw new Error("ForgeReplayBundle project.updatedAt must be normalized to zero.");
  if (JSON.stringify(project.files.map((file) => file.path))
    !== JSON.stringify(canonicalProjectFiles(project.files).map((file) => file.path))) {
    throw new Error("ForgeReplayBundle project files must be canonically sorted.");
  }
  requireSha256(value.projectSha256, "ForgeReplayBundle project");
  if (value.projectSha256 !== await portableSha256(project)) {
    throw new Error("ForgeReplayBundle project digest mismatch.");
  }
  assertValidBuildArtifact(value.artifact, { project, cacheKey: (value.artifact as BuildArtifact).cacheKey });
  const artifact = value.artifact;
  requireSha256(value.artifactSha256, "ForgeReplayBundle artifact");
  if (artifact.id !== `replay:${value.artifactSha256}` || artifact.createdAt !== 0 || artifact.durationMs !== 0
    || value.artifactSha256 !== await artifactDigest(artifact)) {
    throw new Error("ForgeReplayBundle artifact metadata or digest is not canonical.");
  }
  if (value.dependencies !== undefined) await assertOfflineDependencies(value.dependencies);
  if (!isRecord(value.operation) || (value.operation.kind !== "run" && value.operation.kind !== "judge")) {
    throw new Error("ForgeReplayBundle operation must be 'run' or 'judge'.");
  }
  requireSha256(value.operation.expectedSha256, "ForgeReplayBundle expected transcript");
  if (value.operation.kind === "run") {
    requireExactKeys(value.operation, ["config", "expected", "expectedSha256", "kind"], "run operation");
    const canonicalConfig = canonicalRunConfig(value.operation.config as RunConfig);
    if (JSON.stringify(await toPortableNode(value.operation.config, new Map()))
      !== JSON.stringify(await toPortableNode(canonicalConfig, new Map()))) {
      throw new Error("ForgeReplayBundle run config is not canonical.");
    }
    validateDeterministicTranscript(value.operation.expected);
  } else {
    requireExactKeys(value.operation, ["expected", "expectedSha256", "kind", "spec"], "judge operation");
    validateSelfContainedJudgeSpec(value.operation.spec as JudgeSpec);
    validateJudgeTranscript(value.operation.expected);
  }
  if (value.operation.expectedSha256 !== await portableSha256(value.operation.expected)) {
    throw new Error("ForgeReplayBundle expected transcript digest mismatch.");
  }
  // Reject accessors, class instances, functions, undefined, and other values
  // that cannot cross the canonical replay transport.
  await toPortableNode(value, new Map());
}

export async function encodeForgeReplayBundle(bundle: ForgeReplayBundle): Promise<Uint8Array> {
  await assertValidForgeReplayBundle(bundle);
  const blobs = new Map<string, Uint8Array>();
  const manifest = encoder.encode(JSON.stringify(await toPortableNode(bundle, blobs)));
  if (manifest.byteLength > MAX_MANIFEST_BYTES) throw new Error("ForgeReplayBundle manifest exceeds its byte limit.");
  const orderedBlobs = [...blobs].sort(([left], [right]) => left.localeCompare(right));
  if (orderedBlobs.length > MAX_BLOBS) throw new Error("ForgeReplayBundle contains too many binary blobs.");
  const total = orderedBlobs.reduce((size, [, bytes]) => safeAdd(size, SHA256_BYTES + 8 + bytes.byteLength), HEADER_BYTES + manifest.byteLength);
  if (total > MAX_BUNDLE_BYTES) throw new Error("ForgeReplayBundle exceeds its encoded byte limit.");
  const output = new Uint8Array(total);
  output.set(MAGIC, 0);
  const view = new DataView(output.buffer);
  writeU64(view, MAGIC.byteLength, manifest.byteLength);
  view.setUint32(MAGIC.byteLength + 8, orderedBlobs.length, false);
  let offset = HEADER_BYTES;
  output.set(manifest, offset);
  offset += manifest.byteLength;
  for (const [digest, bytes] of orderedBlobs) {
    output.set(hexToBytes(digest), offset);
    offset += SHA256_BYTES;
    writeU64(view, offset, bytes.byteLength);
    offset += 8;
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return output;
}

export async function decodeForgeReplayBundle(
  encoded: Uint8Array,
  options: ForgeReplayDecodeOptions = {},
): Promise<ForgeReplayBundle> {
  const maxBundleBytes = positiveLimit(options.maxBundleBytes ?? MAX_BUNDLE_BYTES, "replay bundle byte limit");
  const maxManifestBytes = positiveLimit(options.maxManifestBytes ?? MAX_MANIFEST_BYTES, "replay manifest byte limit");
  const maxBlobs = positiveLimit(options.maxBlobs ?? MAX_BLOBS, "replay blob count limit");
  if (!(encoded instanceof Uint8Array) || encoded.byteLength < HEADER_BYTES || encoded.byteLength > maxBundleBytes) {
    throw new Error("ForgeReplayBundle transport has an invalid byte length.");
  }
  if (!equalBytes(encoded.subarray(0, MAGIC.byteLength), MAGIC)) throw new Error("ForgeReplayBundle transport magic is invalid.");
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const manifestLength = readU64(view, MAGIC.byteLength, "ForgeReplayBundle manifest length");
  const blobCount = view.getUint32(MAGIC.byteLength + 8, false);
  if (manifestLength > maxManifestBytes || blobCount > maxBlobs) throw new Error("ForgeReplayBundle transport exceeds its decode limits.");
  let offset = HEADER_BYTES;
  if (offset + manifestLength > encoded.byteLength) throw new Error("ForgeReplayBundle manifest is truncated.");
  let node: unknown;
  let manifestText: string;
  try {
    manifestText = decoder.decode(encoded.subarray(offset, offset + manifestLength));
    node = JSON.parse(manifestText);
  } catch (error) {
    throw new Error("ForgeReplayBundle manifest is not canonical UTF-8 JSON.", { cause: error });
  }
  if (manifestText !== JSON.stringify(node)) throw new Error("ForgeReplayBundle manifest JSON is not canonical.");
  offset += manifestLength;
  const blobs = new Map<string, Uint8Array>();
  let previousDigest = "";
  for (let index = 0; index < blobCount; index += 1) {
    if (offset + SHA256_BYTES + 8 > encoded.byteLength) throw new Error("ForgeReplayBundle blob header is truncated.");
    const digest = bytesToHex(encoded.subarray(offset, offset + SHA256_BYTES));
    offset += SHA256_BYTES;
    if (digest <= previousDigest) throw new Error("ForgeReplayBundle blobs must be sorted and unique.");
    previousDigest = digest;
    const length = readU64(view, offset, `ForgeReplayBundle blob ${index} length`);
    offset += 8;
    if (offset + length > encoded.byteLength) throw new Error(`ForgeReplayBundle blob '${digest}' is truncated.`);
    const bytes = encoded.slice(offset, offset + length);
    offset += length;
    if (await sha256Hex(bytes) !== digest) throw new Error(`ForgeReplayBundle blob '${digest}' failed integrity verification.`);
    blobs.set(digest, bytes);
  }
  if (offset !== encoded.byteLength) throw new Error("ForgeReplayBundle transport has trailing bytes.");
  const used = new Set<string>();
  const decoded = fromPortableNode(node, blobs, used);
  if (used.size !== blobs.size) throw new Error("ForgeReplayBundle transport contains unreferenced blobs.");
  await assertValidForgeReplayBundle(decoded);
  // The only accepted JSON spelling is the exact canonical node encoding.
  const roundTripBlobs = new Map<string, Uint8Array>();
  if (JSON.stringify(await toPortableNode(decoded, roundTripBlobs)) !== JSON.stringify(node)) {
    throw new Error("ForgeReplayBundle manifest is not canonical.");
  }
  return decoded as ForgeReplayBundle;
}

export async function forgeReplayBundleSha256(bundle: ForgeReplayBundle): Promise<string> {
  return sha256Hex(await encodeForgeReplayBundle(bundle));
}

export async function replayForgeBundle(
  host: ForgeReplayHost,
  bundle: ForgeReplayBundle,
  options: ForgeReplayOptions = {},
): Promise<ForgeReplayResult> {
  await assertValidForgeReplayBundle(bundle);
  const mismatches: string[] = [];
  let artifact = bundle.artifact;
  let build: BuildResult | undefined;
  if (options.recompile ?? true) {
    build = await host.compileProject(structuredClone(bundle.project), { cache: false });
    if (!build.success || !build.artifact) {
      return { compatible: false, mismatches: ["build"], build };
    }
    artifact = build.artifact;
    if (await artifactDigest(artifact) !== bundle.artifactSha256) mismatches.push("artifactSha256");
  }
  if (bundle.operation.kind === "run") {
    const run = await host.run(artifact, structuredClone(bundle.operation.config));
    const actual = replayRunTranscript(run);
    mismatches.push(...diffPaths(bundle.operation.expected, actual, "run"));
    return { compatible: mismatches.length === 0, mismatches: sortedUnique(mismatches), build, run };
  }
  const judge = await host.judge(artifact, structuredClone(bundle.operation.spec));
  const actual = judgeTranscript(judge);
  mismatches.push(...diffPaths(bundle.operation.expected, actual, "judge"));
  return { compatible: mismatches.length === 0, mismatches: sortedUnique(mismatches), build, judge };
}

export function judgeTranscript(result: JudgeResult): ForgeReplayJudgeTranscript {
  return {
    verdict: result.verdict,
    completed: result.completed,
    total: result.total,
    cases: result.cases.map((item) => ({
      id: item.id,
      verdict: item.verdict,
      ...(item.message === undefined ? {} : { message: item.message }),
      ...(item.run === undefined ? {} : { run: replayRunTranscript(item.run) }),
      ...(item.interaction === undefined ? {} : { interaction: interactionTranscript(item.interaction) }),
    })),
    metrics: structuredClone(result.metrics),
  };
}

function interactionTranscript(result: InteractiveRunResult): Omit<InteractiveRunResult, "durationMs"> {
  return {
    contestant: structuredClone(result.contestant),
    interactor: structuredClone(result.interactor),
    contestantToInteractor: result.contestantToInteractor,
    interactorToContestant: result.interactorToContestant,
    determinism: structuredClone(result.determinism),
  };
}

function replayRunTranscript(result: RunResult): DeterministicTranscript {
  const transcript = deterministicTranscript(result);
  if (transcript.trapMessage === undefined) delete transcript.trapMessage;
  return transcript;
}

function canonicalRunConfig(value: RunConfig): RunConfig {
  if (!isRecord(value) || !Array.isArray(value.args) || value.args.some((item) => typeof item !== "string")
    || typeof value.stdin !== "string" || !isRecord(value.env)) {
    throw new Error("ForgeReplayBundle run config is malformed.");
  }
  const env = Object.fromEntries(Object.entries(value.env).sort(([left], [right]) => left.localeCompare(right)).map(([name, entry]) => {
    if (!name || name.includes("=") || name.includes("\0") || typeof entry !== "string" || entry.includes("\0")) {
      throw new Error(`ForgeReplayBundle run environment '${name}' is invalid.`);
    }
    return [name, entry];
  }));
  const files = Object.fromEntries(Object.entries(value.files ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => {
    requireGuestPath(path, "run input file");
    if (!(bytes instanceof Uint8Array)) throw new Error(`ForgeReplayBundle run input '${path}' must be bytes.`);
    return [path, bytes.slice()];
  }));
  const outputPaths = [...(value.outputPaths ?? [])].map((path) => requireGuestPath(path, "run output file")).sort();
  if (new Set(outputPaths).size !== outputPaths.length) throw new Error("ForgeReplayBundle run output paths must be unique.");
  const cwd = value.cwd === undefined ? undefined : requireGuestPath(value.cwd, "run cwd", true);
  return {
    args: [...value.args],
    stdin: value.stdin,
    env,
    files,
    outputPaths,
    ...(cwd === undefined ? {} : { cwd }),
    determinism: resolveDeterminism(value.determinism),
    resources: resolveResourcePolicy(value.resources),
  };
}

function validateSelfContainedJudgeSpec(spec: JudgeSpec): void {
  validateJudgeSpec(spec);
  for (const item of spec.cases) {
    requireInlineInput(item.input, `Judge case '${item.id}' stdin`);
    for (const [path, input] of Object.entries(item.files ?? {})) requireInlineInput(input, `Judge case '${item.id}' file '${path}'`);
    if (item.kind === "batch" && !SELF_CONTAINED_MATCHERS.has(item.matcher.id)) {
      throw new Error(`Judge matcher '${item.matcher.id}' is not self-contained in a replay bundle.`);
    }
  }
}

function requireInlineInput(input: JudgeInputSpec, label: string): void {
  if (input.kind !== "inline") throw new Error(`${label} must be materialized inline for an offline replay bundle.`);
}

async function assertOfflineDependencies(value: unknown): Promise<void> {
  if (!isRecord(value) || value.schema !== FORGE_SCHEMAS.dependencyOfflineBundle
    || value.forgeContract !== FORGE_CONTRACT_VERSION || !isRecord(value.payloads)) {
    throw new Error("ForgeReplayBundle dependencies must be a Forge offline dependency bundle.");
  }
  assertValidDependencyLock(value.lock);
  const lock = value.lock;
  const expected = new Set(lock.packages.map((item) => item.integritySha256));
  const actual = Object.keys(value.payloads).sort();
  if (actual.length !== expected.size || actual.some((digest) => !expected.has(digest))) {
    throw new Error("ForgeReplayBundle dependency payloads do not match their lock.");
  }
  for (const [digest, payload] of Object.entries(value.payloads)) {
    if (!(payload instanceof Uint8Array) || await sha256Hex(payload) !== digest) {
      throw new Error(`ForgeReplayBundle dependency '${digest}' failed integrity verification.`);
    }
  }
}

async function portableSha256(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(await toPortableNode(value, new Map())));
}

async function toPortableNode(value: unknown, blobs: Map<string, Uint8Array>, seen = new Set<object>()): Promise<PortableNode> {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("ForgeReplayBundle cannot encode non-finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Uint8Array) {
    const bytes = value.slice();
    const digest = await sha256Hex(bytes);
    const existing = blobs.get(digest);
    if (existing && !equalBytes(existing, bytes)) throw new Error("ForgeReplayBundle encountered a SHA-256 collision.");
    blobs.set(digest, bytes);
    return ["b", digest, bytes.byteLength];
  }
  if (typeof value !== "object" || value === undefined) throw new Error("ForgeReplayBundle contains a non-portable value.");
  if (seen.has(value)) throw new Error("ForgeReplayBundle cannot encode cyclic data.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new Error("ForgeReplayBundle arrays must be dense.");
      return ["a", await Promise.all(value.map((item) => toPortableNode(item, blobs, seen)))];
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("ForgeReplayBundle objects must be plain data records.");
    const entries: Array<[string, PortableNode]> = [];
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
        throw new Error(`ForgeReplayBundle field '${key}' is not portable.`);
      }
      entries.push([key, await toPortableNode(descriptor.value, blobs, seen)]);
    }
    return ["o", entries];
  } finally {
    seen.delete(value);
  }
}

function fromPortableNode(
  value: unknown,
  blobs: ReadonlyMap<string, Uint8Array>,
  used: Set<string>,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0))) return value;
  if (!Array.isArray(value) || value.length !== 2 && value.length !== 3) throw new Error("ForgeReplayBundle manifest contains an invalid node.");
  if (value[0] === "b" && value.length === 3 && typeof value[1] === "string" && Number.isSafeInteger(value[2])) {
    const bytes = blobs.get(value[1]);
    if (!bytes || bytes.byteLength !== value[2]) throw new Error(`ForgeReplayBundle manifest refers to missing blob '${value[1]}'.`);
    used.add(value[1]);
    return bytes.slice();
  }
  if (value[0] === "a" && value.length === 2 && Array.isArray(value[1])) {
    return value[1].map((item) => fromPortableNode(item, blobs, used));
  }
  if (value[0] === "o" && value.length === 2 && Array.isArray(value[1])) {
    const result: Record<string, unknown> = {};
    let previous = "";
    for (const entry of value[1]) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entry[0] <= previous) {
        throw new Error("ForgeReplayBundle object keys must be sorted and unique.");
      }
      if (entry[0] === "__proto__") throw new Error("ForgeReplayBundle object contains a forbidden key.");
      previous = entry[0];
      result[entry[0]] = fromPortableNode(entry[1], blobs, used);
    }
    return result;
  }
  throw new Error("ForgeReplayBundle manifest contains an unknown node tag.");
}

function validateDeterministicTranscript(value: unknown): void {
  if (!isRecord(value) || !Number.isInteger(value.code) || typeof value.stdout !== "string"
    || typeof value.stderr !== "string" || !isRecord(value.files) || typeof value.termination !== "string"
    || !isRecord(value.determinism) || !isRecord(value.resources) || !isRecord(value.metrics)) {
    throw new Error("ForgeReplayBundle run transcript is malformed.");
  }
  resolveDeterminism(value.determinism);
  resolveResourcePolicy(value.resources);
  for (const [path, hex] of Object.entries(value.files)) {
    requireGuestPath(path, "run transcript file");
    if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error(`Run transcript file '${path}' is not hexadecimal.`);
  }
}

function validateJudgeTranscript(value: unknown): void {
  if (!isRecord(value) || typeof value.verdict !== "string" || !Number.isSafeInteger(value.completed)
    || !Number.isSafeInteger(value.total) || !Array.isArray(value.cases) || !isRecord(value.metrics)) {
    throw new Error("ForgeReplayBundle judge transcript is malformed.");
  }
  for (const item of value.cases) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.verdict !== "string") {
      throw new Error("ForgeReplayBundle judge case transcript is malformed.");
    }
    if (item.run !== undefined) validateDeterministicTranscript(item.run);
  }
}

function diffPaths(expected: unknown, actual: unknown, path: string): string[] {
  if (Object.is(expected, actual)) return [];
  if (expected instanceof Uint8Array && actual instanceof Uint8Array) return equalBytes(expected, actual) ? [] : [path];
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const result: string[] = [];
    const maximum = Math.max(expected.length, actual.length);
    for (let index = 0; index < maximum && result.length < 128; index += 1) {
      result.push(...diffPaths(expected[index], actual[index], `${path}[${index}]`));
    }
    return result.slice(0, 128);
  }
  if (isRecord(expected) && isRecord(actual)) {
    const keys = sortedUnique([...Object.keys(expected), ...Object.keys(actual)]);
    const result: string[] = [];
    for (const key of keys) {
      result.push(...diffPaths(expected[key], actual[key], `${path}.${key}`));
      if (result.length >= 128) break;
    }
    return result.slice(0, 128);
  }
  return [path];
}

function requireGuestPath(value: unknown, label: string, allowRoot = false): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\\") || value.includes("\0")
    || value.includes("//") || value.split("/").some((part) => part === "." || part === "..")
    || (!allowRoot && value === "/") || (value !== "/" && value.endsWith("/"))) {
    throw new Error(`ForgeReplayBundle ${label} must be an absolute normalized guest path.`);
  }
  return value;
}

function readU64(view: DataView, offset: number, label: string): number {
  const value = view.getBigUint64(offset, false);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the safe integer range.`);
  return Number(value);
}

function writeU64(view: DataView, offset: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("ForgeReplayBundle length is invalid.");
  view.setBigUint64(offset, BigInt(value), false);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  requireSha256(value, "ForgeReplayBundle blob");
  return Uint8Array.from({ length: SHA256_BYTES }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error("ForgeReplayBundle byte length exceeds the safe integer range.");
  return result;
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function requireSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} SHA-256 is invalid.`);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`ForgeReplayBundle ${label} contains unexpected fields.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
