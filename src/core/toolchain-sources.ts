import { WASM_OJ_CONTRACT_VERSION, WASM_OJ_SCHEMAS } from "./contract.ts";
import { PINNED_TOOLCHAIN_ASSET_SHA256 } from "./toolchains.ts";
import {
  assertLanguageIdentifier,
  type BrowserToolchainSource,
  type OptimizationLevel,
  type ServerToolchainSource,
  type TargetAbi,
  type ToolchainAssetDescriptor,
  type ToolchainDescriptor,
  type ToolchainProfile,
  type ToolchainSource,
} from "./types.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_PATH_PATTERN = /^\/toolchains\/[A-Za-z0-9][A-Za-z0-9._+/-]*$/;
const BROWSER_BASE_SENTINEL = new URL("https://wasm-oj.invalid/");

export interface ToolchainAssetSource<Source extends ToolchainSource = ToolchainSource> {
  source: Source;
  asset: ToolchainAssetDescriptor;
}

export interface ToolchainProfileSource<Source extends ToolchainSource = ToolchainSource> {
  source: Source;
  profile: ToolchainProfile;
}

/**
 * Validates a complete, homogeneous toolchain-source set at the host boundary.
 * No source is inferred and no duplicate language, profile, or asset ownership
 * is accepted.
 */
export function validateToolchainDescriptors<Source extends ToolchainSource>(
  sources: readonly Source[],
  expectedKind?: Source["kind"],
): readonly Source[] {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("At least one explicit WASM-OJ toolchain source is required.");
  }

  const kind = expectedKind ?? sources[0]?.kind;
  if (kind !== "browser" && kind !== "server") {
    throw new Error("Toolchain sources must declare either the 'browser' or 'server' host kind.");
  }

  const ids = new Set<string>();
  const languages = new Set<string>();
  const profiles = new Set<string>();
  const assets = new Set<string>();

  for (const [sourceIndex, source] of sources.entries()) {
    assertObject(source, `Toolchain source ${sourceIndex}`);
    if (source.kind !== kind) {
      throw new Error(`Toolchain source ${sourceIndex} has host kind '${String(source.kind)}'; expected '${kind}'.`);
    }
    if (kind === "browser") {
      assertExactKeys(source, ["kind", "descriptor", "baseUrl"], `Browser toolchain source ${sourceIndex}`);
      assertBrowserBaseUrl((source as unknown as BrowserToolchainSource).baseUrl, sourceIndex);
    } else {
      assertExactKeys(source, ["kind", "descriptor", "directory"], `Server toolchain source ${sourceIndex}`);
      assertServerDirectory((source as unknown as ServerToolchainSource).directory, sourceIndex);
    }

    const descriptor = source.descriptor;
    validateDescriptor(descriptor, sourceIndex);
    if (ids.has(descriptor.id)) {
      throw new Error(`Toolchain descriptor id '${descriptor.id}' is registered more than once.`);
    }
    ids.add(descriptor.id);

    for (const language of descriptor.languages) {
      if (languages.has(language)) {
        throw new Error(`Toolchain language '${language}' is owned by more than one descriptor.`);
      }
      languages.add(language);
    }
    for (const profile of descriptor.profiles) {
      const key = profileKey(profile.language, profile.target, profile.optimization);
      if (profiles.has(key)) throw new Error(`Toolchain profile '${key}' is registered more than once.`);
      profiles.add(key);
    }
    for (const asset of descriptor.assets) {
      if (assets.has(asset.path)) {
        throw new Error(`Toolchain asset '${asset.path}' is owned by more than one descriptor.`);
      }
      assets.add(asset.path);
    }
  }

  return sources;
}

export function validateBrowserToolchainSources(
  sources: readonly BrowserToolchainSource[],
): readonly BrowserToolchainSource[] {
  return validateToolchainDescriptors(sources, "browser");
}

export function validateServerToolchainSources(
  sources: readonly ServerToolchainSource[],
): readonly ServerToolchainSource[] {
  return validateToolchainDescriptors(sources, "server");
}

/** Returns an immutable, structured-clone-safe browser source snapshot. */
export function snapshotBrowserToolchainSources(
  sources: readonly BrowserToolchainSource[],
): readonly BrowserToolchainSource[] {
  validateBrowserToolchainSources(sources);
  const snapshot = sources.map((source) => Object.freeze({
    kind: "browser" as const,
    baseUrl: source.baseUrl,
    descriptor: freezeDescriptor(source.descriptor),
  }));
  return Object.freeze(snapshot);
}

