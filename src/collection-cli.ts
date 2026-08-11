#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BROWSER_COLLECTION_SCHEMA,
  BROWSER_PROBLEM_SCHEMA,
  parseProblemCollectionIndex,
  parseStandaloneProblemBundle,
  problemCollectionRevision,
  verifyProblemBundleBytes,
  verifyProblemCollectionRevision,
  type ProblemCollectionEntry,
  type ProblemCollectionIndex,
} from "./judge/problem-catalog-loader";
import { parseManagedCollectionContract } from "./online-judge/managed-collection";

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
    return fail("Usage: forge-collection <build|validate|verify> [repository-root] [--index path] [--source path] [--managed path]");
  }
  let root = ".";
  let indexPath = DEFAULT_INDEX_PATH;
  let sourcePath = DEFAULT_SOURCE_PATH;
  let managedPath: string | undefined;
  let sawRoot = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--index" || argument === "--source" || argument === "--managed") {
      const value = rest[index + 1];
      if (!value) return fail(`${argument} requires a path.`);
      if (argument === "--index") indexPath = normalizedRelativePath(value, "index path");
      else if (argument === "--source") sourcePath = normalizedRelativePath(value, "source path");
      else managedPath = normalizedRelativePath(value, "managed contract path");
      index += 1;
      continue;
    }
    if (argument?.startsWith("-")) return fail(`Unknown option '${argument}'.`);
    if (sawRoot || !argument) return fail("Only one repository root may be provided.");
    root = argument;
    sawRoot = true;
  }
  return { command: commandValue, root: path.resolve(root), indexPath, sourcePath, ...(managedPath ? { managedPath } : {}) };
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
    fail(`${options.indexPath} is not canonical; run forge-collection build.`);
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
      fail(`${repositoryPath} is not canonical; run forge-collection build.`);
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
  if (contractBytes.byteLength < 1 || contractBytes.byteLength > 2 * 1024 * 1024) fail("managed collection contract must contain between 1 byte and 2 MiB.");
  const contract = parseManagedCollectionContract(parseJson(contractBytes, managedPath));
  if (contract.collectionRevision !== index.revision) fail("managed collection revision does not match collection/index.json.");
  if (JSON.stringify(contract.problems.map((problem) => problem.id)) !== JSON.stringify(index.problems.map((problem) => problem.id))) {
    fail("managed collection problems must exactly match index order.");
  }
  for (const problem of contract.problems) {
    for (const reference of problem.references) {
      for (const file of reference.files) {
        await verifyManagedFile(options, file, `reference '${problem.id}/${reference.language}/${file.path}'`);
      }
    }
    if (problem.judge.kind !== "text") {
      for (const file of problem.judge.program.files) {
        await verifyManagedFile(options, file, `${problem.judge.kind} source '${problem.id}/${file.path}'`);
      }
      for (const asset of problem.judge.program.assets) {
        await verifyManagedFile(options, asset, `${problem.judge.kind} asset '${problem.id}/${asset.path}'`);
      }
    }
  }
}

async function verifyManagedFile(
  options: CliOptions,
  file: { readonly repositoryPath: string; readonly bytes: number; readonly sha256: string },
  label: string,
): Promise<void> {
  const bytes = new Uint8Array(await readFile(resolveInside(options.root, file.repositoryPath, label)));
  if (bytes.byteLength !== file.bytes || await sha256Hex(bytes) !== file.sha256) fail(`${label} failed integrity verification.`);
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

async function buildCollection(options: CliOptions): Promise<ProblemCollectionIndex> {
  const sourceFile = resolveInside(options.root, options.sourcePath, "source path");
  const source = parseAuthoredCollection(parseJson(new Uint8Array(await readFile(sourceFile)), options.sourcePath));
  const indexDirectory = path.posix.dirname(options.indexPath);
  const outputDirectory = resolveInside(options.root, path.posix.join(indexDirectory, "problems"), "bundle output directory");
  await mkdir(outputDirectory, { recursive: true });
  const entries: ProblemCollectionEntry[] = [];
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
    const bundleBytes = canonicalJson({ schema: BROWSER_PROBLEM_SCHEMA, problem });
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
      caseCount: problem.judgeCases.length,
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
  return index;
}

export async function runForgeCollectionCli(arguments_: readonly string[]): Promise<void> {
  const options = parseOptions(arguments_);
  const index = options.command === "build"
    ? await buildCollection(options)
    : await validatePublishedCollection(options, options.command === "verify");
  process.stdout.write(`${options.command} ok: ${index.problems.length} problems, revision ${index.revision}\n`);
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invokedDirectly) {
  runForgeCollectionCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`forge-collection: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
