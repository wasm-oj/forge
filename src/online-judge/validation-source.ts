import { canonicalJsonBytes, parseCanonicalJsonBytes } from "../core/canonical-json.ts";
import { FORGE_SCHEMAS } from "../core/contract.ts";
import { sha256Hex } from "../core/sha256.ts";
import {
  parseProblemCollectionIndex,
  verifyProblemBundleBytes,
  verifyProblemCollectionRevision,
  type ProblemCollectionIndex,
} from "../judge/problem-catalog-loader.ts";
import type { JudgeProblem } from "../judge/problem-model.ts";
import {
  parseManagedCollectionContract,
  type ManagedCollectionContract,
  type ManagedJudgeContract,
  type ManagedJudgeProgram,
  type ManagedProblemContract,
} from "./managed-collection.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000]+$/;
const MAX_CANONICAL_OBJECTS = 132_000;
const MAX_CANONICAL_BYTES = 256 * 1024 * 1024;

export const VALIDATION_SOURCE_SCHEMA = FORGE_SCHEMAS.validationSource;

export interface ValidationSourceProvenance {
  readonly githubRepositoryId: number;
  readonly commitSha: string;
  readonly indexPath: string;
  readonly archiveSha256: string;
}

export interface ValidationSourceObjectReference {
  readonly sha256: string;
  readonly bytes: number;
}

export interface ValidationSourceRepositoryFile extends ValidationSourceObjectReference {
  readonly repositoryPath: string;
}

export interface ValidationSourceProgram {
  readonly language: string;
  readonly target: "wasip1" | "wasix";
  readonly optimization: "debug" | "release";
  readonly entry: string;
  readonly files: readonly (ValidationSourceRepositoryFile & { readonly path: string })[];
}

export interface ValidationSourceJudgeProgram extends ValidationSourceProgram {
  readonly args: readonly string[];
  readonly assets: readonly (ValidationSourceRepositoryFile & { readonly path: string })[];
}

export type ValidationSourceJudge =
  | { readonly kind: "text" }
  | { readonly kind: "checker"; readonly program: ValidationSourceJudgeProgram }
  | { readonly kind: "interactive"; readonly inputPath: string; readonly program: ValidationSourceJudgeProgram };

export interface ForgeValidationSource {
  readonly schema: typeof VALIDATION_SOURCE_SCHEMA;
  readonly provenance: {
    readonly provider: "github";
    readonly githubRepositoryId: number;
    readonly commitSha: string;
    readonly indexPath: string;
    readonly archiveSha256: string;
  };
  readonly collectionRevision: string;
  readonly index: ValidationSourceRepositoryFile;
  readonly managed: ValidationSourceRepositoryFile;
  readonly problems: readonly {
    readonly id: string;
    readonly bundle: ValidationSourceRepositoryFile;
    readonly references: readonly ValidationSourceProgram[];
    readonly judge: ValidationSourceJudge;
  }[];
  readonly objects: readonly ValidationSourceObjectReference[];
}

export interface CreatedValidationSource {
  readonly source: ForgeValidationSource;
  readonly objects: ReadonlyMap<string, Uint8Array>;
}

export interface VerifiedValidationSource {
  readonly index: ProblemCollectionIndex;
  readonly managed: ManagedCollectionContract;
  readonly problems: readonly {
    readonly problem: JudgeProblem;
    readonly managed: ManagedProblemContract;
  }[];
  readonly repositoryFiles: ReadonlyMap<string, Uint8Array>;
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

function path(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || !PATH.test(value)) {
    throw new TypeError(`${label} must be a normalized relative POSIX path.`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function bytes(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 32 * 1024 * 1024) {
    throw new TypeError(`${label} is outside the canonical object limit.`);
  }
  return value as number;
}

function fileReference(value: unknown, label: string): ValidationSourceRepositoryFile {
  const item = record(value, label);
  exact(item, ["bytes", "repositoryPath", "sha256"], label);
  return {
    repositoryPath: path(item.repositoryPath, `${label}.repositoryPath`),
    sha256: digest(item.sha256, `${label}.sha256`),
    bytes: bytes(item.bytes, `${label}.bytes`),
  };
}

function guestPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 2 || value.length > 512 || !/^\/(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000]+$/.test(value)) {
    throw new TypeError(`${label} must be an absolute normalized guest file path.`);
  }
  return value;
}

