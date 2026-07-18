import { Gunzip, unzipSync } from "fflate";
import { sha256Hex } from "../core/sha256.ts";
import { assertSafeRelativePath } from "../core/project-files.ts";
import { assertValidDependencyLock, dependencyLockSha256 } from "./lock.ts";
import type { DependencyEcosystem, DependencyLock, LockedDependencyPackage } from "./types.ts";

export const DEPENDENCY_BUILD_LIMITS = Object.freeze({
  packages: 512,
  filesPerPackage: 16_384,
  bytesPerFile: 64 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
});

export interface MaterializedDependencyPackage {
  package: LockedDependencyPackage;
  /** SHA-256 of the canonical path-and-content file tree. */
  filesSha256: string;
  /** Canonical package-root-relative files after verified archive extraction. */
  files: Readonly<Record<string, Uint8Array>>;
}

/** Archive-independent dependency input admitted by Forge compilers. */
export interface DependencyBuildBundle {
  lock: DependencyLock;
  lockSha256: string;
  packages: readonly MaterializedDependencyPackage[];
}

export interface DependencyBuildAdapter {
  readonly ecosystem: DependencyEcosystem;
  materialize(
    packageRecord: LockedDependencyPackage,
    payload: Uint8Array,
  ): Promise<Readonly<Record<string, Uint8Array>>>;
}

export function createDefaultDependencyBuildAdapters(): readonly DependencyBuildAdapter[] {
  return [
    archiveAdapter("cargo", materializeCargo),
    archiveAdapter("npm", materializeNpm),
    archiveAdapter("pypi", materializePyPi),
    archiveAdapter("go", materializeGo),
    archiveAdapter("cpp", materializeCpp),
  ];
}

export async function createDependencyBuildBundle(
  lock: DependencyLock,
  payloads: ReadonlyMap<string, Uint8Array>,
  adapters: readonly DependencyBuildAdapter[] = createDefaultDependencyBuildAdapters(),
): Promise<DependencyBuildBundle> {
  assertValidDependencyLock(lock);
  if (!(payloads instanceof Map)) throw new TypeError("Dependency payloads must be a package-ID keyed Map.");
  if (!Array.isArray(adapters)) throw new TypeError("Dependency build adapters must be an array.");
  if (lock.packages.length > DEPENDENCY_BUILD_LIMITS.packages) {
    throw new RangeError(`Dependency build contains more than ${DEPENDENCY_BUILD_LIMITS.packages} packages.`);
  }
  const adapterByEcosystem = new Map<DependencyEcosystem, DependencyBuildAdapter>();
  for (const adapter of adapters) {
    if (!adapter || typeof adapter !== "object" || typeof adapter.materialize !== "function") {
      throw new TypeError("Dependency build adapters must implement materialize().");
    }
    if (adapterByEcosystem.has(adapter.ecosystem)) {
      throw new Error(`Dependency build adapter '${adapter.ecosystem}' is registered more than once.`);
    }
    adapterByEcosystem.set(adapter.ecosystem, adapter);
  }
  const expectedIds = new Set(lock.packages.map((item) => item.id));
  const unexpected = [...payloads.keys()].filter((id) => !expectedIds.has(id)).sort();
  if (unexpected.length > 0) throw new Error(`Dependency payloads contain unknown packages: ${unexpected.join(", ")}.`);

  let totalBytes = 0;
  const packages: MaterializedDependencyPackage[] = [];
  for (const packageRecord of lock.packages) {
    const payload = payloads.get(packageRecord.id);
    if (!(payload instanceof Uint8Array)) throw new Error(`Dependency payload '${packageRecord.id}' is missing.`);
    if (await sha256Hex(payload) !== packageRecord.integritySha256) {
      throw new Error(`Dependency payload '${packageRecord.id}' failed integrity verification.`);
    }
    const adapter = adapterByEcosystem.get(packageRecord.ecosystem);
    if (!adapter) throw new Error(`No dependency build adapter is registered for '${packageRecord.ecosystem}'.`);
    const files = canonicalDependencyFiles(await adapter.materialize(packageRecord, payload), packageRecord.id);
    totalBytes += Object.values(files).reduce((sum, bytes) => sum + bytes.byteLength, 0);
    if (totalBytes > DEPENDENCY_BUILD_LIMITS.totalBytes) {
      throw new RangeError(`Dependency build exceeds ${DEPENDENCY_BUILD_LIMITS.totalBytes} extracted bytes.`);
    }
    packages.push(Object.freeze({
      package: structuredClone(packageRecord),
      filesSha256: await dependencyFileTreeSha256(files),
      files: Object.freeze(files),
    }));
  }
  const bundle: DependencyBuildBundle = Object.freeze({
    lock: structuredClone(lock),
    lockSha256: await dependencyLockSha256(lock),
    packages: Object.freeze(packages),
  });
  await verifyDependencyBuildBundle(bundle);
  return bundle;
}