export function toolchainAssetSource<Source extends ToolchainSource>(
  sources: readonly Source[],
  path: string,
): ToolchainAssetSource<Source> {
  assertAssetPath(path, "Requested toolchain asset path");
  let found: ToolchainAssetSource<Source> | undefined;
  for (const source of sources) {
    const asset = source.descriptor.assets.find((candidate) => candidate.path === path);
    if (!asset) continue;
    if (found) throw new Error(`Toolchain asset '${path}' has more than one source.`);
    found = { source, asset };
  }
  if (!found) throw new Error(`No explicit toolchain source declares asset '${path}'.`);
  return found;
}

export function toolchainProfileSource<Source extends ToolchainSource>(
  sources: readonly Source[],
  language: string,
  target: TargetAbi,
  optimization: OptimizationLevel,
): ToolchainProfileSource<Source> {
  const key = profileKey(language, target, optimization);
  let found: ToolchainProfileSource<Source> | undefined;
  for (const source of sources) {
    const profile = source.descriptor.profiles.find(
      (candidate) => profileKey(candidate.language, candidate.target, candidate.optimization) === key,
    );
    if (!profile) continue;
    if (found) throw new Error(`Toolchain profile '${key}' has more than one source.`);
    found = { source, profile };
  }
  if (!found) throw new Error(`No explicit toolchain source declares profile '${key}'.`);
  return found;
}

export function browserToolchainAssetBaseUrl(
  sources: readonly BrowserToolchainSource[],
  path: string,
  resolutionBaseUrl: string | URL,
): URL {
  const { source } = toolchainAssetSource(sources, path);
  const base = new URL(source.baseUrl, resolutionBaseUrl);
  if (!base.pathname.endsWith("/")) {
    throw new Error(`Browser toolchain base URL '${source.baseUrl}' must end with '/'.`);
  }
  return base;
}

export function browserToolchainAssetUrl(
  sources: readonly BrowserToolchainSource[],
  path: string,
  resolutionBaseUrl: string | URL,
): URL {
  const { asset } = toolchainAssetSource(sources, path);
  const base = browserToolchainAssetBaseUrl(sources, path, resolutionBaseUrl);
  const inheritedSearch = [...base.searchParams];
  base.search = "";
  const url = new URL(asset.path.slice(asset.path.lastIndexOf("/") + 1), base);
  for (const [name, value] of inheritedSearch) url.searchParams.append(name, value);
  url.searchParams.set("sha256", asset.sha256);
  return url;
}

function validateDescriptor(descriptor: ToolchainDescriptor, sourceIndex: number): void {
  const label = `Toolchain descriptor ${sourceIndex}`;
  assertObject(descriptor, label);
  assertExactKeys(
    descriptor,
    ["schema", "id", "version", "wasmOjContract", "languages", "profiles", "assets"],
    label,
  );
  if (descriptor.schema !== WASM_OJ_SCHEMAS.toolchainPackage) {
    throw new Error(`${label} schema '${String(descriptor.schema)}' is unsupported; expected '${WASM_OJ_SCHEMAS.toolchainPackage}'.`);
  }
  if (descriptor.wasmOjContract !== WASM_OJ_CONTRACT_VERSION) {
    throw new Error(`${label} contract '${String(descriptor.wasmOjContract)}' is unsupported; expected '${WASM_OJ_CONTRACT_VERSION}'.`);
  }
  assertTrimmedString(descriptor.id, `${label} id`, 214);
  assertTrimmedString(descriptor.version, `${label} version`, 128);
  if (!Array.isArray(descriptor.languages) || descriptor.languages.length === 0) {
    throw new Error(`${label} must declare at least one language.`);
  }
  if (!Array.isArray(descriptor.profiles) || descriptor.profiles.length === 0) {
    throw new Error(`${label} must declare at least one build profile.`);
  }
  if (!Array.isArray(descriptor.assets) || descriptor.assets.length === 0) {
    throw new Error(`${label} must declare at least one digest-pinned asset.`);
  }

  const descriptorLanguages = new Set<string>();
  for (const language of descriptor.languages) {
    assertLanguageIdentifier(language);
    if (descriptorLanguages.has(language)) throw new Error(`${label} repeats language '${language}'.`);
    descriptorLanguages.add(language);
  }

  const descriptorProfiles = new Set<string>();
  for (const [profileIndex, profile] of descriptor.profiles.entries()) {
    assertObject(profile, `${label} profile ${profileIndex}`);
    assertExactKeys(profile, ["language", "target", "optimization"], `${label} profile ${profileIndex}`);
    assertLanguageIdentifier(profile.language);
    if (!descriptorLanguages.has(profile.language)) {
      throw new Error(`${label} profile ${profileIndex} references undeclared language '${profile.language}'.`);
    }
    if (profile.target !== "wasip1" && profile.target !== "wasix") {
      throw new Error(`${label} profile ${profileIndex} has unsupported target '${String(profile.target)}'.`);
    }
    if (profile.optimization !== "debug" && profile.optimization !== "release") {
      throw new Error(`${label} profile ${profileIndex} has unsupported optimization '${String(profile.optimization)}'.`);
    }
    const key = profileKey(profile.language, profile.target, profile.optimization);
    if (descriptorProfiles.has(key)) throw new Error(`${label} repeats profile '${key}'.`);
    descriptorProfiles.add(key);
  }
  for (const language of descriptorLanguages) {
    if (!descriptor.profiles.some((profile) => profile.language === language)) {
      throw new Error(`${label} language '${language}' has no build profile.`);
    }
  }

  const descriptorAssets = new Set<string>();
  for (const [assetIndex, asset] of descriptor.assets.entries()) {
    const assetLabel = `${label} asset ${assetIndex}`;
    assertObject(asset, assetLabel);
    assertExactKeys(asset, ["path", "bytes", "sha256", "exportPath"], assetLabel);
    assertAssetPath(asset.path, `${assetLabel} path`);
    if (descriptorAssets.has(asset.path)) throw new Error(`${label} repeats asset '${asset.path}'.`);
    descriptorAssets.add(asset.path);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) {
      throw new Error(`${assetLabel} bytes must be a positive safe integer.`);
    }
    if (!SHA256_PATTERN.test(asset.sha256)) {
      throw new Error(`${assetLabel} sha256 must be a lowercase hexadecimal SHA-256 digest.`);
    }
    const expectedDigest = PINNED_TOOLCHAIN_ASSET_SHA256[asset.path];
    if (expectedDigest !== undefined && asset.sha256 !== expectedDigest) {
      throw new Error(`${assetLabel} digest '${asset.sha256}' does not match the WASM-OJ pin '${expectedDigest}'.`);
    }
    const expectedExportPath = `./assets/${asset.path.slice(asset.path.lastIndexOf("/") + 1)}`;
    if (asset.exportPath !== expectedExportPath) {
      throw new Error(`${assetLabel} exportPath must be '${expectedExportPath}'.`);
    }
  }
}