function sourceProgram(
  value: unknown,
  label: string,
  declaredObjects: Set<string>,
): ValidationSourceProgram {
  const reference = record(value, label);
  exact(reference, ["entry", "files", "language", "optimization", "target"], label);
  if (typeof reference.language !== "string" || !/^[a-z]+$/.test(reference.language) || (reference.target !== "wasip1" && reference.target !== "wasix") || (reference.optimization !== "debug" && reference.optimization !== "release")) {
    throw new TypeError(`${label} compile profile is invalid.`);
  }
  const entry = path(reference.entry, `${label} entry`);
  if (!Array.isArray(reference.files) || reference.files.length < 1 || reference.files.length > 128) throw new TypeError(`${label} files are invalid.`);
  const projectPaths = new Set<string>();
  const repositoryPaths = new Set<string>();
  const files = reference.files.map((item, fileIndex) => {
    const file = record(item, `${label} file ${fileIndex}`);
    exact(file, ["bytes", "path", "repositoryPath", "sha256"], `${label} file ${fileIndex}`);
    const parsed = {
      path: path(file.path, `${label} file path`),
      repositoryPath: path(file.repositoryPath, `${label} file repositoryPath`),
      sha256: digest(file.sha256, `${label} file sha256`),
      bytes: bytes(file.bytes, `${label} file bytes`),
    };
    if (projectPaths.has(parsed.path) || repositoryPaths.has(parsed.repositoryPath)) throw new TypeError(`${label} repeats a source path.`);
    projectPaths.add(parsed.path);
    repositoryPaths.add(parsed.repositoryPath);
    declaredObjects.add(parsed.sha256);
    return parsed;
  });
  if (!projectPaths.has(entry)) throw new TypeError(`${label} entry is not declared.`);
  return {
    language: reference.language,
    target: reference.target,
    optimization: reference.optimization,
    entry,
    files,
  };
}

function judgeProgram(
  value: unknown,
  label: string,
  kind: "checker" | "interactive",
  declaredObjects: Set<string>,
): ValidationSourceJudgeProgram {
  const candidate = record(value, label);
  exact(candidate, ["args", "assets", "entry", "files", "language", "optimization", "target"], label);
  const source = sourceProgram({
    language: candidate.language,
    target: candidate.target,
    optimization: candidate.optimization,
    entry: candidate.entry,
    files: candidate.files,
  }, label, declaredObjects);
  if (!Array.isArray(candidate.args) || candidate.args.length > 64 || candidate.args.some((item) => typeof item !== "string" || item.includes("\0") || new TextEncoder().encode(item).byteLength > 4_096)) {
    throw new TypeError(`${label} args are invalid.`);
  }
  if (!Array.isArray(candidate.assets) || candidate.assets.length > 256) throw new TypeError(`${label} assets are invalid.`);
  const guestPaths = new Set<string>();
  const repositoryPaths = new Set(source.files.map((file) => file.repositoryPath));
  const namespace = kind === "checker" ? "/checker/assets/" : "/interactor/assets/";
  const assets = candidate.assets.map((item, assetIndex) => {
    const file = record(item, `${label} asset ${assetIndex}`);
    exact(file, ["bytes", "path", "repositoryPath", "sha256"], `${label} asset ${assetIndex}`);
    const parsed = {
      path: guestPath(file.path, `${label} asset path`),
      repositoryPath: path(file.repositoryPath, `${label} asset repositoryPath`),
      sha256: digest(file.sha256, `${label} asset sha256`),
      bytes: bytes(file.bytes, `${label} asset bytes`),
    };
    if (!parsed.path.startsWith(namespace)) throw new TypeError(`${label} asset path must be inside '${namespace}'.`);
    if (guestPaths.has(parsed.path) || repositoryPaths.has(parsed.repositoryPath)) throw new TypeError(`${label} repeats an asset path.`);
    guestPaths.add(parsed.path);
    repositoryPaths.add(parsed.repositoryPath);
    declaredObjects.add(parsed.sha256);
    return parsed;
  });
  return { ...source, args: [...candidate.args] as string[], assets };
}