/** Re-verify a caller-provided build bundle before it enters a compiler cache key. */
export async function verifyDependencyBuildBundle(bundle: DependencyBuildBundle): Promise<void> {
  assertValidDependencyBuildBundle(bundle);
  if (await dependencyLockSha256(bundle.lock) !== bundle.lockSha256) {
    throw new Error("Dependency build lock digest does not match its canonical lock.");
  }
  for (const item of bundle.packages) {
    if (await dependencyFileTreeSha256(item.files) !== item.filesSha256) {
      throw new Error(`Dependency package '${item.package.id}' file-tree digest mismatch.`);
    }
  }
}

export function assertValidDependencyBuildBundle(value: unknown): asserts value is DependencyBuildBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Dependency build bundle must be an object.");
  }
  const bundle = value as DependencyBuildBundle;
  assertValidDependencyLock(bundle.lock);
  requireSha256(bundle.lockSha256, "Dependency build lock");
  if (!Array.isArray(bundle.packages) || bundle.packages.length !== bundle.lock.packages.length) {
    throw new Error("Dependency build packages must exactly match the dependency lock.");
  }
  let totalBytes = 0;
  for (const [index, item] of bundle.packages.entries()) {
    if (!item || typeof item !== "object" || item.package.id !== bundle.lock.packages[index]?.id) {
      throw new Error("Dependency build packages must use canonical lock order.");
    }
    requireSha256(item.filesSha256, `Dependency package '${item.package.id}' file tree`);
    const files = canonicalDependencyFiles(item.files, item.package.id, false);
    totalBytes += Object.values(files).reduce((sum, bytes) => sum + bytes.byteLength, 0);
  }
  if (totalBytes > DEPENDENCY_BUILD_LIMITS.totalBytes) {
    throw new RangeError(`Dependency build exceeds ${DEPENDENCY_BUILD_LIMITS.totalBytes} extracted bytes.`);
  }
}

export async function dependencyFileTreeSha256(files: Readonly<Record<string, Uint8Array>>): Promise<string> {
  const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const [path, bytes] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    entries.push({ path, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) });
  }
  return sha256Hex(JSON.stringify(entries));
}

function archiveAdapter(
  ecosystem: DependencyEcosystem,
  materialize: (record: LockedDependencyPackage, payload: Uint8Array) => Record<string, Uint8Array>,
): DependencyBuildAdapter {
  return Object.freeze({
    ecosystem,
    async materialize(record: LockedDependencyPackage, payload: Uint8Array) {
      return materialize(record, payload);
    },
  });
}

