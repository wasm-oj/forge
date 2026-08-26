#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BROWSER_PROBLEM_SCHEMA,
  assertJudgeDataMatchesPracticePublic,
  canonicalJsonBytes,
  deriveJudgeData,
  deriveContestPublic,
  derivePracticePublic,
  encodeJudgePackage,
  parseStandaloneProblemBundle,
  validateJudgePackage,
  type BuiltinLanguage,
  type JudgePackageAssetInput,
  type JudgePackageInput,
} from "@wasm-oj/core";
import { contestPublicProjectionBytes } from "./online-judge/contest-public";
import { parseContestPublicProblemProjection } from "./online-judge/public-projection";
import { parseRepositoryAuthoringJudges, type RepositorySourceJudge, type RepositorySourceObject } from "./online-judge/repository-authoring";
import {
  parseRepositoryContestsValue,
  parseRepositoryProblemsValue,
  parseRepositoryRootValue,
  type RepositoryContest,
  type LocalizedText,
  type RepositoryProblem,
} from "./online-judge/repository-contract";
import { anchoredPathHasNoSymlink, canonicalizeSystemTemporaryPrefix } from "./path-safety";

const AUTHORING_SCHEMA = "wasm-oj-platform/repository-authoring/v1";
const SOURCE_PATH = "collection/source.json";
const ROOT_PATH = "wasm-oj.json";
const PROBLEMS_PATH = "collection/problems.json";
const CONTESTS_PATH = "collection/contests.json";
const JSON_MAX_BYTES = 2 * 1024 * 1024;
const PUBLIC_MAX_BYTES = 8 * 1024 * 1024;
const PACKAGE_MAX_BYTES = 32 * 1024 * 1024;

interface Options {
  readonly command: "build" | "verify";
  readonly root: string;
  readonly sourcePath: string;
}

interface AuthoredProblem {
  readonly slug: string;
  readonly order: number;
  readonly title: LocalizedText;
  readonly summary: LocalizedText;
  readonly practiceEnabled: boolean;
  readonly authoringBundle: string;
  readonly allowedProfiles: ReturnType<typeof parseRepositoryAuthoringJudges>["problems"][number]["allowedProfiles"];
  readonly judge: RepositorySourceJudge;
}

interface AuthoringSource {
  readonly problems: readonly AuthoredProblem[];
  readonly contests: readonly RepositoryContest[];
}

interface Output {
  readonly path: string;
  readonly bytes: Uint8Array;
}

function fail(message: string): never { throw new Error(message); }

function sameLocalizedText(
  left: { readonly "zh-TW": string; readonly en: string },
  right: { readonly "zh-TW": string; readonly en: string },
): boolean {
  return left["zh-TW"] === right["zh-TW"] && left.en === right.en;
}

function normalizedPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.startsWith("/")
    || value.endsWith("/") || value.includes("\\") || value.includes("\0")
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    fail(`${label} must be a normalized repository-relative POSIX path.`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} has an invalid shape.`);
}

function parseOptions(arguments_: readonly string[]): Options {
  const [command, ...rest] = arguments_;
  if (command !== "build" && command !== "verify") fail("Usage: woj organizer collection <build|verify> [repository-root] [--source path]");
  let root = ".";
  let sourcePath = SOURCE_PATH;
  let rootSeen = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--source") {
      const value = rest[index + 1];
      if (!value) fail("--source requires a path.");
      sourcePath = normalizedPath(value, "source path");
      index += 1;
    } else if (argument?.startsWith("-")) fail(`Unknown option '${argument}'.`);
    else if (!argument || rootSeen) fail("Only one repository root may be provided.");
    else { root = argument; rootSeen = true; }
  }
  return { command, root: path.resolve(root), sourcePath };
}

async function assertRoot(root: string): Promise<void> {
  const anchored = await canonicalizeSystemTemporaryPrefix(root);
  if (!await anchoredPathHasNoSymlink(anchored)) fail("repository root must not traverse a symbolic link.");
  const metadata = await lstat(anchored);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("repository root must be a real directory.");
}

function resolveInside(root: string, relative: string): string {
  return path.join(root, ...normalizedPath(relative, "repository path").split("/"));
}

async function readFile(root: string, relative: string, maximum: number, expected?: number): Promise<Uint8Array> {
  const absolute = resolveInside(root, relative);
  if (!await anchoredPathHasNoSymlink(absolute)) fail(`'${relative}' must not traverse a symbolic link.`);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum || (expected !== undefined && metadata.size !== expected)) {
      fail(`'${relative}' has an invalid size.`);
    }
    return new Uint8Array(await handle.readFile());
  } finally { await handle.close(); }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch (error) { throw new Error(`${label} must be valid UTF-8 JSON.`, { cause: error }); }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readDeclared(root: string, object: RepositorySourceObject, label: string): Promise<Uint8Array> {
  const bytes = await readFile(root, object.path, PACKAGE_MAX_BYTES, object.bytes);
  if (await sha256(bytes) !== object.sha256) fail(`${label} failed digest verification.`);
  return bytes;
}

async function judgeInput(root: string, judge: RepositorySourceJudge): Promise<JudgePackageInput["judge"]> {
  if (judge.kind === "text") return { kind: "text" };
  const artifact = await readDeclared(root, judge.artifact, `${judge.kind} artifact`);
  const assets: JudgePackageAssetInput[] = [];
  for (const asset of judge.assets) assets.push({ guestPath: asset.guestPath, contents: await readDeclared(root, asset, `${judge.kind} asset`) });
  return judge.kind === "checker"
    ? { kind: "checker", runtimeProfile: judge.artifact.runtimeProfile, artifact, assets, args: judge.args }
    : { kind: "interactive", runtimeProfile: judge.artifact.runtimeProfile, artifact, assets, args: judge.args, inputPath: judge.inputPath };
}

function localized(value: unknown, label: string, empty: boolean): LocalizedText {
  const input = record(value, label);
  exact(input, ["en", "zh-TW"], label);
  if (typeof input.en !== "string" || typeof input["zh-TW"] !== "string"
    || (!empty && (!input.en.trim() || !input["zh-TW"].trim()))) fail(`${label} must contain zh-TW and en strings.`);
  return { "zh-TW": input["zh-TW"], en: input.en };
}

function parseAuthoringSource(value: unknown): AuthoringSource {
  const source = record(value, "repository authoring source");
  exact(source, ["contests", "problems", "schema"], "repository authoring source");
  if (source.schema !== AUTHORING_SCHEMA || !Array.isArray(source.problems)) fail(`repository authoring schema must be '${AUTHORING_SCHEMA}'.`);
  const judgeSource = parseRepositoryAuthoringJudges({
    schema: "wasm-oj-platform/repository-authoring-judges/v1",
    problems: source.problems.map((candidate) => {
      const problem = record(candidate, "authoring problem");
      return { slug: problem.slug, allowedProfiles: problem.allowedProfiles, judge: problem.judge };
    }),
  });
  const problems = source.problems.map((candidate, index): AuthoredProblem => {
    const problem = record(candidate, `authoring problem ${index + 1}`);
    exact(problem, ["allowedProfiles", "authoringBundle", "judge", "order", "practiceEnabled", "slug", "summary", "title"], `authoring problem ${index + 1}`);
    if (!Number.isSafeInteger(problem.order) || problem.order !== index + 1 || typeof problem.practiceEnabled !== "boolean") {
      fail(`authoring problem ${index + 1} order or practiceEnabled is invalid.`);
    }
    const parsedJudge = judgeSource.problems[index]!;
    return {
      slug: parsedJudge.slug,
      order: problem.order as number,
      title: localized(problem.title, `authoring problem '${parsedJudge.slug}' title`, false),
      summary: localized(problem.summary, `authoring problem '${parsedJudge.slug}' summary`, true),
      practiceEnabled: problem.practiceEnabled,
      authoringBundle: normalizedPath(problem.authoringBundle, `authoring problem '${parsedJudge.slug}' bundle`),
      allowedProfiles: parsedJudge.allowedProfiles,
      judge: parsedJudge.judge,
    };
  });
  const contests = parseRepositoryContestsValue({ schema: "wasm-oj-platform/contests/v1", contests: source.contests }).contests;
  const known = new Set(problems.map((problem) => problem.slug));
  for (const contest of contests) for (const slug of contest.problems) if (!known.has(slug)) fail(`contest '${contest.slug}' references unknown problem '${slug}'.`);
  return { problems, contests };
}

async function atomicWrite(root: string, output: Output): Promise<void> {
  const absolute = resolveInside(root, output.path);
  const parent = path.dirname(absolute);
  await mkdir(parent, { recursive: true });
  if (!await anchoredPathHasNoSymlink(parent)) fail(`output parent for '${output.path}' must not traverse a symbolic link.`);
  const temporary = `${absolute}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(temporary, output.bytes, { flag: "wx", mode: 0o644 }); await rename(temporary, absolute); }
  finally { await rm(temporary, { force: true }); }
}

