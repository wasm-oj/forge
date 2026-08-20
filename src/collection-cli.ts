#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { anchoredPathHasNoSymlink, canonicalizeSystemTemporaryPrefix } from "./path-safety";
import {
  BROWSER_COLLECTION_SCHEMA,
  BROWSER_PROBLEM_SCHEMA,
  canonicalJsonBytes,
  contestPublicProjectionBytes,
  deriveJudgeData,
  derivePracticePublic,
  encodeJudgePackage,
  assertJudgeDataMatchesPracticePublic,
  MANAGED_COLLECTION_SCHEMA,
  parseManagedCollectionSource,
  parseManagedCollectionV2,
  parseProblemCollectionIndex,
  parseStandaloneProblemBundle,
  problemCollectionRevision,
  validateJudgePackage,
  verifyProblemBundleBytes,
  verifyProblemCollectionRevision,
  type BuiltinLanguage,
  type JudgePackageAssetInput,
  type JudgePackageInput,
  type ManagedCollectionSource,
  type ManagedCollectionV2,
  type ManagedRepositoryObject,
  type ManagedSourceObject,
  type ProblemCollectionEntry,
  type ProblemCollectionIndex,
} from "@wasm-oj/core";

const SOURCE_SCHEMA = "wasm-oj-browser-collection-source-v1";
const DEFAULT_INDEX_PATH = "collection/index.json";
const DEFAULT_SOURCE_PATH = "collection/source.json";
const INDEX_MAX_BYTES = 512 * 1024;
const COLLECTION_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const STATEMENT_MAX_BYTES = 2 * 1024 * 1024;
const PUBLIC_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;
const AUTHORING_BUNDLE_MAX_BYTES = 32 * 1024 * 1024;
const MANAGED_MAX_BYTES = 2 * 1024 * 1024;
const JUDGE_PACKAGE_MAX_BYTES = 32 * 1024 * 1024;

interface CliOptions {
  readonly command: "build" | "verify";
  readonly root: string;
  readonly indexPath: string;
  readonly sourcePath: string;
  readonly managedPath?: string;
  readonly managedSourcePath?: string;
}

interface AuthoredCollectionProblem {
  readonly statementPaths: { readonly "zh-TW": string; readonly en: string };
  readonly bundlePath: string;
}

interface AuthoredCollection {
  readonly schema: typeof SOURCE_SCHEMA;
  readonly localization: {
    readonly defaultLocale: "zh-TW";
    readonly supportedLocales: readonly ["zh-TW", "en"];
  };
  readonly problems: readonly AuthoredCollectionProblem[];
}

function fail(message: string): never {
  throw new Error(message);
}

function normalizedRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.endsWith("/")) {
    return fail(`${label} must be a normalized relative POSIX path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return fail(`${label} must be a normalized relative POSIX path.`);
  }
  return value;
}

function portableOutputPath(value: unknown, label: string): string {
  const relative = normalizedRelativePath(value, label);
  if (relative.split("/").some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    return fail(`${label} must use only portable ASCII path segments.`);
  }
  return relative;
}

function resolveInside(root: string, relativeValue: unknown, label: string): string {
  const relative = normalizedRelativePath(relativeValue, label);
  return path.join(root, ...relative.split("/"));
}

function collisionKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

async function assertRepositoryRoot(root: string): Promise<void> {
  const anchoredRoot = await canonicalizeSystemTemporaryPrefix(path.resolve(root));
  if (!await anchoredPathHasNoSymlink(anchoredRoot)) fail("repository root must not traverse a symbolic link.");
  const metadata = await lstat(anchoredRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("repository root must be a real directory.");
}

async function readBoundedRepositoryFile(
  options: CliOptions,
  relativeValue: unknown,
  label: string,
  maximumBytes: number,
  expectedBytes?: number,
): Promise<Uint8Array> {
  const file = resolveInside(options.root, relativeValue, label);
  if (!await anchoredPathHasNoSymlink(file)) fail(`${label} must not traverse a symbolic link.`);
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new Error(`${label} must be a readable regular file.`, { cause: error }); }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes || (expectedBytes !== undefined && metadata.size !== expectedBytes)) {
      fail(`${label} is outside its allowed byte limit.`);
    }
    return new Uint8Array(await handle.readFile());
  } finally { await handle.close(); }
}

async function assertOutputPathSafe(options: CliOptions, relativeValue: string, label: string): Promise<void> {
  const output = resolveInside(options.root, relativeValue, label);
  if (!await anchoredPathHasNoSymlink(output)) fail(`${label} must not traverse a symbolic link.`);
  let metadata;
  try { metadata = await lstat(output); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must replace only a regular file.`);
}

