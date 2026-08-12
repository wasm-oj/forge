#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
const encoder = new TextEncoder();

interface CliOptions {
  readonly command: "build" | "validate" | "verify";
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

function resolveInside(root: string, relativeValue: unknown, label: string): string {
  const relative = normalizedRelativePath(relativeValue, label);
  return path.join(root, ...relative.split("/"));
}

function parseOptions(arguments_: readonly string[]): CliOptions {
  const [commandValue, ...rest] = arguments_;
  if (commandValue !== "build" && commandValue !== "validate" && commandValue !== "verify") {
    return fail("Usage: wasm-oj-collection <build|validate|verify> [repository-root] [--index path] [--source path] [--managed path] [--managed-source path]");
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
      if (argument === "--index") indexPath = normalizedRelativePath(value, "index path");
      else if (argument === "--source") sourcePath = normalizedRelativePath(value, "source path");
      else if (argument === "--managed") managedPath = normalizedRelativePath(value, "managed contract path");
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

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalJson(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(canonicalValue(value), null, 2)}\n`);
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
  const indexFile = resolveInside(options.root, options.indexPath, "index path");
  const indexBytes = new Uint8Array(await readFile(indexFile));
  if (indexBytes.byteLength > 512 * 1024) fail("collection index exceeds 512 KiB.");
  const index = parseProblemCollectionIndex(parseJson(indexBytes, options.indexPath));
  await verifyProblemCollectionRevision(index);
  if (strict && !Buffer.from(indexBytes).equals(Buffer.from(canonicalJson(index)))) {
    fail(`${options.indexPath} is not canonical; run wasm-oj-collection build.`);
  }
  const indexDirectory = path.posix.dirname(options.indexPath);
  for (const entry of index.problems) {
    for (const [locale, statementPath] of Object.entries(entry.statementPaths)) {
      const statement = await readFile(resolveInside(options.root, statementPath, `problem '${entry.id}' ${locale} statement`));
      if (statement.byteLength < 1 || statement.byteLength > 2 * 1024 * 1024) {
        fail(`problem '${entry.id}' ${locale} statement must contain between 1 byte and 2 MiB.`);
      }
    }
    const repositoryPath = path.posix.join(indexDirectory, entry.bundle.path);
    const bytes = new Uint8Array(await readFile(resolveInside(options.root, repositoryPath, `problem '${entry.id}' bundle`)));
    const problem = await verifyProblemBundleBytes(bytes, entry);
    if (strict && !Buffer.from(bytes).equals(Buffer.from(canonicalJson({ schema: BROWSER_PROBLEM_SCHEMA, problem })))) {
      fail(`${repositoryPath} is not canonical; run wasm-oj-collection build.`);
    }
  }
  if (strict) await rejectUndeclaredContentAddressedBundles(options, index);
  if (options.managedPath) await validateManagedContract(options, index);
  return index;
}

async function validateManagedContract(options: CliOptions, index: ProblemCollectionIndex): Promise<void> {
  const managedPath = options.managedPath;
  if (!managedPath) fail("managed contract path is required.");
  const contractBytes = new Uint8Array(await readFile(resolveInside(options.root, managedPath, "managed contract path")));
  const contract = parseManagedCollectionV2(contractBytes);
  if (contract.collectionRevision !== index.revision) fail("managed collection revision does not match collection/index.json.");
  if (JSON.stringify(contract.problems.map((problem) => problem.slug)) !== JSON.stringify(index.problems.map((problem) => problem.id))) {
    fail("managed collection problems must exactly match index order.");
  }
  const indexDirectory = path.posix.dirname(options.indexPath);
  for (const [position, publication] of contract.problems.entries()) {
    const entry = index.problems[position]!;
    const practiceRepositoryPath = path.posix.join(indexDirectory, entry.bundle.path);
    const practiceBytes = new Uint8Array(await readFile(resolveInside(options.root, practiceRepositoryPath, `problem '${entry.id}' bundle`)));
    const practice = await verifyProblemBundleBytes(practiceBytes, entry);

    const contestBytes = await readPublishedObject(options, indexDirectory, publication.contestPublic, `contest-public '${publication.slug}'`);
    const expectedContestBytes = contestPublicProjectionBytes(practice, entry.bundle.sha256);
    if (!Buffer.from(contestBytes).equals(Buffer.from(expectedContestBytes))) {
      fail(`contest-public '${publication.slug}' is not the deterministic projection of its practice bundle.`);
    }

    const packageBytes = await readPublishedObject(options, indexDirectory, publication.judgePackage, `judge package '${publication.slug}'`);
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
): Promise<Uint8Array> {
  const repositoryPath = path.posix.join(indexDirectory, object.repositoryPath);
  const bytes = new Uint8Array(await readFile(resolveInside(options.root, repositoryPath, label)));
  if (bytes.byteLength !== object.bytes || await sha256Hex(bytes) !== object.sha256) fail(`${label} failed integrity verification.`);
  return bytes;
}

async function rejectUndeclaredContentAddressedBundles(options: CliOptions, index: ProblemCollectionIndex): Promise<void> {
  const indexDirectory = path.posix.dirname(options.indexPath);
  const relativeDirectory = path.posix.join(indexDirectory, "problems");
  const directory = resolveInside(options.root, relativeDirectory, "bundle directory");
  const declared = new Set(index.problems.map((entry) => path.posix.basename(entry.bundle.path)));
  const entries = await readdir(directory, { withFileTypes: true });
  const digestPattern = /\.[0-9a-f]{64}\.json$/;
  const undeclared = entries
    .filter((entry) => entry.isFile() && digestPattern.test(entry.name) && !declared.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (undeclared.length > 0) fail(`undeclared content-addressed bundles: ${undeclared.join(", ")}.`);
}

interface BuiltCollection {
  readonly index: ProblemCollectionIndex;
  readonly authoredProblems: readonly ReturnType<typeof parseStandaloneProblemBundle>[];
}

async function buildCollection(options: CliOptions): Promise<BuiltCollection> {
  const sourceFile = resolveInside(options.root, options.sourcePath, "source path");
  const source = parseAuthoredCollection(parseJson(new Uint8Array(await readFile(sourceFile)), options.sourcePath));
  const indexDirectory = path.posix.dirname(options.indexPath);
  const outputDirectory = resolveInside(options.root, path.posix.join(indexDirectory, "problems"), "bundle output directory");
  await mkdir(outputDirectory, { recursive: true });
  const entries: ProblemCollectionEntry[] = [];
  const authoredProblems: ReturnType<typeof parseStandaloneProblemBundle>[] = [];
  for (const [position, authored] of source.problems.entries()) {
    const sourceBytes = new Uint8Array(await readFile(resolveInside(options.root, authored.bundlePath, `problem ${position + 1} source bundle`)));
    const problem = parseStandaloneProblemBundle(parseJson(sourceBytes, authored.bundlePath));
    if (problem.number !== position + 1) fail(`problem '${problem.id}' must have number ${position + 1}.`);
    for (const [locale, statementPath] of Object.entries(authored.statementPaths)) {
      const statement = await readFile(resolveInside(options.root, statementPath, `problem '${problem.id}' ${locale} statement`));
      if (statement.byteLength < 1 || statement.byteLength > 2 * 1024 * 1024) {
        fail(`problem '${problem.id}' ${locale} statement must contain between 1 byte and 2 MiB.`);
      }
    }
    authoredProblems.push(problem);
    const practice = derivePracticePublic(problem);
    const bundleBytes = canonicalJson({ schema: BROWSER_PROBLEM_SCHEMA, problem: practice });
    const digest = await sha256Hex(bundleBytes);
    const bundleName = `${String(problem.number).padStart(3, "0")}-${problem.id}.${digest}.json`;
    await writeFile(path.join(outputDirectory, bundleName), bundleBytes);
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
  const indexFile = resolveInside(options.root, options.indexPath, "index path");
  await mkdir(path.dirname(indexFile), { recursive: true });
  await writeFile(indexFile, canonicalJson(index));
  return { index, authoredProblems };
}

async function readDeclaredManagedSourceObject(
  options: CliOptions,
  object: ManagedSourceObject,
  label: string,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(await readFile(resolveInside(options.root, object.path, label)));
  if (bytes.byteLength !== object.bytes || await sha256Hex(bytes) !== object.sha256) {
    fail(`${label} failed declared size or digest verification.`);
  }
  return bytes;
}

async function managedJudgeInput(
  options: CliOptions,
  problem: ManagedCollectionSource["problems"][number],
): Promise<JudgePackageInput["judge"]> {
  if (problem.judge.kind === "text") return { kind: "text" };
  const artifact = await readDeclaredManagedSourceObject(options, problem.judge.artifact, `${problem.judge.kind} artifact '${problem.slug}'`);
  const assets: JudgePackageAssetInput[] = [];
  for (const asset of problem.judge.assets) {
    assets.push({
      guestPath: asset.guestPath,
      contents: await readDeclaredManagedSourceObject(options, asset, `${problem.judge.kind} asset '${problem.slug}/${asset.path}'`),
    });
  }
  return problem.judge.kind === "checker"
    ? { kind: "checker", runtimeProfile: problem.judge.artifact.runtimeProfile, artifact, assets, args: problem.judge.args }
    : { kind: "interactive", runtimeProfile: problem.judge.artifact.runtimeProfile, artifact, assets, args: problem.judge.args, inputPath: problem.judge.inputPath };
}

async function buildManagedCollection(
  options: CliOptions,
  index: ProblemCollectionIndex,
  authoredProblems: readonly ReturnType<typeof parseStandaloneProblemBundle>[],
): Promise<{ readonly path: string; readonly contract: ManagedCollectionV2 }> {
  const managedSourcePath = options.managedSourcePath;
  if (!managedSourcePath) fail("managed source path is required.");
  const sourceBytes = new Uint8Array(await readFile(resolveInside(options.root, managedSourcePath, "managed source path")));
  const source = parseManagedCollectionSource(parseJson(sourceBytes, managedSourcePath));
  if (JSON.stringify(source.problems.map((problem) => problem.slug)) !== JSON.stringify(index.problems.map((problem) => problem.id))) {
    fail("managed source problems must exactly match collection/index.json order.");
  }

  const indexDirectory = path.posix.dirname(options.indexPath);
  const publicationDirectory = path.posix.join(indexDirectory, "managed");
  await mkdir(resolveInside(options.root, publicationDirectory, "managed publication directory"), { recursive: true });
  const publications: ManagedCollectionV2["problems"][number][] = [];
  for (const [position, sourceProblem] of source.problems.entries()) {
    const entry = index.problems[position]!;
    const practiceRepositoryPath = path.posix.join(indexDirectory, entry.bundle.path);
    const practiceBytes = new Uint8Array(await readFile(resolveInside(options.root, practiceRepositoryPath, `problem '${entry.id}' bundle`)));
    const practice = await verifyProblemBundleBytes(practiceBytes, entry);
    const authored = authoredProblems[position];
    if (!authored || authored.id !== entry.id) fail(`authoring source for '${entry.id}' is unavailable.`);

    const contestBytes = contestPublicProjectionBytes(practice, entry.bundle.sha256);
    const contestSha256 = await sha256Hex(contestBytes);
    const contestName = `${String(entry.number).padStart(3, "0")}-${entry.id}.${contestSha256}.contest.json`;
    await writeFile(resolveInside(options.root, path.posix.join(publicationDirectory, contestName), `contest-public '${entry.id}' output`), contestBytes);

    const encoded = await encodeJudgePackage({
      judgeData: deriveJudgeData(authored, Object.keys(sourceProblem.allowedProfiles) as BuiltinLanguage[]),
      allowedProfiles: sourceProblem.allowedProfiles,
      judge: await managedJudgeInput(options, sourceProblem),
    });
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
    await writeFile(resolveInside(options.root, path.posix.join(publicationDirectory, packageName), `judge package '${entry.id}' output`), encoded.bytes);

    publications.push({
      slug: entry.id,
      allowedProfiles: sourceProblem.allowedProfiles,
      contestPublic: { repositoryPath: `managed/${contestName}`, bytes: contestBytes.byteLength, sha256: contestSha256 },
      judgePackage: { repositoryPath: `managed/${packageName}`, bytes: encoded.bytes.byteLength, sha256: encoded.executionSemanticSha256 },
    });
  }
  const contract = parseManagedCollectionV2(canonicalJsonBytes({
    schema: MANAGED_COLLECTION_SCHEMA,
    collectionRevision: index.revision,
    problems: publications,
  }));
  const managedPath = options.managedPath ?? path.posix.join(indexDirectory, "managed.json");
  const outputFile = resolveInside(options.root, managedPath, "managed contract output");
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, canonicalJsonBytes(contract));
  return { path: managedPath, contract };
}

export async function runCollectionCli(arguments_: readonly string[]): Promise<void> {
  const options = parseOptions(arguments_);
  let index: ProblemCollectionIndex;
  if (options.command === "build") {
    const built = await buildCollection(options);
    index = built.index;
    if (options.managedSourcePath) await buildManagedCollection(options, index, built.authoredProblems);
  } else {
    index = await validatePublishedCollection(options, options.command === "verify");
  }
  process.stdout.write(`${options.command} ok: ${index.problems.length} problems, revision ${index.revision}\n`);
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invokedDirectly) {
  runCollectionCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`wasm-oj-collection: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