function judgeReference(value: unknown, label: string, declaredObjects: Set<string>): ValidationSourceJudge {
  const judge = record(value, label);
  if (judge.kind === "text") {
    exact(judge, ["kind"], label);
    return { kind: "text" };
  }
  if (judge.kind === "checker") {
    exact(judge, ["kind", "program"], label);
    return { kind: "checker", program: judgeProgram(judge.program, `${label} program`, "checker", declaredObjects) };
  }
  if (judge.kind === "interactive") {
    exact(judge, ["inputPath", "kind", "program"], label);
    const inputPath = guestPath(judge.inputPath, `${label} inputPath`);
    if (!inputPath.startsWith("/interactor/input/")) throw new TypeError(`${label} inputPath must be inside '/interactor/input/'.`);
    return {
      kind: "interactive",
      inputPath,
      program: judgeProgram(judge.program, `${label} program`, "interactive", declaredObjects),
    };
  }
  throw new TypeError(`${label} kind is unsupported.`);
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new TypeError(`${label} is not valid UTF-8 JSON.`, { cause: error });
  }
}

function repositoryPath(indexPath: string, relative: string): string {
  return [...indexPath.split("/").slice(0, -1), ...relative.split("/")].join("/");
}

function assertProvenance(value: ValidationSourceProvenance): void {
  if (!Number.isSafeInteger(value.githubRepositoryId) || value.githubRepositoryId < 1) throw new TypeError("githubRepositoryId is invalid.");
  if (!COMMIT.test(value.commitSha)) throw new TypeError("commitSha must be an exact Git commit SHA.");
  path(value.indexPath, "indexPath");
  digest(value.archiveSha256, "archiveSha256");
}

function sourceObject(
  repositoryPathValue: string,
  contents: Uint8Array,
  objects: Map<string, Uint8Array>,
): Promise<ValidationSourceRepositoryFile> {
  return sha256Hex(contents).then((sha256) => {
    const existing = objects.get(sha256);
    if (existing && (existing.byteLength !== contents.byteLength || existing.some((byte, index) => byte !== contents[index]))) {
      throw new TypeError("A SHA-256 collision was detected while extracting canonical source.");
    }
    if (!existing) objects.set(sha256, contents.slice());
    return { repositoryPath: repositoryPathValue, sha256, bytes: contents.byteLength };
  });
}

function requiredFile(files: ReadonlyMap<string, Uint8Array>, repositoryPathValue: string): Uint8Array {
  const value = files.get(repositoryPathValue);
  if (!value) throw new TypeError(`Repository does not contain declared file '${repositoryPathValue}'.`);
  return value;
}

async function extractProgramFiles(
  program: Pick<ManagedJudgeProgram, "files"> | ManagedProblemContract["references"][number],
  repositoryFiles: ReadonlyMap<string, Uint8Array>,
  objects: Map<string, Uint8Array>,
  label: string,
): Promise<(ValidationSourceRepositoryFile & { readonly path: string })[]> {
  const files = [];
  for (const declared of program.files) {
    const contents = requiredFile(repositoryFiles, declared.repositoryPath);
    if (contents.byteLength !== declared.bytes || await sha256Hex(contents) !== declared.sha256) {
      throw new TypeError(`${label} '${declared.repositoryPath}' failed integrity verification.`);
    }
    files.push({ path: declared.path, ...await sourceObject(declared.repositoryPath, contents, objects) });
  }
  return files;
}

async function extractJudge(
  judge: ManagedJudgeContract,
  repositoryFiles: ReadonlyMap<string, Uint8Array>,
  objects: Map<string, Uint8Array>,
): Promise<ValidationSourceJudge> {
  if (judge.kind === "text") return { kind: "text" };
  const files = await extractProgramFiles(judge.program, repositoryFiles, objects, `${judge.kind} source`);
  const assets = [];
  for (const declared of judge.program.assets) {
    const contents = requiredFile(repositoryFiles, declared.repositoryPath);
    if (contents.byteLength !== declared.bytes || await sha256Hex(contents) !== declared.sha256) {
      throw new TypeError(`${judge.kind} asset '${declared.repositoryPath}' failed integrity verification.`);
    }
    assets.push({ path: declared.path, ...await sourceObject(declared.repositoryPath, contents, objects) });
  }
  const program: ValidationSourceJudgeProgram = {
    language: judge.program.language,
    target: judge.program.target,
    optimization: judge.program.optimization,
    entry: judge.program.entry,
    files,
    assets,
    args: [...judge.program.args],
  };
  return judge.kind === "checker"
    ? { kind: "checker", program }
    : { kind: "interactive", inputPath: judge.inputPath, program };
}

