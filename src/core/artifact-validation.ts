import { FORGE_CONTRACT_VERSION, FORGE_SCHEMAS } from "./contract.ts";
import { costProfileId, isCostProfileFor } from "./cost-profile.ts";
import {
  canonicalFileEntries,
  canonicalFileRecord,
  canonicalProjectFiles,
  assertSafeRelativePath,
} from "./project-files.ts";
import {
  TOOLCHAINS,
  toolchainPackageIdentities,
} from "./toolchains.ts";
import {
  assertLanguageIdentifier,
  isBuiltinLanguage,
  type BuildArtifact,
  type Language,
  type Project,
  type RuntimeBundleArtifact,
  type TargetAbi,
} from "./types.ts";

const encoder = new TextEncoder();
const RUNTIME_COMMANDS = Object.freeze({
  python: "python",
  javascript: "qjs",
  typescript: "qjs",
} as const);

interface RuntimeBundleManifestData {
  name: string;
  target: TargetAbi;
  language: Language;
  runtimePackage: string;
  command: string;
  entry: string;
  files: readonly string[];
}

export interface ArtifactBuildExpectation {
  readonly project: Project;
  readonly cacheKey: string;
}

function requiredTrimmedString(value: unknown, label: string, maximum = 16_384): asserts value is string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty, trimmed string of at most ${maximum} characters.`);
  }
}

function serializeRuntimeBundleManifest(data: RuntimeBundleManifestData): string {
  return JSON.stringify({
    schema: FORGE_SCHEMAS.runtimeBundle,
    version: FORGE_CONTRACT_VERSION,
    name: data.name,
    target: data.target,
    language: data.language,
    runtime: { package: data.runtimePackage, command: data.command },
    execution: { deterministic: true, contractVersion: FORGE_CONTRACT_VERSION },
    entry: data.entry,
    files: [...data.files],
  }, null, 2);
}

/** Canonical Forge manifest constructor for built-in and downstream runtime bundles. */
export function createRuntimeBundleManifest(
  project: Project,
  runtimePackage: string,
  command: string,
  entry: string,
): string {
  requiredTrimmedString(project.name, "Project name");
  requiredTrimmedString(runtimePackage, "Runtime package");
  requiredTrimmedString(command, "Runtime command", 128);
  assertLanguageIdentifier(project.config.language);
  assertSafeRelativePath(entry, "Runtime bundle entry");
  return serializeRuntimeBundleManifest({
    name: project.name,
    target: project.config.target,
    language: project.config.language,
    runtimePackage,
    command,
    entry,
    files: canonicalProjectFiles(project.files).map((file) => file.path),
  });
}

function parseRuntimeBundleManifest(artifact: RuntimeBundleArtifact): RuntimeBundleManifestData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact.manifest);
  } catch (error) {
    throw new Error("Runtime bundle manifest is not valid JSON.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Runtime bundle manifest must be a JSON object.");
  }
  const manifest = parsed as Record<string, unknown>;
  const runtime = manifest.runtime;
  const execution = manifest.execution;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new Error("Runtime bundle manifest runtime must be an object.");
  }
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    throw new Error("Runtime bundle manifest execution must be an object.");
  }
  const runtimeRecord = runtime as Record<string, unknown>;
  const executionRecord = execution as Record<string, unknown>;
  requiredTrimmedString(manifest.name, "Runtime bundle manifest name");
  requiredTrimmedString(runtimeRecord.package, "Runtime bundle manifest package");
  requiredTrimmedString(runtimeRecord.command, "Runtime bundle manifest command", 128);
  if (manifest.target !== "wasip1" && manifest.target !== "wasix") {
    throw new Error("Runtime bundle manifest has an invalid target.");
  }
  if (typeof manifest.language !== "string") throw new Error("Runtime bundle manifest has an invalid language.");
  assertLanguageIdentifier(manifest.language);
  if (typeof manifest.entry !== "string") throw new Error("Runtime bundle manifest has an invalid entry.");
  assertSafeRelativePath(manifest.entry, "Runtime bundle manifest entry");
  if (!Array.isArray(manifest.files)) throw new Error("Runtime bundle manifest files must be an array.");
  const files = manifest.files.map((path, index) => {
    assertSafeRelativePath(path, `Runtime bundle manifest file ${index}`);
    return path;
  });
  const canonicalFiles = [...files].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (new Set(files).size !== files.length || JSON.stringify(files) !== JSON.stringify(canonicalFiles)) {
    throw new Error("Runtime bundle manifest files must be unique and canonically sorted.");
  }
  if (
    manifest.schema !== FORGE_SCHEMAS.runtimeBundle
    || manifest.version !== FORGE_CONTRACT_VERSION
    || executionRecord.deterministic !== true
    || executionRecord.contractVersion !== FORGE_CONTRACT_VERSION
  ) {
    throw new Error("Runtime bundle manifest does not match the current Forge contract.");
  }
  const data: RuntimeBundleManifestData = {
    name: manifest.name,
    target: manifest.target,
    language: manifest.language,
    runtimePackage: runtimeRecord.package,
    command: runtimeRecord.command,
    entry: manifest.entry,
    files,
  };
  if (artifact.manifest !== serializeRuntimeBundleManifest(data)) {
    throw new Error("Runtime bundle manifest must use the canonical Forge representation without extra fields.");
  }
  return data;
}

function expectedBuiltinArtifactName(project: Project): string {
  switch (project.config.language) {
    case "c":
    case "cpp":
    case "go":
    case "rust":
      return `${project.name}.wasm`;
    case "python":
      return `${project.name}.python-${project.config.target}.json`;
    case "javascript":
    case "typescript":
      return `${project.name}.${project.config.language}-${project.config.target}.json`;
    default:
      throw new Error(`Forge has no built-in artifact name for '${project.config.language}'.`);
  }
}

function expectedRuntimeEntry(project: Project): string {
  if (project.config.language === "python") {
    if (!project.config.entry.endsWith(".py")) throw new Error("Python entry files must end in '.py'.");
    return `build/${project.config.entry.slice(0, -3)}.pyc`;
  }
  if (project.config.language === "typescript") {
    if (!project.config.entry.endsWith(".ts")) throw new Error("TypeScript entry files must end in '.ts'.");
    return `${project.config.entry.slice(0, -3)}.js`;
  }
  return project.config.entry;
}

function assertArtifactMetadata(artifact: Record<string, unknown>): void {
  if (artifact.forgeContract !== FORGE_CONTRACT_VERSION) {
    throw new Error(
      `Artifact Forge contract '${String(artifact.forgeContract)}' is unsupported; expected '${FORGE_CONTRACT_VERSION}'.`,
    );
  }
  requiredTrimmedString(artifact.id, "Artifact id");
  requiredTrimmedString(artifact.projectId, "Artifact projectId");
  requiredTrimmedString(artifact.cacheKey, "Artifact cacheKey");
  requiredTrimmedString(artifact.name, "Artifact name");
  if (typeof artifact.language !== "string") throw new Error("Artifact language must be a string.");
  assertLanguageIdentifier(artifact.language);
  if (artifact.target !== "wasip1" && artifact.target !== "wasix") throw new Error("Artifact target is invalid.");
  if (artifact.optimization !== "debug" && artifact.optimization !== "release") {
    throw new Error("Artifact optimization is invalid.");
  }
  if (typeof artifact.createdAt !== "number" || !Number.isFinite(artifact.createdAt) || artifact.createdAt < 0) {
    throw new Error("Artifact createdAt must be a non-negative finite number.");
  }
  if (typeof artifact.durationMs !== "number" || !Number.isFinite(artifact.durationMs) || artifact.durationMs < 0) {
    throw new Error("Artifact durationMs must be a non-negative finite number.");
  }
  if (!Number.isSafeInteger(artifact.size) || (artifact.size as number) < 0) {
    throw new Error("Artifact size must be a non-negative safe integer.");
  }
  if (!Array.isArray(artifact.toolchains)) throw new Error("Artifact toolchains must be an array.");
  const toolchains = artifact.toolchains as unknown[];
  if (
    toolchains.length === 0
    || toolchains.some((identity) => typeof identity !== "string" || !identity || identity !== identity.trim())
    || new Set(toolchains).size !== toolchains.length
  ) {
    throw new Error("Artifact toolchains must be non-empty, unique, trimmed identities.");
  }
  requiredTrimmedString(artifact.costProfile, "Artifact costProfile");
}

function assertBuiltinContract(artifact: BuildArtifact): void {
  if (!isBuiltinLanguage(artifact.language)) return;
  const toolchain = TOOLCHAINS[artifact.language];
  if (!toolchain.targets.includes(artifact.target)) {
    throw new Error(`Artifact target '${artifact.target}' is unsupported for built-in language '${artifact.language}'.`);
  }
  if (artifact.kind !== toolchain.artifact) {
    throw new Error(
      `Built-in '${artifact.language}' artifacts must use kind '${toolchain.artifact}', not '${artifact.kind}'.`,
    );
  }
  const expectedToolchains = toolchainPackageIdentities(artifact.language);
  if (JSON.stringify(artifact.toolchains) !== JSON.stringify(expectedToolchains)) {
    throw new Error(`Artifact toolchains do not match the canonical '${artifact.language}' toolchain identities.`);
  }
  const expectedProfile = costProfileId(artifact.language, artifact.target, artifact.optimization);
  if (artifact.costProfile !== expectedProfile) {
    throw new Error(
      `Artifact cost profile '${artifact.costProfile}' does not match `
      + `${artifact.language}/${artifact.target}/${artifact.optimization}.`,
    );
  }
  if (artifact.kind === "runtime-bundle") {
    const expectedCommand = RUNTIME_COMMANDS[artifact.language as keyof typeof RUNTIME_COMMANDS];
    if (artifact.runtimePackage !== toolchain.runtimePackage || artifact.command !== expectedCommand) {
      throw new Error(`Built-in '${artifact.language}' artifact runtime package or command is not canonical.`);
    }
  }
}

function assertBundle(artifact: RuntimeBundleArtifact): RuntimeBundleManifestData {
  requiredTrimmedString(artifact.runtimePackage, "Runtime bundle package");
  requiredTrimmedString(artifact.command, "Runtime bundle command", 128);
  assertSafeRelativePath(artifact.entry, "Runtime bundle entry");
  requiredTrimmedString(artifact.manifest, "Runtime bundle manifest", 1_048_576);
  const entries = canonicalFileEntries(artifact.files);
  for (const [path, contents] of entries) {
    if (typeof contents !== "string" && !(contents instanceof Uint8Array)) {
      throw new Error(`Runtime bundle file '${path}' must contain text or Uint8Array bytes.`);
    }
  }
  if (!Object.hasOwn(artifact.files, artifact.entry)) {
    throw new Error(`Runtime bundle entry '${artifact.entry}' is not present in its files.`);
  }
  if (artifact.files["forge.manifest.json"] !== artifact.manifest) {
    throw new Error("Runtime bundle must contain its exact manifest at 'forge.manifest.json'.");
  }
  const manifest = parseRuntimeBundleManifest(artifact);
  if (
    manifest.target !== artifact.target
    || manifest.language !== artifact.language
    || manifest.runtimePackage !== artifact.runtimePackage
    || manifest.command !== artifact.command
    || manifest.entry !== artifact.entry
  ) {
    throw new Error("Runtime bundle manifest metadata does not match its artifact metadata.");
  }
  return manifest;
}

/**
 * Fail-closed compatibility boundary for cache, compiler, and runner inputs.
 * Built-in languages are bound to Forge's exact artifact/runtime/toolchain
 * profile; downstream languages retain their own toolchain and runtime driver.
 */
export function assertValidBuildArtifact(
  candidate: unknown,
  expectation?: ArtifactBuildExpectation,
): asserts candidate is BuildArtifact {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Build artifact must be an object.");
  }
  const record = candidate as Record<string, unknown>;
  assertArtifactMetadata(record);
  if (record.kind !== "wasm" && record.kind !== "runtime-bundle") {
    throw new Error("Artifact kind must be 'wasm' or 'runtime-bundle'.");
  }
  const artifact = candidate as BuildArtifact;
  let manifest: RuntimeBundleManifestData | undefined;
  let payloadSize: number;
  if (artifact.kind === "wasm") {
    if (!(artifact.bytes instanceof Uint8Array)) throw new Error("Wasm artifact bytes must be a Uint8Array.");
    payloadSize = artifact.bytes.byteLength;
  } else {
    manifest = assertBundle(artifact);
    payloadSize = canonicalFileEntries(artifact.files).reduce(
      (total, [, contents]) => total + (typeof contents === "string" ? encoder.encode(contents).byteLength : contents.byteLength),
      0,
    );
  }
  if (artifact.size !== payloadSize) {
    throw new Error(`Artifact size ${artifact.size} does not match payload size ${payloadSize}.`);
  }
  assertBuiltinContract(artifact);
  if (!isBuiltinLanguage(artifact.language) && !isCostProfileFor(
    artifact.costProfile,
    artifact.language,
    artifact.target,
    artifact.optimization,
  )) {
    throw new Error(
      `Artifact cost profile '${artifact.costProfile}' does not match `
      + `${artifact.language}/${artifact.target}/${artifact.optimization}.`,
    );
  }

  if (!expectation) return;
  const { project, cacheKey } = expectation;
  canonicalProjectFiles(project.files);
  const expected = {
    cacheKey,
    projectId: project.id,
    language: project.config.language,
    target: project.config.target,
    optimization: project.config.optimization,
  } as const;
  for (const key of ["cacheKey", "projectId", "language", "target", "optimization"] as const) {
    if (artifact[key] !== expected[key]) {
      throw new Error(
        `Artifact ${key} '${String(artifact[key])}' does not match build identity '${String(expected[key])}'.`,
      );
    }
  }
  if (!isBuiltinLanguage(project.config.language)) return;
  const expectedName = expectedBuiltinArtifactName(project);
  if (artifact.name !== expectedName) {
    throw new Error(`Artifact name '${artifact.name}' does not match build identity '${expectedName}'.`);
  }
  if (artifact.kind === "runtime-bundle") {
    const expectedEntry = expectedRuntimeEntry(project);
    if (artifact.entry !== expectedEntry) {
      throw new Error(`Artifact entry '${artifact.entry}' does not match build identity '${expectedEntry}'.`);
    }
    const expectedManifest = createRuntimeBundleManifest(
      project,
      artifact.runtimePackage,
      artifact.command,
      expectedEntry,
    );
    if (artifact.manifest !== expectedManifest || manifest?.name !== project.name) {
      throw new Error("Runtime bundle manifest does not match the canonical project build identity.");
    }
  }
}

/** Produces a new record whose insertion order is canonical and path-safe. */
export function canonicalRuntimeBundleFiles(
  files: Readonly<Record<string, string | Uint8Array>>,
): Record<string, string | Uint8Array> {
  return canonicalFileRecord(files);
}