async function existingPathIdentity(options: CliOptions, relativeValue: string, label: string): Promise<string | undefined> {
  const file = resolveInside(options.root, relativeValue, label);
  if (!await anchoredPathHasNoSymlink(file)) fail(`${label} must not traverse a symbolic link.`);
  try {
    const metadata = await lstat(file, { bigint: true });
    if (metadata.isSymbolicLink()) fail(`${label} must not be a symbolic link.`);
    return `${metadata.dev}:${metadata.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertNoFilesystemAliases(
  options: CliOptions,
  inputs: ReadonlySet<string>,
  outputs: readonly string[],
): Promise<void> {
  const inputIdentities = new Map<string, string>();
  for (const input of inputs) {
    const identity = await existingPathIdentity(options, input, `declared input '${input}'`);
    if (identity !== undefined && !inputIdentities.has(identity)) inputIdentities.set(identity, input);
  }
  const outputIdentities = new Map<string, string>();
  for (const output of outputs) {
    const identity = await existingPathIdentity(options, output, `generated output '${output}'`);
    if (identity === undefined) continue;
    const input = inputIdentities.get(identity);
    if (input !== undefined) fail(`generated output '${output}' aliases declared input '${input}' on this filesystem.`);
    const priorOutput = outputIdentities.get(identity);
    if (priorOutput !== undefined) fail(`generated outputs '${priorOutput}' and '${output}' alias on this filesystem.`);
    outputIdentities.set(identity, output);
  }
}

async function ensureOutputParent(options: CliOptions, relativeValue: string): Promise<void> {
  const relativeParent = path.posix.dirname(normalizedRelativePath(relativeValue, "output path"));
  if (relativeParent === ".") return;
  let current = options.root;
  for (const segment of relativeParent.split("/")) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(`output directory '${relativeParent}' must contain only real directories.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { await mkdir(current); }
      catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(`output directory '${relativeParent}' must contain only real directories.`);
      }
    }
  }
}

