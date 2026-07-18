import { unzipSync } from "fflate";
import { FORGE_SCHEMAS } from "../core/contract.ts";
import { sha256Hex } from "../core/hash.ts";
import type {
  DependencyEcosystem,
  DependencyManifest,
  DependencyRequirement,
  DependencySourceFile,
  ForgeDependencyResolver,
  LockedDependencyPackage,
  ResolvedDependencyGraph,
} from "./types.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_MAX_METADATA_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

export type DependencyFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface DependencyResolverOptions {
  fetch?: DependencyFetch;
  maxMetadataBytes?: number;
  maxPackageBytes?: number;
  maxUnpackedBytes?: number;
  concurrency?: number;
  cargoCrateBaseUrl?: string;
  pypiApiUrl?: string;
  goProxyUrl?: string;
}

interface ResolvedOptions {
  fetch: DependencyFetch;
  maxMetadataBytes: number;
  maxPackageBytes: number;
  maxUnpackedBytes: number;
  concurrency: number;
  cargoCrateBaseUrl: string;
  pypiApiUrl: string;
  goProxyUrl: string;
}

interface DownloadedPackage {
  record: LockedDependencyPackage;
  payload: Uint8Array;
}

/**
 * Creates Forge's native-lockfile adapters. They consume exact versions and
 * ecosystem integrity data; they deliberately do not act as a second package solver.
 */
export function createDefaultDependencyResolvers(
  options: DependencyResolverOptions = {},
): readonly ForgeDependencyResolver[] {
  const resolved = resolveOptions(options);
  return [
    new CargoLockDependencyResolver(resolved),
    new NpmLockDependencyResolver(resolved),
    new PyPiLockDependencyResolver(resolved),
    new GoLockDependencyResolver(resolved),
    new CppLockDependencyResolver(resolved),
  ];
}

export class CargoLockDependencyResolver implements ForgeDependencyResolver {
  readonly ecosystem = "cargo" as const;
  private readonly options: ResolvedOptions;

  constructor(options: DependencyResolverOptions | ResolvedOptions = {}) {
    this.options = isResolvedOptions(options) ? options : resolveOptions(options);
  }

  async resolve(manifest: DependencyManifest): Promise<ResolvedDependencyGraph> {
    const lock = requireSource(manifest, "cargo", "lockfile", "Cargo.lock");
    const parsed = parseCargoLock(lock.contents);
    const external = parsed.filter((item) => item.source !== undefined);
    const byName = groupBy(external, (item) => item.name);
    const roots = manifest.requirements.map((requirement) => {
      const version = exactVersion(requirement, true);
      const matches = (byName.get(requirement.name) ?? []).filter((item) => item.version === version);
      if (matches.length !== 1) {
        throw new Error(`Cargo.lock must contain exactly one '${requirement.name} ${version}' package.`);
      }
      return packageId("cargo", matches[0]!.name, matches[0]!.version);
    });
    const packageIds = new Map(external.map((item) => [cargoIdentity(item.name, item.version, item.source!), packageId("cargo", item.name, item.version)]));
    const packages = await mapLimited(external, this.options.concurrency, async (item): Promise<DownloadedPackage> => {
      if (!isCratesIoSource(item.source!)) {
        throw new Error(`Cargo package '${item.name} ${item.version}' uses unsupported source '${item.source}'.`);
      }
      if (!item.checksum || !SHA256.test(item.checksum)) {
        throw new Error(`Cargo package '${item.name} ${item.version}' is missing a SHA-256 checksum.`);
      }
      const url = new URL(
        `${encodeURIComponent(item.name)}/${encodeURIComponent(item.name)}-${encodeURIComponent(item.version)}.crate`,
        this.options.cargoCrateBaseUrl,
      ).href;
      const payload = await fetchBytes(this.options, url, this.options.maxPackageBytes);
      const digest = await sha256Hex(payload);
      if (digest !== item.checksum) throw integrityError("Cargo", item.name, item.version);
      const dependencies = item.dependencies.map((reference) => {
        const target = resolveCargoDependency(reference, external);
        const id = packageIds.get(cargoIdentity(target.name, target.version, target.source!));
        if (!id) throw new Error(`Cargo dependency '${reference}' is not an external locked package.`);
        return id;
      });
      return {
        record: {
          id: packageId("cargo", item.name, item.version),
          ecosystem: "cargo",
          name: item.name,
          version: item.version,
          source: item.source!,
          integritySha256: digest,
          dependencies: sortedUnique(dependencies),
          ...featuresForRoot(manifest.requirements, item.name, item.version),
        },
        payload,
      };
    });
    return graph(roots, packages);
  }
}