/** Extract only integrity-declared collection bytes from an untrusted repository archive. */
export async function createForgeValidationSource(
  provenance: ValidationSourceProvenance,
  repositoryFiles: ReadonlyMap<string, Uint8Array>,
): Promise<CreatedValidationSource> {
  assertProvenance(provenance);
  const objects = new Map<string, Uint8Array>();
  const rawIndex = requiredFile(repositoryFiles, provenance.indexPath);
  const index = parseProblemCollectionIndex(parseJson(rawIndex, provenance.indexPath));
  await verifyProblemCollectionRevision(index);
  const canonicalIndex = canonicalJsonBytes(index);
  const indexReference = await sourceObject(provenance.indexPath, canonicalIndex, objects);

  const managedPath = [...provenance.indexPath.split("/").slice(0, -1), "managed.json"].join("/");
  const managed = parseManagedCollectionContract(parseJson(requiredFile(repositoryFiles, managedPath), managedPath));
  if (managed.collectionRevision !== index.revision || managed.problems.length !== index.problems.length) {
    throw new TypeError("Managed collection does not match the immutable browser index.");
  }
  const canonicalManaged = canonicalJsonBytes(managed);
  const managedReference = await sourceObject(managedPath, canonicalManaged, objects);

  const problems = [];
  for (const [problemIndex, entry] of index.problems.entries()) {
    const managedProblem = managed.problems[problemIndex];
    if (!managedProblem || managedProblem.id !== entry.id) throw new TypeError(`Managed collection is missing problem '${entry.id}'.`);
    const bundlePath = repositoryPath(provenance.indexPath, entry.bundle.path);
    const bundleBytes = requiredFile(repositoryFiles, bundlePath);
    await verifyProblemBundleBytes(bundleBytes, entry);
    const bundle = await sourceObject(bundlePath, bundleBytes, objects);
    const references = [];
    for (const program of managedProblem.references) {
      const files = await extractProgramFiles(program, repositoryFiles, objects, "Reference source");
      references.push({
        language: program.language,
        target: program.target,
        optimization: program.optimization,
        entry: program.entry,
        files,
      });
    }
    const judge = await extractJudge(managedProblem.judge, repositoryFiles, objects);
    problems.push({ id: entry.id, bundle, references, judge });
  }
  if (objects.size > MAX_CANONICAL_OBJECTS) throw new TypeError("Canonical source contains too many objects.");
  const totalBytes = [...objects.values()].reduce((total, item) => total + item.byteLength, 0);
  if (totalBytes > MAX_CANONICAL_BYTES) throw new TypeError("Canonical source exceeds 256 MiB.");
  const source = parseForgeValidationSource({
    schema: VALIDATION_SOURCE_SCHEMA,
    provenance: { provider: "github", ...provenance },
    collectionRevision: index.revision,
    index: indexReference,
    managed: managedReference,
    problems,
    objects: [...objects.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sha256, value]) => ({ sha256, bytes: value.byteLength })),
  });
  return { source, objects };
}