async function atomicRepositoryWrite(options: CliOptions, relativeValue: string, bytes: Uint8Array): Promise<void> {
  const output = resolveInside(options.root, relativeValue, "output path");
  await ensureOutputParent(options, relativeValue);
  const temporary = `${output}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
}

function parseOptions(arguments_: readonly string[]): CliOptions {
  const [commandValue, ...rest] = arguments_;
  if (commandValue !== "build" && commandValue !== "verify") {
    return fail("Usage: woj organizer collection <build|verify> [repository-root] [--index path] [--source path] [--managed path] [--managed-source path]");
  }
  let root = ".";
  let indexPath = DEFAULT_INDEX_PATH;
  let sourcePath = DEFAULT_SOURCE_PATH;
  let managedPath: string | undefined;
  let managedSourcePath: string | undefined;
  let sawRoot = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--index" || argument === "--source" || argument === "--managed" || argument === "--managed-source") {
      const value = rest[index + 1];
      if (!value) return fail(`${argument} requires a path.`);
      if (argument === "--index") indexPath = portableOutputPath(value, "index path");
      else if (argument === "--source") sourcePath = normalizedRelativePath(value, "source path");
      else if (argument === "--managed") managedPath = portableOutputPath(value, "managed contract path");
      else managedSourcePath = normalizedRelativePath(value, "managed source path");
      index += 1;
      continue;
    }
    if (argument?.startsWith("-")) return fail(`Unknown option '${argument}'.`);
    if (sawRoot || !argument) return fail("Only one repository root may be provided.");
    root = argument;
    sawRoot = true;
  }
  if (commandValue !== "build" && managedSourcePath) return fail("--managed-source is only valid for build.");
  if (commandValue === "build" && managedPath && !managedSourcePath) return fail("--managed requires --managed-source when building.");
  if (commandValue === "build" && collisionKey(indexPath) === collisionKey(sourcePath)) return fail("--index and --source must not be the same input and output path.");
  if (commandValue === "build" && managedPath !== undefined && managedSourcePath !== undefined && collisionKey(managedPath) === collisionKey(managedSourcePath)) {
    return fail("--managed and --managed-source must not be the same input and output path.");
  }
  return {
    command: commandValue,
    root: path.resolve(root),
    indexPath,
    sourcePath,
    ...(managedPath ? { managedPath } : {}),
    ...(managedSourcePath ? { managedSourcePath } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    fail(`${label} must contain exactly: ${sortedExpected.join(", ")}.`);
  }
}

function parseAuthoredCollection(value: unknown): AuthoredCollection {
  if (!isRecord(value)) return fail("collection/source.json must be an object.");
  exactKeys(value, ["schema", "localization", "problems"], "collection source");
  if (value.schema !== SOURCE_SCHEMA) return fail(`collection source schema must be '${SOURCE_SCHEMA}'.`);
  if (!isRecord(value.localization)) return fail("collection localization must be an object.");
  exactKeys(value.localization, ["defaultLocale", "supportedLocales"], "collection localization");
  if (
    value.localization.defaultLocale !== "zh-TW"
    || JSON.stringify(value.localization.supportedLocales) !== JSON.stringify(["zh-TW", "en"])
  ) return fail("collection localization must declare zh-TW followed by en.");
  if (!Array.isArray(value.problems) || value.problems.length < 1 || value.problems.length > 1_000) {
    return fail("collection source must contain between 1 and 1000 problems.");
  }
  const problems = value.problems.map((problemValue, index) => {
    if (!isRecord(problemValue)) return fail(`collection source problem ${index + 1} must be an object.`);
    exactKeys(problemValue, ["statementPaths", "bundlePath"], `collection source problem ${index + 1}`);
    if (!isRecord(problemValue.statementPaths)) return fail(`problem ${index + 1} statementPaths must be an object.`);
    exactKeys(problemValue.statementPaths, ["zh-TW", "en"], `problem ${index + 1} statementPaths`);
    const statementPaths = {
      "zh-TW": normalizedRelativePath(problemValue.statementPaths["zh-TW"], `problem ${index + 1} zh-TW statement`),
      en: normalizedRelativePath(problemValue.statementPaths.en, `problem ${index + 1} English statement`),
    };
    if (!statementPaths["zh-TW"].endsWith(".md") || !statementPaths.en.endsWith(".md")) {
      return fail(`problem ${index + 1} statements must be Markdown files.`);
    }
    return {
      statementPaths,
      bundlePath: normalizedRelativePath(problemValue.bundlePath, `problem ${index + 1} bundle`),
    };
  });
  return {
    schema: SOURCE_SCHEMA,
    localization: { defaultLocale: "zh-TW", supportedLocales: ["zh-TW", "en"] },
    problems,
  };
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8.`, { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validatePublishedCollection(options: CliOptions, strict: boolean): Promise<ProblemCollectionIndex> {
  const indexBytes = await readBoundedRepositoryFile(options, options.indexPath, "index path", INDEX_MAX_BYTES);
  const index = parseProblemCollectionIndex(parseJson(indexBytes, options.indexPath));
  await verifyProblemCollectionRevision(index);
  if (strict && !Buffer.from(indexBytes).equals(Buffer.from(canonicalJsonBytes(index)))) {
    fail(`${options.indexPath} is not canonical; run woj organizer collection build.`);
  }
  const indexDirectory = path.posix.dirname(options.indexPath);
  for (const entry of index.problems) {
    for (const [locale, statementPath] of Object.entries(entry.statementPaths)) {
      const statement = await readBoundedRepositoryFile(options, statementPath, `problem '${entry.id}' ${locale} statement`, STATEMENT_MAX_BYTES);
      if (statement.byteLength < 1) {
        fail(`problem '${entry.id}' ${locale} statement must contain between 1 byte and 2 MiB.`);
      }
    }
    const repositoryPath = path.posix.join(indexDirectory, entry.bundle.path);
    const bytes = await readBoundedRepositoryFile(options, repositoryPath, `problem '${entry.id}' bundle`, PUBLIC_BUNDLE_MAX_BYTES, entry.bundle.bytes);
    const problem = await verifyProblemBundleBytes(bytes, entry);
    if (strict && !Buffer.from(bytes).equals(Buffer.from(canonicalJsonBytes({ schema: BROWSER_PROBLEM_SCHEMA, problem })))) {
      fail(`${repositoryPath} is not canonical; run woj organizer collection build.`);
    }
  }
  if (strict) await rejectUndeclaredContentAddressedBundles(options, index);
  if (options.managedPath) await validateManagedContract(options, index);
  return index;
}

async function validateManagedContract(options: CliOptions, index: ProblemCollectionIndex): Promise<void> {
  const managedPath = options.managedPath;
  if (!managedPath) fail("managed contract path is required.");
  const contractBytes = await readBoundedRepositoryFile(options, managedPath, "managed contract path", MANAGED_MAX_BYTES);
  const contract = parseManagedCollectionV2(contractBytes);
  if (contract.collectionRevision !== index.revision) fail("managed collection revision does not match collection/index.json.");
  if (JSON.stringify(contract.problems.map((problem) => problem.slug)) !== JSON.stringify(index.problems.map((problem) => problem.id))) {
    fail("managed collection problems must exactly match index order.");
  }
  const indexDirectory = path.posix.dirname(options.indexPath);
  for (const [position, publication] of contract.problems.entries()) {
    const entry = index.problems[position]!;
    const practiceRepositoryPath = path.posix.join(indexDirectory, entry.bundle.path);
    const practiceBytes = await readBoundedRepositoryFile(options, practiceRepositoryPath, `problem '${entry.id}' bundle`, PUBLIC_BUNDLE_MAX_BYTES, entry.bundle.bytes);
    const practice = await verifyProblemBundleBytes(practiceBytes, entry);

    const contestBytes = await readPublishedObject(options, indexDirectory, publication.contestPublic, `contest-public '${publication.slug}'`, PUBLIC_BUNDLE_MAX_BYTES);
    const expectedContestBytes = contestPublicProjectionBytes(practice, entry.bundle.sha256);
    if (!Buffer.from(contestBytes).equals(Buffer.from(expectedContestBytes))) {
      fail(`contest-public '${publication.slug}' is not the deterministic projection of its practice bundle.`);
    }

    const packageBytes = await readPublishedObject(options, indexDirectory, publication.judgePackage, `judge package '${publication.slug}'`, JUDGE_PACKAGE_MAX_BYTES);
    const validatedPackage = await validateJudgePackage(packageBytes, {
      expectedBytes: publication.judgePackage.bytes,
      expectedSha256: publication.judgePackage.sha256,
      memoryLimitBytes: Math.max(...practice.scoring.policies.map((policy) => policy.limits.memoryLimitBytes)),
    });
    if (JSON.stringify(validatedPackage.manifest.allowedProfiles) !== JSON.stringify(publication.allowedProfiles)) {
      fail(`judge package '${publication.slug}' allowedProfiles disagree with collection/managed.json.`);
    }
    assertJudgeDataMatchesPracticePublic(
      validatedPackage.judgeData,
      practice,
      Object.keys(publication.allowedProfiles) as BuiltinLanguage[],
    );
  }
}

async function readPublishedObject(
  options: CliOptions,
  indexDirectory: string,
  object: ManagedRepositoryObject,
  label: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const repositoryPath = path.posix.join(indexDirectory, object.repositoryPath);
  const bytes = await readBoundedRepositoryFile(options, repositoryPath, label, maximumBytes, object.bytes);
  if (await sha256Hex(bytes) !== object.sha256) fail(`${label} failed integrity verification.`);
  return bytes;
}

async function rejectUndeclaredContentAddressedBundles(options: CliOptions, index: ProblemCollectionIndex): Promise<void> {
  const indexDirectory = path.posix.dirname(options.indexPath);
  const relativeDirectory = path.posix.join(indexDirectory, "problems");
  const directory = resolveInside(options.root, relativeDirectory, "bundle directory");
  if (!await anchoredPathHasNoSymlink(directory)) fail("bundle directory must not traverse a symbolic link.");
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("bundle directory must be a real directory.");
  const declared = new Set(index.problems.map((entry) => path.posix.basename(entry.bundle.path)));
  const entries = await readdir(directory, { withFileTypes: true });
  const digestPattern = /\.[0-9a-f]{64}\.json$/;
  const undeclared = entries
    .filter((entry) => entry.isFile() && digestPattern.test(entry.name) && !declared.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  const unsafe = entries.filter((entry) => entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())).map((entry) => entry.name).sort();
  if (unsafe.length > 0) fail(`bundle directory contains unsafe entries: ${unsafe.join(", ")}.`);
  if (undeclared.length > 0) fail(`undeclared content-addressed bundles: ${undeclared.join(", ")}.`);
}

interface BuiltCollection {
  readonly index: ProblemCollectionIndex;
  readonly authoredProblems: readonly ReturnType<typeof parseStandaloneProblemBundle>[];
  readonly practiceProblems: readonly ReturnType<typeof derivePracticePublic>[];
  readonly inputs: ReadonlySet<string>;
  readonly outputs: readonly PreparedOutput[];
}

interface PreparedOutput {
  readonly path: string;
  readonly label: string;
  readonly bytes: Uint8Array;
}

function assertGeneratedSize(bytes: Uint8Array, maximumBytes: number, label: string): void {
  if (bytes.byteLength > maximumBytes) fail(`${label} exceeds its allowed byte limit.`);
}

async function prepareCollection(options: CliOptions): Promise<BuiltCollection> {
  const sourceBytes = await readBoundedRepositoryFile(options, options.sourcePath, "source path", COLLECTION_SOURCE_MAX_BYTES);
  const source = parseAuthoredCollection(parseJson(sourceBytes, options.sourcePath));
  const indexDirectory = path.posix.dirname(options.indexPath);
  const entries: ProblemCollectionEntry[] = [];
  const authoredProblems: ReturnType<typeof parseStandaloneProblemBundle>[] = [];
  const practiceProblems: ReturnType<typeof derivePracticePublic>[] = [];
  const inputs = new Set<string>([options.sourcePath]);
  const outputs: PreparedOutput[] = [];
  for (const [position, authored] of source.problems.entries()) {
    inputs.add(authored.bundlePath);
    const authoredBytes = await readBoundedRepositoryFile(options, authored.bundlePath, `problem ${position + 1} source bundle`, AUTHORING_BUNDLE_MAX_BYTES);
    const problem = parseStandaloneProblemBundle(parseJson(authoredBytes, authored.bundlePath));
    if (problem.number !== position + 1) fail(`problem '${problem.id}' must have number ${position + 1}.`);
    for (const [locale, statementPath] of Object.entries(authored.statementPaths)) {
      inputs.add(statementPath);
      const statement = await readBoundedRepositoryFile(options, statementPath, `problem '${problem.id}' ${locale} statement`, STATEMENT_MAX_BYTES);
      if (statement.byteLength < 1) {
        fail(`problem '${problem.id}' ${locale} statement must contain between 1 byte and 2 MiB.`);
      }
    }
    authoredProblems.push(problem);
    const practice = derivePracticePublic(problem);
    practiceProblems.push(practice);
    const bundleBytes = canonicalJsonBytes({ schema: BROWSER_PROBLEM_SCHEMA, problem: practice });
    assertGeneratedSize(bundleBytes, PUBLIC_BUNDLE_MAX_BYTES, `problem '${problem.id}' public bundle`);
    const digest = await sha256Hex(bundleBytes);
    const bundleName = `${String(problem.number).padStart(3, "0")}-${problem.id}.${digest}.json`;
    outputs.push({
      path: path.posix.join(indexDirectory, "problems", bundleName),
      label: `problem '${problem.id}' public bundle output`,
      bytes: bundleBytes,
    });
    entries.push({
      id: problem.id,
      number: problem.number,
      title: problem.title,
      trackId: problem.trackId,
      track: problem.track,
      statementPaths: authored.statementPaths,
      difficulty: problem.difficulty,
      tags: problem.tags,
      caseCount: practice.judgeCases.length,
      bundle: { path: `problems/${bundleName}`, sha256: digest, bytes: bundleBytes.byteLength },
    });
  }
  const withoutRevision = {
    schema: BROWSER_COLLECTION_SCHEMA,
    problemSchema: BROWSER_PROBLEM_SCHEMA,
    localization: source.localization,
    problems: entries,
  };
  const index = parseProblemCollectionIndex({
    ...withoutRevision,
    revision: await problemCollectionRevision(withoutRevision),
  });
  const indexBytes = canonicalJsonBytes(index);
  assertGeneratedSize(indexBytes, INDEX_MAX_BYTES, "collection index output");
  outputs.push({ path: options.indexPath, label: "collection index output", bytes: indexBytes });
  return { index, authoredProblems, practiceProblems, inputs, outputs };
}

async function readDeclaredManagedSourceObject(
  options: CliOptions,
  object: ManagedSourceObject,
  label: string,
  inputs: Set<string>,
): Promise<Uint8Array> {
  inputs.add(object.path);
  const bytes = await readBoundedRepositoryFile(options, object.path, label, JUDGE_PACKAGE_MAX_BYTES, object.bytes);
  if (await sha256Hex(bytes) !== object.sha256) {
    fail(`${label} failed declared size or digest verification.`);
  }
  return bytes;
}

async function managedJudgeInput(
  options: CliOptions,
  problem: ManagedCollectionSource["problems"][number],
  inputs: Set<string>,
): Promise<JudgePackageInput["judge"]> {
  if (problem.judge.kind === "text") return { kind: "text" };
  const artifact = await readDeclaredManagedSourceObject(options, problem.judge.artifact, `${problem.judge.kind} artifact '${problem.slug}'`, inputs);
  const assets: JudgePackageAssetInput[] = [];
  for (const asset of problem.judge.assets) {
    assets.push({
      guestPath: asset.guestPath,
      contents: await readDeclaredManagedSourceObject(options, asset, `${problem.judge.kind} asset '${problem.slug}/${asset.path}'`, inputs),
    });
  }
  return problem.judge.kind === "checker"
    ? { kind: "checker", runtimeProfile: problem.judge.artifact.runtimeProfile, artifact, assets, args: problem.judge.args }
    : { kind: "interactive", runtimeProfile: problem.judge.artifact.runtimeProfile, artifact, assets, args: problem.judge.args, inputPath: problem.judge.inputPath };
}

async function prepareManagedCollection(
  options: CliOptions,
  built: BuiltCollection,
): Promise<{ readonly inputs: ReadonlySet<string>; readonly outputs: readonly PreparedOutput[] }> {
  const managedSourcePath = options.managedSourcePath;
  if (!managedSourcePath) fail("managed source path is required.");
  const inputs = new Set<string>([managedSourcePath]);
  const outputs: PreparedOutput[] = [];
  const sourceBytes = await readBoundedRepositoryFile(options, managedSourcePath, "managed source path", MANAGED_MAX_BYTES);
  const source = parseManagedCollectionSource(parseJson(sourceBytes, managedSourcePath));
  if (JSON.stringify(source.problems.map((problem) => problem.slug)) !== JSON.stringify(built.index.problems.map((problem) => problem.id))) {
    fail("managed source problems must exactly match collection/index.json order.");
  }

  const indexDirectory = path.posix.dirname(options.indexPath);
  const publicationDirectory = path.posix.join(indexDirectory, "managed");
  const publications: ManagedCollectionV2["problems"][number][] = [];
  for (const [position, sourceProblem] of source.problems.entries()) {
    const entry = built.index.problems[position]!;
    const practice = built.practiceProblems[position]!;
    const authored = built.authoredProblems[position];
    if (!authored || authored.id !== entry.id) fail(`authoring source for '${entry.id}' is unavailable.`);

    const contestBytes = contestPublicProjectionBytes(practice, entry.bundle.sha256);
    assertGeneratedSize(contestBytes, PUBLIC_BUNDLE_MAX_BYTES, `contest-public '${entry.id}' output`);
    const contestSha256 = await sha256Hex(contestBytes);
    const contestName = `${String(entry.number).padStart(3, "0")}-${entry.id}.${contestSha256}.contest.json`;
    outputs.push({ path: path.posix.join(publicationDirectory, contestName), label: `contest-public '${entry.id}' output`, bytes: contestBytes });

    const encoded = await encodeJudgePackage({
      judgeData: deriveJudgeData(authored, Object.keys(sourceProblem.allowedProfiles) as BuiltinLanguage[]),
      allowedProfiles: sourceProblem.allowedProfiles,
      judge: await managedJudgeInput(options, sourceProblem, inputs),
    });
    assertGeneratedSize(encoded.bytes, JUDGE_PACKAGE_MAX_BYTES, `judge package '${entry.id}' output`);
    const validated = await validateJudgePackage(encoded.bytes, {
      expectedBytes: encoded.bytes.byteLength,
      expectedSha256: encoded.executionSemanticSha256,
      memoryLimitBytes: Math.max(...practice.scoring.policies.map((policy) => policy.limits.memoryLimitBytes)),
    });
    assertJudgeDataMatchesPracticePublic(
      validated.judgeData,
      practice,
      Object.keys(sourceProblem.allowedProfiles) as BuiltinLanguage[],
    );
    const packageName = `${String(entry.number).padStart(3, "0")}-${entry.id}.${encoded.executionSemanticSha256}.wasmojjudge`;
    outputs.push({ path: path.posix.join(publicationDirectory, packageName), label: `judge package '${entry.id}' output`, bytes: encoded.bytes });

    publications.push({
      slug: entry.id,
      allowedProfiles: sourceProblem.allowedProfiles,
      contestPublic: { repositoryPath: `managed/${contestName}`, bytes: contestBytes.byteLength, sha256: contestSha256 },
      judgePackage: { repositoryPath: `managed/${packageName}`, bytes: encoded.bytes.byteLength, sha256: encoded.executionSemanticSha256 },
    });
  }
  const contract = parseManagedCollectionV2(canonicalJsonBytes({
    schema: MANAGED_COLLECTION_SCHEMA,
    collectionRevision: built.index.revision,
    problems: publications,
  }));
  const managedPath = options.managedPath ?? path.posix.join(indexDirectory, "managed.json");
  const contractBytes = canonicalJsonBytes(contract);
  assertGeneratedSize(contractBytes, MANAGED_MAX_BYTES, "managed contract output");
  outputs.push({ path: managedPath, label: "managed contract output", bytes: contractBytes });
  return { inputs, outputs };
}

function pathsOverlap(left: string, right: string): boolean {
  const leftKey = collisionKey(left);
  const rightKey = collisionKey(right);
  return leftKey === rightKey || leftKey.startsWith(`${rightKey}/`) || rightKey.startsWith(`${leftKey}/`);
}

async function writePreparedCollection(
  options: CliOptions,
  inputs: ReadonlySet<string>,
  outputs: readonly PreparedOutput[],
): Promise<void> {
  const outputPaths = new Set<string>();
  for (const output of outputs) {
    portableOutputPath(output.path, output.label);
    const key = collisionKey(output.path);
    if (outputPaths.has(key)) fail(`generated output '${output.path}' has a case-folded or normalized collision.`);
    outputPaths.add(key);
    for (const input of inputs) {
      if (pathsOverlap(input, output.path)) fail(`generated output '${output.path}' overlaps declared input '${input}'.`);
    }
  }
  await assertNoFilesystemAliases(options, inputs, outputs.map((output) => output.path));
  await Promise.all(outputs.map((output) => assertOutputPathSafe(options, output.path, output.label)));
  for (const output of outputs) await atomicRepositoryWrite(options, output.path, output.bytes);
}

export async function runCollectionCli(arguments_: readonly string[]): Promise<void> {
  const options = parseOptions(arguments_);
  await assertRepositoryRoot(options.root);
  let index: ProblemCollectionIndex;
  if (options.command === "build") {
    const initialManagedOutput = options.managedSourcePath
      ? options.managedPath ?? path.posix.join(path.posix.dirname(options.indexPath), "managed.json")
      : undefined;
    await assertNoFilesystemAliases(
      options,
      new Set([options.sourcePath, ...(options.managedSourcePath ? [options.managedSourcePath] : [])]),
      [options.indexPath, ...(initialManagedOutput ? [initialManagedOutput] : [])],
    );
    const built = await prepareCollection(options);
    index = built.index;
    const managed = options.managedSourcePath ? await prepareManagedCollection(options, built) : undefined;
    await writePreparedCollection(
      options,
      new Set([...(built.inputs), ...(managed?.inputs ?? [])]),
      [...built.outputs, ...(managed?.outputs ?? [])],
    );
  } else {
    index = await validatePublishedCollection(options, true);
  }
  process.stdout.write(`${options.command} ok: ${index.problems.length} problems, revision ${index.revision}\n`);
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invokedDirectly) {
  runCollectionCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`woj organizer collection: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