async function build(options: Options): Promise<number> {
  const source = parseAuthoringSource(parseJson(await readFile(options.root, options.sourcePath, JSON_MAX_BYTES), options.sourcePath));
  const problems: RepositoryProblem[] = [];
  const outputs: Output[] = [];
  for (const authored of source.problems) {
    const bundle = parseStandaloneProblemBundle(parseJson(
      await readFile(options.root, authored.authoringBundle, PACKAGE_MAX_BYTES),
      authored.authoringBundle,
    ));
    if (bundle.id !== authored.slug || bundle.number !== authored.order
      || !sameLocalizedText(bundle.title, authored.title)) {
      fail(`authoring bundle '${authored.slug}' disagrees with its declarative identity.`);
    }
    const practice = derivePracticePublic(bundle);
    const practiceBytes = canonicalJsonBytes({ schema: BROWSER_PROBLEM_SCHEMA, problem: practice });
    const practiceDigest = await sha256(practiceBytes);
    const contestBytes = contestPublicProjectionBytes(practice);
    const encoded = await encodeJudgePackage({
      judgeData: deriveJudgeData(bundle, Object.keys(authored.allowedProfiles) as BuiltinLanguage[]),
      allowedProfiles: authored.allowedProfiles,
      judge: await judgeInput(options.root, authored.judge),
    });
    const base = `collection/problems/${String(authored.order).padStart(3, "0")}-${authored.slug}`;
    const practicePath = `${base}.practice.json`;
    const contestPath = `${base}.contest.json`;
    const judgePath = `${base}.wasmojjudge`;
    outputs.push({ path: practicePath, bytes: practiceBytes }, { path: contestPath, bytes: contestBytes }, { path: judgePath, bytes: encoded.bytes });
    problems.push({
      slug: authored.slug,
      order: authored.order,
      title: authored.title,
      summary: authored.summary,
      practiceEnabled: authored.practiceEnabled,
      practiceBundle: { path: practicePath, bytes: practiceBytes.byteLength, sha256: practiceDigest },
      contestBundle: { path: contestPath, bytes: contestBytes.byteLength, sha256: await sha256(contestBytes) },
      judgePackage: { path: judgePath, bytes: encoded.bytes.byteLength, sha256: encoded.executionSemanticSha256 },
    });
  }
  const problemManifest = { schema: "wasm-oj-platform/problems/v1", problems };
  parseRepositoryProblemsValue(problemManifest);
  const contestManifest = { schema: "wasm-oj-platform/contests/v1", contests: source.contests };
  parseRepositoryContestsValue(contestManifest);
  const root = { schema: "wasm-oj-platform/repository/v1", problems: PROBLEMS_PATH, contests: CONTESTS_PATH };
  parseRepositoryRootValue(root);
  outputs.push(
    { path: PROBLEMS_PATH, bytes: canonicalJsonBytes(problemManifest) },
    { path: CONTESTS_PATH, bytes: canonicalJsonBytes(contestManifest) },
    { path: ROOT_PATH, bytes: canonicalJsonBytes(root) },
  );
  for (const output of outputs) await atomicWrite(options.root, output);
  return problems.length;
}

async function verifiedObject(root: string, descriptor: { readonly path: string; readonly bytes: number; readonly sha256: string }, maximum: number): Promise<Uint8Array> {
  const bytes = await readFile(root, descriptor.path, maximum, descriptor.bytes);
  if (await sha256(bytes) !== descriptor.sha256) fail(`'${descriptor.path}' failed digest verification.`);
  return bytes;
}

async function verify(options: Options): Promise<number> {
  const root = parseRepositoryRootValue(parseJson(await readFile(options.root, ROOT_PATH, JSON_MAX_BYTES), ROOT_PATH));
  const problems = parseRepositoryProblemsValue(parseJson(await readFile(options.root, root.problems, JSON_MAX_BYTES), root.problems));
  const contests = parseRepositoryContestsValue(parseJson(await readFile(options.root, root.contests, JSON_MAX_BYTES), root.contests));
  const known = new Set(problems.problems.map((problem) => problem.slug));
  for (const contest of contests.contests) for (const slug of contest.problems) if (!known.has(slug)) fail(`contest '${contest.slug}' references unknown problem '${slug}'.`);
  for (const problem of problems.problems) {
    const practiceBytes = await verifiedObject(options.root, problem.practiceBundle, PUBLIC_MAX_BYTES);
    const practice = parseStandaloneProblemBundle(parseJson(practiceBytes, problem.practiceBundle.path));
    if (practice.id !== problem.slug || practice.number !== problem.order || !sameLocalizedText(practice.title, problem.title)) {
      fail(`practice bundle '${problem.slug}' disagrees with problems.json.`);
    }
    const contestBytes = await verifiedObject(options.root, problem.contestBundle, PUBLIC_MAX_BYTES);
    const contest = parseContestPublicProblemProjection(parseJson(contestBytes, problem.contestBundle.path));
    const expectedContest = canonicalJsonBytes(deriveContestPublic(practice));
    if (!Buffer.from(canonicalJsonBytes(contest.problem)).equals(Buffer.from(expectedContest))) {
      fail(`contest bundle '${problem.slug}' is not the public projection of its practice bundle.`);
    }
    const packageBytes = await verifiedObject(options.root, problem.judgePackage, PACKAGE_MAX_BYTES);
    const validated = await validateJudgePackage(packageBytes, {
      expectedBytes: problem.judgePackage.bytes,
      expectedSha256: problem.judgePackage.sha256,
      memoryLimitBytes: Math.max(...practice.scoring.policies.map((policy) => policy.limits.memoryLimitBytes)),
    });
    assertJudgeDataMatchesPracticePublic(validated.judgeData, practice, Object.keys(validated.manifest.allowedProfiles) as BuiltinLanguage[]);
  }
  return problems.problems.length;
}

export async function runCollectionCli(arguments_: readonly string[]): Promise<void> {
  const options = parseOptions(arguments_);
  await assertRoot(options.root);
  const count = options.command === "build" ? await build(options) : await verify(options);
  process.stdout.write(`${options.command} ok: ${count} problems\n`);
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invokedDirectly) {
  runCollectionCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`woj organizer collection: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