function materializeCargo(record: LockedDependencyPackage, payload: Uint8Array): Record<string, Uint8Array> {
  const files = stripArchiveRoot(extractTar(gunzip(payload, record.id)), `${record.name}-${record.version}`, record.id);
  const manifest = requiredUtf8(files, "Cargo.toml", record.id);
  if (/^\s*proc-macro\s*=\s*true\s*$/m.test(manifest)) unsupported(record, "proc-macro crates");
  if (/^\s*build\s*=\s*(?:true|"[^"]+")\s*$/m.test(manifest) || Object.hasOwn(files, "build.rs")) {
    unsupported(record, "Cargo build scripts");
  }
  if (/^\s*links\s*=\s*"/m.test(manifest)) unsupported(record, "native Cargo links");
  rejectExtensions(files, record, [".a", ".o", ".so", ".dylib", ".dll", ".wasm"]);
  return files;
}

function materializeNpm(record: LockedDependencyPackage, payload: Uint8Array): Record<string, Uint8Array> {
  const files = stripArchiveRoot(extractTar(gunzip(payload, record.id)), "package", record.id);
  const packageJson = JSON.parse(requiredUtf8(files, "package.json", record.id)) as Record<string, unknown>;
  if (packageJson.scripts && typeof packageJson.scripts === "object") {
    const scripts = packageJson.scripts as Record<string, unknown>;
    const lifecycle = ["preinstall", "install", "postinstall", "prepare"].find((name) => scripts[name] !== undefined);
    if (lifecycle) unsupported(record, `npm '${lifecycle}' lifecycle scripts`);
  }
  rejectExtensions(files, record, [".node", ".so", ".dylib", ".dll"]);
  return files;
}

function materializePyPi(record: LockedDependencyPackage, payload: Uint8Array): Record<string, Uint8Array> {
  if (!new URL(record.source).pathname.toLowerCase().endsWith(".whl")) {
    unsupported(record, "PyPI source distributions and build backends");
  }
  const files = extractZip(payload, record.id);
  rejectExtensions(files, record, [".so", ".pyd", ".dylib", ".dll"]);
  const dataPrefix = Object.keys(files).find((path) => path.includes(".data/purelib/"));
  if (dataPrefix) unsupported(record, "wheel .data installation remapping");
  return files;
}

function materializeGo(record: LockedDependencyPackage, payload: Uint8Array): Record<string, Uint8Array> {
  const files = extractZip(payload, record.id);
  const prefix = `${record.name}@${record.version}`;
  const stripped = stripArchiveRoot(files, prefix, record.id);
  rejectExtensions(stripped, record, [".a", ".o", ".so", ".dylib", ".dll"]);
  if (Object.keys(stripped).some((path) => path.endsWith(".s") || path.endsWith(".S"))) {
    unsupported(record, "Go assembly sources");
  }
  return stripped;
}

function materializeCpp(record: LockedDependencyPackage, payload: Uint8Array): Record<string, Uint8Array> {
  const files = isZip(payload)
    ? extractZip(payload, record.id)
    : extractTar(gunzip(payload, record.id));
  const stripped = stripSingleCommonRoot(files);
  rejectExtensions(stripped, record, [".a", ".o", ".so", ".dylib", ".dll", ".wasm"]);
  return stripped;
}

function extractZip(payload: Uint8Array, id: string): Record<string, Uint8Array> {
  let extracted: Record<string, Uint8Array>;
  let count = 0;
  let totalBytes = 0;
  try {
    extracted = unzipSync(payload, {
      filter(file) {
        if (file.name.endsWith("/")) return false;
        count += 1;
        totalBytes += file.originalSize;
        if (count > DEPENDENCY_BUILD_LIMITS.filesPerPackage
          || file.originalSize > DEPENDENCY_BUILD_LIMITS.bytesPerFile
          || totalBytes > DEPENDENCY_BUILD_LIMITS.totalBytes) {
          throw new RangeError(`Dependency '${id}' ZIP exceeds its extracted-file limits.`);
        }
        return true;
      },
    });
  } catch (error) {
    throw new Error(`Dependency '${id}' is not a valid ZIP archive.`, { cause: error });
  }
  return Object.fromEntries(Object.entries(extracted).filter(([path]) => !path.endsWith("/")));
}

function gunzip(payload: Uint8Array, id: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let complete = false;
  try {
    const gunzip = new Gunzip((chunk, final) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > DEPENDENCY_BUILD_LIMITS.totalBytes + DEPENDENCY_BUILD_LIMITS.filesPerPackage * 512) {
        throw new RangeError(`Dependency '${id}' gzip exceeds its extracted-byte limit.`);
      }
      chunks.push(chunk.slice());
      complete = final;
    });
    gunzip.push(payload, true);
  } catch (error) {
    if (error instanceof RangeError && error.message.startsWith(`Dependency '${id}'`)) throw error;
    throw new Error(`Dependency '${id}' is not a valid gzip archive.`, { cause: error });
  }
  if (!complete) throw new Error(`Dependency '${id}' gzip stream is incomplete.`);
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function extractTar(payload: Uint8Array): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  let offset = 0;
  let pendingLongPath: string | undefined;
  let pendingPaxPath: string | undefined;
  while (offset + 512 <= payload.byteLength) {
    const header = payload.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    verifyTarChecksum(header);
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const size = tarNumber(header.subarray(124, 136), "tar entry size");
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > payload.byteLength) throw new Error("Dependency tar entry exceeds its archive.");
    const data = payload.slice(dataStart, dataEnd);
    const rawPath = pendingPaxPath ?? pendingLongPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPaxPath = undefined;
    pendingLongPath = undefined;
    if (type === "L") pendingLongPath = tarText(data);
    else if (type === "x") pendingPaxPath = paxPath(data);
    else if (type === "g") paxPath(data);
    else if (type === "0" || type === "\0") files[rawPath] = data;
    else if (type !== "5") throw new Error(`Dependency tar entry '${rawPath}' uses unsupported type '${type}'.`);
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (offset > payload.byteLength) throw new Error("Dependency tar archive has invalid block padding.");
  return files;
}