function assertBrowserBaseUrl(baseUrl: string, sourceIndex: number): void {
  assertTrimmedString(baseUrl, `Browser toolchain source ${sourceIndex} baseUrl`, 4_096);
  let parsed: URL;
  try {
    parsed = baseUrl.startsWith("/")
      ? new URL(baseUrl, BROWSER_BASE_SENTINEL)
      : new URL(baseUrl);
  } catch {
    throw new Error(`Browser toolchain source ${sourceIndex} baseUrl must be absolute or root-relative.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Browser toolchain source ${sourceIndex} baseUrl must use HTTP or HTTPS.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Browser toolchain source ${sourceIndex} baseUrl must not contain credentials.`);
  }
  if (parsed.hash) throw new Error(`Browser toolchain source ${sourceIndex} baseUrl must not contain a fragment.`);
  if (!parsed.pathname.endsWith("/")) {
    throw new Error(`Browser toolchain source ${sourceIndex} baseUrl must identify a directory and end with '/'.`);
  }
}

function assertServerDirectory(directory: URL, sourceIndex: number): void {
  if (!(directory instanceof URL)) {
    throw new Error(`Server toolchain source ${sourceIndex} directory must be a URL.`);
  }
  if (directory.protocol !== "file:") {
    throw new Error(`Server toolchain source ${sourceIndex} directory must use the file: protocol.`);
  }
  if (directory.search || directory.hash || !directory.pathname.endsWith("/")) {
    throw new Error(`Server toolchain source ${sourceIndex} directory must be a query-free directory URL ending with '/'.`);
  }
}

function assertAssetPath(path: string, label: string): void {
  if (!ASSET_PATH_PATTERN.test(path) || path.includes("//")) {
    throw new Error(`${label} must be a canonical absolute path below '/toolchains/'.`);
  }
  const segments = path.split("/");
  if (segments.includes(".") || segments.includes("..")) {
    throw new Error(`${label} must not contain traversal segments.`);
  }
}

function profileKey(language: string, target: TargetAbi, optimization: OptimizationLevel): string {
  return `${language}/${target}/${optimization}`;
}

function freezeDescriptor(descriptor: ToolchainDescriptor): ToolchainDescriptor {
  return Object.freeze({
    ...descriptor,
    languages: Object.freeze([...descriptor.languages]),
    profiles: Object.freeze(descriptor.profiles.map((profile) => Object.freeze({ ...profile }))),
    assets: Object.freeze(descriptor.assets.map((asset) => Object.freeze({ ...asset }))),
  });
}

function assertObject(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} must contain exactly: ${canonical.join(", ")}.`);
  }
}

function assertTrimmedString(value: unknown, label: string, maximumLength: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.length > maximumLength) {
    throw new Error(`${label} must be a non-empty trimmed string of at most ${maximumLength} characters.`);
  }
}