export function parseForgeValidationSource(value: unknown): ForgeValidationSource {
  const source = record(value, "validation source");
  exact(source, ["collectionRevision", "index", "managed", "objects", "problems", "provenance", "schema"], "validation source");
  if (source.schema !== VALIDATION_SOURCE_SCHEMA) throw new TypeError("Validation source schema is unsupported.");
  const provenance = record(source.provenance, "validation source provenance");
  exact(provenance, ["archiveSha256", "commitSha", "githubRepositoryId", "indexPath", "provider"], "validation source provenance");
  if (provenance.provider !== "github") throw new TypeError("Validation source provider is unsupported.");
  const parsedProvenance = {
    githubRepositoryId: provenance.githubRepositoryId as number,
    commitSha: provenance.commitSha as string,
    indexPath: provenance.indexPath as string,
    archiveSha256: provenance.archiveSha256 as string,
  };
  assertProvenance(parsedProvenance);
  const revision = digest(source.collectionRevision, "collectionRevision");
  const index = fileReference(source.index, "validation source index");
  const managed = fileReference(source.managed, "validation source managed contract");
  if (index.repositoryPath !== parsedProvenance.indexPath) throw new TypeError("Validation source index path disagrees with provenance.");
  const expectedManagedPath = [...parsedProvenance.indexPath.split("/").slice(0, -1), "managed.json"].join("/");
  if (managed.repositoryPath !== expectedManagedPath) throw new TypeError("Validation source managed path is invalid.");
  if (!Array.isArray(source.objects) || source.objects.length < 3 || source.objects.length > MAX_CANONICAL_OBJECTS) throw new TypeError("Validation source object inventory is invalid.");
  const objectDigests = new Set<string>();
  let totalBytes = 0;
  const objectInventory = source.objects.map((value, itemIndex) => {
    const item = record(value, `validation source object ${itemIndex}`);
    exact(item, ["bytes", "sha256"], `validation source object ${itemIndex}`);
    const reference = { sha256: digest(item.sha256, "object.sha256"), bytes: bytes(item.bytes, "object.bytes") };
    if (objectDigests.has(reference.sha256)) throw new TypeError("Validation source repeats an object digest.");
    objectDigests.add(reference.sha256);
    totalBytes += reference.bytes;
    return reference;
  });
  if (totalBytes > MAX_CANONICAL_BYTES) throw new TypeError("Canonical source exceeds 256 MiB.");
  if (objectInventory.some((value, indexValue) => indexValue > 0 && objectInventory[indexValue - 1]!.sha256 >= value.sha256)) {
    throw new TypeError("Validation source object inventory is not in canonical digest order.");
  }
  if (!Array.isArray(source.problems) || source.problems.length < 1 || source.problems.length > 1_000) throw new TypeError("Validation source problem inventory is invalid.");
  const ids = new Set<string>();
  const declaredObjects = new Set([index.sha256, managed.sha256]);
  const problems = source.problems.map((value, problemIndex) => {
    const problem = record(value, `validation source problem ${problemIndex}`);
    exact(problem, ["bundle", "id", "judge", "references"], `validation source problem ${problemIndex}`);
    if (typeof problem.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(problem.id) || ids.has(problem.id)) throw new TypeError("Validation source problem identity is invalid.");
    ids.add(problem.id);
    const bundle = fileReference(problem.bundle, `validation source problem '${problem.id}' bundle`);
    declaredObjects.add(bundle.sha256);
    if (!Array.isArray(problem.references) || problem.references.length < 1) throw new TypeError(`Validation source problem '${problem.id}' has no references.`);
    const references = problem.references.map((value, referenceIndex) => sourceProgram(value, `validation source reference ${referenceIndex}`, declaredObjects));
    const judge = judgeReference(problem.judge, `validation source problem '${problem.id}' judge`, declaredObjects);
    return { id: problem.id, bundle, references, judge } as ForgeValidationSource["problems"][number];
  });
  if (declaredObjects.size !== objectDigests.size || [...declaredObjects].some((item) => !objectDigests.has(item))) {
    throw new TypeError("Validation source object inventory must contain exactly its declared bytes.");
  }
  return {
    schema: VALIDATION_SOURCE_SCHEMA,
    provenance: { provider: "github", ...parsedProvenance },
    collectionRevision: revision,
    index,
    managed,
    problems,
    objects: objectInventory,
  };
}

export function forgeValidationSourceBytes(value: ForgeValidationSource): Uint8Array {
  return canonicalJsonBytes(parseForgeValidationSource(value));
}

export async function forgeValidationSourceSha256(value: ForgeValidationSource): Promise<string> {
  return sha256Hex(forgeValidationSourceBytes(value));
}

export async function verifyForgeValidationSourceBytes(
  value: Uint8Array,
  expectedSha256?: string,
): Promise<ForgeValidationSource> {
  if (expectedSha256 !== undefined) {
    const expected = digest(expectedSha256, "expected validation source digest");
    if (expected !== await sha256Hex(value)) throw new TypeError("Validation source bytes do not match the expected digest.");
  }
  return parseForgeValidationSource(parseCanonicalJsonBytes(value, "validation source"));
}