function verifyTarChecksum(header: Uint8Array): void {
  const expected = tarNumber(header.subarray(148, 156), "tar header checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index]!;
  }
  if (actual !== expected) throw new Error("Dependency tar header checksum mismatch.");
}

function tarNumber(bytes: Uint8Array, label: string): number {
  if ((bytes[0]! & 0x80) !== 0) throw new Error(`${label} uses unsupported base-256 encoding.`);
  const value = tarText(bytes).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error(`${label} is not canonical octal.`);
  const number = value ? Number.parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} exceeds the supported range.`);
  return number;
}

function tarText(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(nul < 0 ? bytes : bytes.subarray(0, nul));
}

function paxPath(bytes: Uint8Array): string | undefined {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let offset = 0;
  let path: string | undefined;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space < 0) throw new Error("Dependency PAX header has an invalid record length.");
    const length = Number(text.slice(offset, space));
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > text.length) {
      throw new Error("Dependency PAX header record exceeds its payload.");
    }
    const record = text.slice(space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

function stripArchiveRoot(
  files: Record<string, Uint8Array>,
  root: string,
  id: string,
): Record<string, Uint8Array> {
  const prefix = `${root}/`;
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.some(([path]) => !path.startsWith(prefix))) {
    throw new Error(`Dependency '${id}' archive must use canonical root '${root}/'.`);
  }
  return Object.fromEntries(entries.map(([path, bytes]) => [path.slice(prefix.length), bytes]));
}

function stripSingleCommonRoot(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const paths = Object.keys(files);
  if (paths.length === 0) return files;
  const root = paths[0]!.split("/")[0]!;
  return paths.every((path) => path.startsWith(`${root}/`))
    ? Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path.slice(root.length + 1), bytes]))
    : files;
}

function canonicalDependencyFiles(
  value: Readonly<Record<string, Uint8Array>>,
  id: string,
  clone = true,
): Record<string, Uint8Array> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Dependency '${id}' materializer must return a file record.`);
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0 || entries.length > DEPENDENCY_BUILD_LIMITS.filesPerPackage) {
    throw new RangeError(`Dependency '${id}' must contain 1-${DEPENDENCY_BUILD_LIMITS.filesPerPackage} files.`);
  }
  const result: Record<string, Uint8Array> = {};
  for (const [path, bytes] of entries) {
    assertSafeRelativePath(path, `Dependency '${id}' file path`);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > DEPENDENCY_BUILD_LIMITS.bytesPerFile) {
      throw new RangeError(`Dependency '${id}' file '${path}' exceeds its byte limit.`);
    }
    result[path] = clone ? bytes.slice() : bytes;
  }
  return result;
}

function requiredUtf8(files: Record<string, Uint8Array>, path: string, id: string): string {
  const bytes = files[path];
  if (!bytes) throw new Error(`Dependency '${id}' omits required '${path}'.`);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function rejectExtensions(files: Record<string, Uint8Array>, record: LockedDependencyPackage, extensions: string[]): void {
  const path = Object.keys(files).find((candidate) => extensions.some((extension) => candidate.toLowerCase().endsWith(extension)));
  if (path) unsupported(record, `prebuilt/native file '${path}'`);
}

function unsupported(record: LockedDependencyPackage, feature: string): never {
  throw new Error(`Dependency '${record.id}' requires unsupported ${feature}.`);
}

function requireSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} SHA-256 must be lowercase hexadecimal.`);
  }
}

function isZip(payload: Uint8Array): boolean {
  return payload.byteLength >= 4 && payload[0] === 0x50 && payload[1] === 0x4b
    && (payload[2] === 0x03 || payload[2] === 0x05 || payload[2] === 0x07);
}