export class NpmLockDependencyResolver implements ForgeDependencyResolver {
  readonly ecosystem = "npm" as const;
  private readonly options: ResolvedOptions;

  constructor(options: DependencyResolverOptions | ResolvedOptions = {}) {
    this.options = isResolvedOptions(options) ? options : resolveOptions(options);
  }

  async resolve(manifest: DependencyManifest): Promise<ResolvedDependencyGraph> {
    const source = requireSource(manifest, "npm", "lockfile", "package-lock.json");
    const lock = parseJson(source.contents, "package-lock.json") as NpmPackageLock;
    if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
      throw new Error("npm adapter requires package-lock.json lockfileVersion 2 or 3.");
    }
    if (!isRecord(lock.packages) || !isRecord(lock.packages[""])) {
      throw new Error("package-lock.json must contain its root packages entry.");
    }
    const entries = Object.entries(lock.packages)
      .filter(([path]) => path !== "")
      .map(([path, value]) => parseNpmEntry(path, value));
    const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
    const rootEntry = lock.packages[""] as Record<string, unknown>;
    const roots = manifest.requirements.map((requirement) => {
      const rootSpec = npmRootSpec(rootEntry, requirement.name);
      if (rootSpec !== undefined && rootSpec !== requirement.requirement) {
        throw new Error(`package-lock.json root requirement for '${requirement.name}' does not match '${requirement.requirement}'.`);
      }
      const entry = entryByPath.get(`node_modules/${requirement.name}`);
      if (!entry) throw new Error(`package-lock.json does not contain root package '${requirement.name}'.`);
      return packageId("npm", entry.name, entry.version);
    });
    const packages = await mapLimited(entries, this.options.concurrency, async (entry): Promise<DownloadedPackage> => {
      const payload = await fetchBytes(this.options, entry.resolved, this.options.maxPackageBytes);
      await verifySri(payload, entry.integrity, `npm package '${entry.name}@${entry.version}'`);
      const dependencies = Object.keys(entry.dependencies).map((name) => {
        const target = resolveNpmDependency(entry.path, name, entryByPath);
        return packageId("npm", target.name, target.version);
      });
      const digest = await sha256Hex(payload);
      return {
        record: {
          id: packageId("npm", entry.name, entry.version),
          ecosystem: "npm",
          name: entry.name,
          version: entry.version,
          source: entry.resolved,
          integritySha256: digest,
          dependencies: sortedUnique(dependencies),
        },
        payload,
      };
    });
    return graph(roots, deduplicatePackages(packages));
  }
}

export class PyPiLockDependencyResolver implements ForgeDependencyResolver {
  readonly ecosystem = "pypi" as const;
  private readonly options: ResolvedOptions;

  constructor(options: DependencyResolverOptions | ResolvedOptions = {}) {
    this.options = isResolvedOptions(options) ? options : resolveOptions(options);
  }