/** Verify and reconstruct the only repository view a validation container may consume. */
export async function verifyForgeValidationSourceObjects(
  sourceValue: ForgeValidationSource,
  objects: ReadonlyMap<string, Uint8Array>,
): Promise<VerifiedValidationSource> {
  const source = parseForgeValidationSource(sourceValue);
  if (objects.size !== source.objects.length) throw new TypeError("Canonical object set contains undeclared or missing bytes.");
  for (const reference of source.objects) {
    const value = objects.get(reference.sha256);
    if (!value || value.byteLength !== reference.bytes || await sha256Hex(value) !== reference.sha256) {
      throw new TypeError(`Canonical object '${reference.sha256}' failed integrity verification.`);
    }
  }
  const object = (reference: ValidationSourceObjectReference): Uint8Array => objects.get(reference.sha256)!.slice();
  const canonicalIndex = object(source.index);
  const index = parseProblemCollectionIndex(parseJson(canonicalIndex, source.index.repositoryPath));
  if (canonicalJsonBytes(index).some((byte, indexValue) => byte !== canonicalIndex[indexValue]) || canonicalJsonBytes(index).byteLength !== canonicalIndex.byteLength) {
    throw new TypeError("Canonical index object is not canonical JSON.");
  }
  await verifyProblemCollectionRevision(index);
  if (index.revision !== source.collectionRevision) throw new TypeError("Canonical index revision disagrees with validation source.");
  const canonicalManaged = object(source.managed);
  const managed = parseManagedCollectionContract(parseJson(canonicalManaged, source.managed.repositoryPath));
  if (canonicalJsonBytes(managed).some((byte, indexValue) => byte !== canonicalManaged[indexValue]) || canonicalJsonBytes(managed).byteLength !== canonicalManaged.byteLength) {
    throw new TypeError("Canonical managed contract is not canonical JSON.");
  }
  if (managed.collectionRevision !== index.revision || managed.problems.length !== index.problems.length || source.problems.length !== index.problems.length) {
    throw new TypeError("Canonical collection inventories disagree.");
  }
  const repositoryFiles = new Map<string, Uint8Array>([
    [source.index.repositoryPath, canonicalIndex],
    [source.managed.repositoryPath, canonicalManaged],
  ]);
  const verifyProgram = (
    declared: ValidationSourceProgram,
    contract: ManagedProblemContract["references"][number],
    label: string,
  ): void => {
    if (declared.language !== contract.language || declared.target !== contract.target || declared.optimization !== contract.optimization || declared.entry !== contract.entry || declared.files.length !== contract.files.length) {
      throw new TypeError(`${label} contract disagrees.`);
    }
    for (const [fileIndex, file] of declared.files.entries()) {
      const managedFile = contract.files[fileIndex];
      if (!managedFile || file.path !== managedFile.path || file.repositoryPath !== managedFile.repositoryPath || file.sha256 !== managedFile.sha256 || file.bytes !== managedFile.bytes) {
        throw new TypeError(`${label} file contract disagrees.`);
      }
      repositoryFiles.set(file.repositoryPath, object(file));
    }
  };
  const verifyJudge = (declared: ValidationSourceJudge, contract: ManagedJudgeContract, label: string): void => {
    if (declared.kind !== contract.kind) throw new TypeError(`${label} kind disagrees.`);
    if (declared.kind === "text" || contract.kind === "text") return;
    if (declared.kind !== contract.kind || declared.program.args.length !== contract.program.args.length || declared.program.assets.length !== contract.program.assets.length) {
      throw new TypeError(`${label} contract disagrees.`);
    }
    verifyProgram(declared.program, contract.program, `${label} program`);
    if (declared.program.args.some((argument, index) => argument !== contract.program.args[index])) throw new TypeError(`${label} args disagree.`);
    for (const [assetIndex, asset] of declared.program.assets.entries()) {
      const managedAsset = contract.program.assets[assetIndex];
      if (!managedAsset || asset.path !== managedAsset.path || asset.repositoryPath !== managedAsset.repositoryPath || asset.sha256 !== managedAsset.sha256 || asset.bytes !== managedAsset.bytes) {
        throw new TypeError(`${label} asset contract disagrees.`);
      }
      repositoryFiles.set(asset.repositoryPath, object(asset));
    }
    if (declared.kind === "interactive" && contract.kind === "interactive" && declared.inputPath !== contract.inputPath) {
      throw new TypeError(`${label} inputPath disagrees.`);
    }
  };
  const problems = [];
  for (const [problemIndex, declared] of source.problems.entries()) {
    const indexEntry = index.problems[problemIndex];
    const managedProblem = managed.problems[problemIndex];
    if (!indexEntry || !managedProblem || declared.id !== indexEntry.id || declared.id !== managedProblem.id) throw new TypeError("Canonical problem order or identity disagrees.");
    const problem = await verifyProblemBundleBytes(object(declared.bundle), indexEntry);
    repositoryFiles.set(declared.bundle.repositoryPath, object(declared.bundle));
    if (declared.references.length !== managedProblem.references.length) throw new TypeError("Canonical reference inventory disagrees.");
    for (const [referenceIndex, reference] of declared.references.entries()) {
      const managedReference = managedProblem.references[referenceIndex];
      if (!managedReference) throw new TypeError("Canonical reference contract disagrees.");
      verifyProgram(reference, managedReference, "Canonical reference");
    }
    verifyJudge(declared.judge, managedProblem.judge, "Canonical judge");
    problems.push({ problem, managed: managedProblem });
  }
  return { index, managed, problems, repositoryFiles };
}