  async resolve(manifest: DependencyManifest): Promise<ResolvedDependencyGraph> {
    const source = requireSource(manifest, "pypi", "lockfile", "requirements.txt");
    const locked = parsePythonRequirements(source.contents);
    const byName = new Map(locked.map((item) => [item.name, item]));
    const roots = manifest.requirements.map((requirement) => {
      const name = normalizePythonName(requirement.name);
      const version = exactPythonVersion(requirement);
      const item = byName.get(name);
      if (!item || item.version !== version) {
        throw new Error(`requirements.txt must lock '${requirement.name}==${version}' with SHA-256.`);
      }
      return packageId("pypi", name, version);
    });
    const packages = await mapLimited(locked, this.options.concurrency, async (item): Promise<DownloadedPackage> => {
      const metadataUrl = new URL(
        `${encodeURIComponent(item.name)}/${encodeURIComponent(item.version)}/json`,
        this.options.pypiApiUrl,
      ).href;
      const metadata = parseJson(
        new TextDecoder().decode(await fetchBytes(this.options, metadataUrl, this.options.maxMetadataBytes)),
        `PyPI metadata for ${item.name}`,
      );
      const file = selectPyPiFile(metadata, item.hashes, item.name, item.version);
      const payload = await fetchBytes(this.options, file.url, this.options.maxPackageBytes);
      const digest = await sha256Hex(payload);
      if (!item.hashes.has(digest)) throw integrityError("PyPI", item.name, item.version);
      return {
        record: {
          id: packageId("pypi", item.name, item.version),
          ecosystem: "pypi",
          name: item.name,
          version: item.version,
          source: file.url,
          integritySha256: digest,
          dependencies: [],
        },
        payload,
      };
    });
    return graph(roots, packages);
  }
}

export class GoLockDependencyResolver implements ForgeDependencyResolver {
  readonly ecosystem = "go" as const;
  private readonly options: ResolvedOptions;

  constructor(options: DependencyResolverOptions | ResolvedOptions = {}) {
    this.options = isResolvedOptions(options) ? options : resolveOptions(options);
  }

  async resolve(manifest: DependencyManifest): Promise<ResolvedDependencyGraph> {
    const goMod = requireSource(manifest, "go", "manifest", "go.mod");
    const goSum = requireSource(manifest, "go", "lockfile", "go.sum");
    const required = parseGoMod(goMod.contents);
    const sums = parseGoSum(goSum.contents);
    const byPath = new Map(required.map((item) => [item.name, item]));
    const roots = manifest.requirements.map((requirement) => {
      const version = exactVersion(requirement, false);
      const item = byPath.get(requirement.name);
      if (!item || item.version !== version) {
        throw new Error(`go.mod must require '${requirement.name} ${version}'.`);
      }
      return packageId("go", item.name, item.version);
    });
    const packages = await mapLimited(required, this.options.concurrency, async (item): Promise<DownloadedPackage> => {
      const expected = sums.get(`${item.name} ${item.version}`);
      if (!expected) throw new Error(`go.sum is missing '${item.name} ${item.version}' module content hash.`);
      const url = new URL(
        `${escapeGoPath(item.name)}/@v/${escapeGoPath(item.version)}.zip`,
        this.options.goProxyUrl,
      ).href;
      const payload = await fetchBytes(this.options, url, this.options.maxPackageBytes);
      const actual = await goModuleZipHash(payload, this.options.maxUnpackedBytes);
      if (actual !== expected) throw integrityError("Go", item.name, item.version);
      return {
        record: {
          id: packageId("go", item.name, item.version),
          ecosystem: "go",
          name: item.name,
          version: item.version,
          source: url,
          integritySha256: await sha256Hex(payload),
          dependencies: [],
        },
        payload,
      };
    });
    return graph(roots, packages);
  }
}

export interface CppDependencyLockSource {
  schema: typeof FORGE_SCHEMAS.cppDependencyLock;
  roots: readonly string[];
  packages: readonly {
    name: string;
    version: string;
    url: string;
    sha256: string;
    dependencies?: readonly string[];
  }[];
}

interface NormalizedCppDependencyLock {
  schema: typeof FORGE_SCHEMAS.cppDependencyLock;
  roots: string[];
  packages: Array<{
    name: string;
    version: string;
    url: string;
    sha256: string;
    dependencies: string[];
  }>;
}

export class CppLockDependencyResolver implements ForgeDependencyResolver {
  readonly ecosystem = "cpp" as const;
  private readonly options: ResolvedOptions;

  constructor(options: DependencyResolverOptions | ResolvedOptions = {}) {
    this.options = isResolvedOptions(options) ? options : resolveOptions(options);
  }

  async resolve(manifest: DependencyManifest): Promise<ResolvedDependencyGraph> {
    const source = requireSource(manifest, "cpp", "lockfile", "forge-cpp.lock.json");
    const lock = parseCppLock(parseJson(source.contents, "forge-cpp.lock.json"));
    const records = new Map(lock.packages.map((item) => [`${item.name}@${item.version}`, item]));
    for (const requirement of manifest.requirements) {
      const version = exactVersion(requirement, false);
      if (!records.has(`${requirement.name}@${version}`)) {
        throw new Error(`forge-cpp.lock.json must contain '${requirement.name}@${version}'.`);
      }
    }
    const requiredRoots = sortedUnique(manifest.requirements.map((item) => `${item.name}@${exactVersion(item, false)}`));
    if (JSON.stringify(requiredRoots) !== JSON.stringify(lock.roots)) {
      throw new Error("forge-cpp.lock.json roots do not exactly match the C/C++ dependency manifest.");
    }
    const packages = await mapLimited(lock.packages, this.options.concurrency, async (item): Promise<DownloadedPackage> => {
      const payload = await fetchBytes(this.options, item.url, this.options.maxPackageBytes);
      const digest = await sha256Hex(payload);
      if (digest !== item.sha256) throw integrityError("C/C++", item.name, item.version);
      return {
        record: {
          id: packageId("cpp", item.name, item.version),
          ecosystem: "cpp",
          name: item.name,
          version: item.version,
          source: item.url,
          integritySha256: digest,
          dependencies: item.dependencies.map((dependency) => {
            if (!records.has(dependency)) throw new Error(`C/C++ package '${item.name}' refers to missing '${dependency}'.`);
            const split = splitNameVersion(dependency);
            return packageId("cpp", split.name, split.version);
          }),
        },
        payload,
      };
    });
    return graph(lock.roots.map((root) => {
      const split = splitNameVersion(root);
      return packageId("cpp", split.name, split.version);
    }), packages);
  }
}

/** Implements Go's official `dirhash.HashZip` h1 checksum over module ZIP entries. */
export async function goModuleZipHash(payload: Uint8Array, maxUnpackedBytes = DEFAULT_MAX_UNPACKED_BYTES): Promise<string> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(payload);
  } catch (error) {
    throw new Error("Go module payload is not a valid ZIP archive.", { cause: error });
  }
  const names = Object.keys(files).sort();
  if (!names.length) throw new Error("Go module ZIP is empty.");
  let unpacked = 0;
  let summary = "";
  for (const name of names) {
    validateZipPath(name);
    const bytes = files[name]!;
    unpacked += bytes.byteLength;
    if (unpacked > maxUnpackedBytes) throw new Error("Go module ZIP exceeds the unpacked byte limit.");
    summary += `${await sha256Hex(bytes)}  ${name}\n`;
  }
  const digest = await digestBytes("SHA-256", new TextEncoder().encode(summary));
  return `h1:${bytesToBase64(digest)}`;
}

function resolveOptions(options: DependencyResolverOptions): ResolvedOptions {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("Dependency adapters require a Fetch-compatible implementation.");
  return {
    fetch: fetcher.bind(globalThis),
    maxMetadataBytes: positiveInteger(options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES, "metadata byte limit"),
    maxPackageBytes: positiveInteger(options.maxPackageBytes ?? DEFAULT_MAX_PACKAGE_BYTES, "package byte limit"),
    maxUnpackedBytes: positiveInteger(options.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED_BYTES, "unpacked byte limit"),
    concurrency: positiveInteger(options.concurrency ?? 6, "dependency concurrency"),
    cargoCrateBaseUrl: baseUrl(options.cargoCrateBaseUrl ?? "https://static.crates.io/crates/"),
    pypiApiUrl: baseUrl(options.pypiApiUrl ?? "https://pypi.org/pypi/"),
    goProxyUrl: baseUrl(options.goProxyUrl ?? "https://proxy.golang.org/"),
  };
}

function isResolvedOptions(value: DependencyResolverOptions | ResolvedOptions): value is ResolvedOptions {
  return "maxMetadataBytes" in value && "maxPackageBytes" in value && "fetch" in value
    && "cargoCrateBaseUrl" in value && "goProxyUrl" in value;
}

async function fetchBytes(options: ResolvedOptions, rawUrl: string, maximum: number): Promise<Uint8Array> {
  const url = requireHttpsUrl(rawUrl);
  const response = await options.fetch(url, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Dependency fetch failed with HTTP ${response.status} for '${url}'.`);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new Error(`Dependency response for '${url}' exceeds the ${maximum}-byte limit.`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximum) throw new Error(`Dependency response for '${url}' exceeds the ${maximum}-byte limit.`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel("Dependency response exceeded its byte limit.");
      throw new Error(`Dependency response for '${url}' exceeds the ${maximum}-byte limit.`);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function requireSource(
  manifest: DependencyManifest,
  ecosystem: DependencyEcosystem,
  role: DependencySourceFile["role"],
  basename: string,
): DependencySourceFile {
  const matches = (manifest.sourceFiles ?? []).filter((file) =>
    file.ecosystem === ecosystem && file.role === role && file.path.split("/").at(-1) === basename
  );
  if (matches.length !== 1) throw new Error(`${ecosystem} adapter requires exactly one ${basename} ${role}.`);
  return matches[0]!;
}

interface CargoPackage {
  name: string;
  version: string;
  source?: string;
  checksum?: string;
  dependencies: string[];
}

function parseCargoLock(contents: string): CargoPackage[] {
  const version = contents.match(/^version\s*=\s*(\d+)\s*$/m)?.[1];
  if (version !== "3" && version !== "4") throw new Error("Cargo adapter requires Cargo.lock format version 3 or 4.");
  const blocks = contents.split(/^\[\[package\]\]\s*$/m).slice(1);
  if (!blocks.length) throw new Error("Cargo.lock does not contain packages.");
  return blocks.map((block) => {
    const name = cargoString(block, "name", true)!;
    const packageVersion = cargoString(block, "version", true)!;
    return {
      name,
      version: packageVersion,
      source: cargoString(block, "source", false),
      checksum: cargoString(block, "checksum", false),
      dependencies: cargoStringArray(block, "dependencies"),
    };
  });
}

function cargoString(block: string, key: string, required: boolean): string | undefined {
  const match = block.match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m"));
  if (!match) {
    if (required) throw new Error(`Cargo.lock package is missing '${key}'.`);
    return undefined;
  }
  return parseJson(match[1]!, `Cargo.lock ${key}`) as string;
}

function cargoStringArray(block: string, key: string): string[] {
  const start = block.match(new RegExp(`^${key}\\s*=\\s*\\[`, "m"));
  if (!start || start.index === undefined) return [];
  const bracket = block.indexOf("[", start.index);
  const end = block.indexOf("]", bracket + 1);
  if (end < 0) throw new Error(`Cargo.lock package has an unterminated '${key}' array.`);
  const parsed = parseJson(block.slice(bracket, end + 1).replace(/,\s*]/, "]"), `Cargo.lock ${key}`);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`Cargo.lock '${key}' must be a string array.`);
  }
  return parsed;
}

function resolveCargoDependency(reference: string, packages: readonly CargoPackage[]): CargoPackage {
  const match = reference.match(/^(\S+)(?:\s+(\S+))?(?:\s+\((.+)\))?$/);
  if (!match) throw new Error(`Invalid Cargo.lock dependency reference '${reference}'.`);
  const candidates = packages.filter((item) => item.name === match[1]
    && (match[2] === undefined || item.version === match[2])
    && (match[3] === undefined || item.source === match[3]));
  if (candidates.length !== 1) throw new Error(`Cargo.lock dependency '${reference}' is ambiguous or missing.`);
  return candidates[0]!;
}

function cargoIdentity(name: string, version: string, source: string): string {
  return `${name}\0${version}\0${source}`;
}

function isCratesIoSource(source: string): boolean {
  return source === "registry+https://github.com/rust-lang/crates.io-index"
    || source === "sparse+https://index.crates.io/";
}

interface NpmPackageLock {
  lockfileVersion?: unknown;
  packages?: unknown;
}

interface NpmEntry {
  path: string;
  name: string;
  version: string;
  resolved: string;
  integrity: string;
  dependencies: Record<string, string>;
}

function parseNpmEntry(path: string, value: unknown): NpmEntry {
  if (!isRecord(value)) throw new Error(`package-lock.json entry '${path}' must be an object.`);
  if (value.link === true) throw new Error(`package-lock.json link entry '${path}' is not portable.`);
  const name = typeof value.name === "string" ? value.name : npmNameFromPath(path);
  const version = requireText(value.version, `npm version for '${path}'`);
  const resolved = requireHttpsUrl(requireText(value.resolved, `npm resolved URL for '${path}'`));
  const integrity = requireText(value.integrity, `npm integrity for '${path}'`);
  const dependencies = value.dependencies === undefined ? {} : stringRecord(value.dependencies, `npm dependencies for '${path}'`);
  return { path, name, version, resolved, integrity, dependencies };
}

function npmNameFromPath(path: string): string {
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  if (index < 0) throw new Error(`Cannot derive an npm package name from '${path}'.`);
  const suffix = path.slice(index + marker.length);
  const parts = suffix.split("/");
  return parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : parts[0]!;
}

function npmRootSpec(root: Record<string, unknown>, name: string): string | undefined {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (isRecord(root[field]) && typeof root[field][name] === "string") return root[field][name];
  }
  return undefined;
}

function resolveNpmDependency(path: string, name: string, entries: ReadonlyMap<string, NpmEntry>): NpmEntry {
  let parent = path;
  while (true) {
    const candidate = entries.get(parent ? `${parent}/node_modules/${name}` : `node_modules/${name}`);
    if (candidate) return candidate;
    const marker = parent.lastIndexOf("/node_modules/");
    if (marker < 0) parent = "";
    else parent = parent.slice(0, marker);
    if (!parent) {
      const root = entries.get(`node_modules/${name}`);
      if (root) return root;
      break;
    }
  }
  throw new Error(`package-lock.json cannot resolve '${name}' from '${path}'.`);
}

async function verifySri(payload: Uint8Array, integrity: string, label: string): Promise<void> {
  const candidates = integrity.split(/\s+/).map((item) => item.split("?", 1)[0]!).map((item) => {
    const separator = item.indexOf("-");
    return separator < 0 ? undefined : { algorithm: item.slice(0, separator), digest: item.slice(separator + 1) };
  }).filter((item): item is { algorithm: string; digest: string } => item !== undefined)
    .filter((item) => ["sha256", "sha384", "sha512"].includes(item.algorithm));
  if (!candidates.length) throw new Error(`${label} has no supported SRI digest.`);
  for (const candidate of candidates) {
    const actual = bytesToBase64(await digestBytes(candidate.algorithm.toUpperCase().replace("SHA", "SHA-"), payload));
    if (constantTimeEqual(actual, candidate.digest)) return;
  }
  throw new Error(`${label} failed SRI verification.`);
}

interface PythonLockedRequirement {
  name: string;
  version: string;
  hashes: Set<string>;
}

function parsePythonRequirements(contents: string): PythonLockedRequirement[] {
  const logical = contents.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const result: PythonLockedRequirement[] = [];
  const names = new Set<string>();
  for (const raw of logical) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z0-9._-]+)==([^\s;]+)((?:\s+--hash=sha256:[0-9a-fA-F]{64})+)$/);
    if (!match) throw new Error(`requirements.txt entry must be exact and hash-locked: '${line}'.`);
    const name = normalizePythonName(match[1]!);
    if (names.has(name)) throw new Error(`requirements.txt contains duplicate package '${name}'.`);
    names.add(name);
    const hashes = new Set([...match[3]!.matchAll(/--hash=sha256:([0-9a-fA-F]{64})/g)].map((item) => item[1]!.toLowerCase()));
    result.push({ name, version: match[2]!, hashes });
  }
  if (!result.length) throw new Error("requirements.txt does not contain hash-locked packages.");
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function exactPythonVersion(requirement: DependencyRequirement): string {
  const match = requirement.requirement.match(/^==([^\s;]+)$/);
  if (!match) throw new Error(`PyPI requirement '${requirement.name}' must use an exact == version.`);
  return match[1]!;
}

function selectPyPiFile(metadata: unknown, hashes: ReadonlySet<string>, name: string, version: string): { url: string } {
  if (!isRecord(metadata) || !Array.isArray(metadata.urls)) throw new Error(`PyPI metadata for '${name}' has no release files.`);
  const candidates = metadata.urls.flatMap((value): Array<{ url: string; filename: string; rank: number }> => {
    if (!isRecord(value) || value.yanked === true || !isRecord(value.digests)
      || typeof value.digests.sha256 !== "string" || !hashes.has(value.digests.sha256.toLowerCase())
      || typeof value.url !== "string" || typeof value.filename !== "string") return [];
    const portableWheel = /-(?:py3|py2\.py3)-none-any\.whl$/i.test(value.filename);
    const sdist = value.packagetype === "sdist" && /\.(?:tar\.gz|zip)$/i.test(value.filename);
    if (!portableWheel && !sdist) return [];
    return [{ url: requireHttpsUrl(value.url), filename: value.filename, rank: portableWheel ? 0 : 1 }];
  });
  candidates.sort((left, right) => left.rank - right.rank || left.filename.localeCompare(right.filename));
  if (!candidates[0]) throw new Error(`PyPI package '${name}==${version}' has no hash-approved portable wheel or sdist.`);
  return { url: candidates[0].url };
}

interface GoRequirement { name: string; version: string }

function parseGoMod(contents: string): GoRequirement[] {
  if (/^\s*replace\s/m.test(contents)) throw new Error("Go replace directives are not portable and are not accepted by the deterministic adapter.");
  const result: GoRequirement[] = [];
  let inRequire = false;
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (line === "require (") { inRequire = true; continue; }
    if (inRequire && line === ")") { inRequire = false; continue; }
    const value = inRequire ? line : line.startsWith("require ") ? line.slice(8).trim() : undefined;
    if (value === undefined) continue;
    const parts = value.split(/\s+/);
    if (parts.length !== 2) throw new Error(`Unsupported go.mod require entry '${value}'.`);
    result.push({ name: parts[0]!, version: parts[1]! });
  }
  if (inRequire) throw new Error("go.mod has an unterminated require block.");
  const keys = result.map((item) => item.name);
  if (new Set(keys).size !== keys.length) throw new Error("go.mod contains duplicate module requirements.");
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

function parseGoSum(contents: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 3 || !parts[2]!.startsWith("h1:")) throw new Error(`Invalid go.sum entry '${line}'.`);
    if (parts[1]!.endsWith("/go.mod")) continue;
    const key = `${parts[0]} ${parts[1]}`;
    if (result.has(key)) throw new Error(`go.sum contains duplicate module hash '${key}'.`);
    result.set(key, parts[2]!);
  }
  return result;
}

function escapeGoPath(value: string): string {
  if (!value || value.includes("\\") || value.includes("..")) throw new Error(`Invalid Go module path or version '${value}'.`);
  return value.replace(/[A-Z]/g, (character) => `!${character.toLowerCase()}`);
}

function parseCppLock(value: unknown): NormalizedCppDependencyLock {
  if (!isRecord(value) || value.schema !== FORGE_SCHEMAS.cppDependencyLock
    || !Array.isArray(value.roots) || !Array.isArray(value.packages)) {
    throw new Error("forge-cpp.lock.json does not use the active Forge C/C++ dependency schema.");
  }
  const roots = sortedUnique(value.roots.map((item) => requireText(item, "C/C++ dependency root")));
  const packages = value.packages.map((raw) => {
    if (!isRecord(raw)) throw new Error("C/C++ locked package must be an object.");
    const name = requireText(raw.name, "C/C++ package name");
    const version = requireText(raw.version, "C/C++ package version");
    const url = requireHttpsUrl(requireText(raw.url, "C/C++ package URL"));
    const sha256 = requireText(raw.sha256, "C/C++ package SHA-256").toLowerCase();
    if (!SHA256.test(sha256)) throw new Error(`C/C++ package '${name}' has an invalid SHA-256.`);
    const dependencies = raw.dependencies === undefined ? [] : sortedUnique(stringArray(raw.dependencies, "C/C++ dependencies"));
    return { name, version, url, sha256, dependencies };
  }).sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
  const ids = packages.map((item) => `${item.name}@${item.version}`);
  if (new Set(ids).size !== ids.length) throw new Error("forge-cpp.lock.json contains duplicate packages.");
  if (roots.some((root) => !ids.includes(root))) throw new Error("forge-cpp.lock.json contains an unknown root package.");
  return { schema: FORGE_SCHEMAS.cppDependencyLock, roots, packages };
}

function graph(roots: readonly string[], packages: readonly DownloadedPackage[]): ResolvedDependencyGraph {
  const payloads: Record<string, Uint8Array> = {};
  for (const item of packages) payloads[item.record.id] = item.payload;
  return {
    roots: sortedUnique(roots),
    packages: packages.map((item) => item.record).sort((left, right) => left.id.localeCompare(right.id)),
    payloads,
  };
}

function deduplicatePackages(items: readonly DownloadedPackage[]): DownloadedPackage[] {
  const result = new Map<string, DownloadedPackage>();
  for (const item of items) {
    const existing = result.get(item.record.id);
    if (existing) {
      if (JSON.stringify(existing.record) !== JSON.stringify(item.record)
        || !constantTimeEqualBytes(existing.payload, item.payload)) {
        throw new Error(`Multiple npm install locations disagree for '${item.record.id}'.`);
      }
    } else result.set(item.record.id, item);
  }
  return [...result.values()];
}

function featuresForRoot(
  requirements: readonly DependencyRequirement[],
  name: string,
  version: string,
): Pick<LockedDependencyPackage, "features"> | Record<string, never> {
  const requirement = requirements.find((item) => item.name === name && exactVersion(item, true) === version);
  return requirement?.features?.length ? { features: sortedUnique(requirement.features) } : {};
}

function exactVersion(requirement: DependencyRequirement, allowEquals: boolean): string {
  const pattern = allowEquals ? /^=?([^\s<>=~^*,]+)$/ : /^([^\s<>=~^*,]+)$/;
  const match = requirement.requirement.match(pattern);
  if (!match) throw new Error(`${requirement.ecosystem} requirement '${requirement.name}' must use an exact version.`);
  return match[1]!;
}

function splitNameVersion(value: string): { name: string; version: string } {
  const index = value.lastIndexOf("@");
  if (index <= 0 || index === value.length - 1) throw new Error(`Invalid locked package reference '${value}'.`);
  return { name: value.slice(0, index), version: value.slice(index + 1) };
}

function packageId(ecosystem: DependencyEcosystem, name: string, version: string): string {
  return `${ecosystem}:${name}@${version}`;
}

function requireHttpsUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Dependency URL '${value}' is invalid.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`Dependency URL '${value}' must be credential-free HTTPS without a fragment.`);
  }
  return url.href;
}

function baseUrl(value: string): string {
  const url = requireHttpsUrl(value);
  return url.endsWith("/") ? url : `${url}/`;
}

function parseJson(value: string, label: string): unknown {
  try { return JSON.parse(value) as unknown; } catch (error) { throw new Error(`${label} is not valid JSON.`, { cause: error }); }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty, trimmed, NUL-free string.`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item) => requireText(item, label));
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, requireText(item, label)]));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const group = result.get(value) ?? [];
    group.push(item);
    result.set(value, group);
  }
  return result;
}

async function mapLimited<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await operation(items[index]!);
    }
  }));
  return result;
}

async function digestBytes(algorithm: string, value: Uint8Array): Promise<Uint8Array> {
  const copy = value.slice();
  return new Uint8Array(await crypto.subtle.digest(algorithm, copy));
}

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    value += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(value);
}

function constantTimeEqual(left: string, right: string): boolean {
  const maximum = Math.max(left.length, right.length);
  let different = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    different |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return different === 0;
}

function constantTimeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  const maximum = Math.max(left.length, right.length);
  let different = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) different |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return different === 0;
}

function validateZipPath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || path.includes("\0")) {
    throw new Error(`Go module ZIP contains unsafe path '${path}'.`);
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function integrityError(ecosystem: string, name: string, version: string): Error {
  return new Error(`${ecosystem} package '${name}@${version}' failed integrity verification.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
