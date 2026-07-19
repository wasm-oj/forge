import {
  MAX_LOGICAL_TIME_LIMIT_MS,
  MAX_MEMORY_LIMIT_BYTES,
  MAX_WALL_TIME_LIMIT_MS,
  WASM_MEMORY_PAGE_BYTES,
} from "../core/resources";
import {
  PROBLEM_LOCALES,
  type JudgeProblem,
  type JudgeProblemSummary,
  type LocalizedText,
  type ProblemComplexity,
  type ProblemDifficulty,
  type ProblemPolicyLimits,
  type ProblemScoringPolicy,
} from "./problem-model";

export const BROWSER_COLLECTION_SCHEMA = "wasm-oj-browser-collection-v4";
export const BROWSER_PROBLEM_SCHEMA = "wasm-oj-browser-problem-v3";
export const PROBLEM_COLLECTION_SOURCE_KEY = "wasm-oj-forge-v1:problem-collection-source";
export const DEFAULT_PROBLEM_COLLECTION_SOURCE = Object.freeze({
  provider: "github",
  owner: "wasm-oj",
  repository: "problems",
  ref: "main",
  indexPath: "collection/index.json",
} as const satisfies GithubProblemCollectionSource);

const INDEX_MAX_BYTES = 512 * 1024;
const BUNDLE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_PROBLEMS = 1_000;
const CACHE_NAME = "wasm-oj-verified-problem-collections-v4";
const LANGUAGES = ["c", "cpp", "rust", "go", "python", "javascript", "typescript"] as const;
const POLICY_IDS = ["baseline", "efficient", "optimal"] as const;
const CALIBRATION_METHOD = "forge-v1-compiled-average-optimal-rounded-v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

export interface GithubProblemCollectionSource {
  readonly provider: "github";
  readonly owner: string;
  readonly repository: string;
  readonly ref: string;
  readonly indexPath: string;
}

export interface ProblemBundleDescriptor {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ProblemCollectionEntry extends JudgeProblemSummary {
  readonly statementPaths: LocalizedText;
  readonly bundle: ProblemBundleDescriptor;
}

export interface ProblemCollectionIndex {
  readonly schema: typeof BROWSER_COLLECTION_SCHEMA;
  readonly problemSchema: typeof BROWSER_PROBLEM_SCHEMA;
  readonly revision: string;
  readonly localization: {
    readonly defaultLocale: "zh-TW";
    readonly supportedLocales: readonly ["zh-TW", "en"];
  };
  readonly problems: readonly ProblemCollectionEntry[];
}

export type ProblemCollectionOrigin = "network" | "verified-cache";

export interface LoadedProblemCollection {
  readonly source: GithubProblemCollectionSource;
  readonly sourceKey: string;
  readonly index: ProblemCollectionIndex;
  readonly origin: ProblemCollectionOrigin;
  loadProblem(id: string, signal?: AbortSignal): Promise<JudgeProblem>;
}

interface ProblemCollectionCache {
  getIndex(sourceKey: string): Promise<Uint8Array | undefined>;
  putIndex(sourceKey: string, bytes: Uint8Array): Promise<void>;
  getBundle(digest: string): Promise<Uint8Array | undefined>;
  putBundle(digest: string, bytes: Uint8Array): Promise<void>;
  deleteBundle(digest: string): Promise<void>;
}

interface LoadProblemCollectionOptions {
  readonly fetch?: typeof fetch;
  readonly cache?: ProblemCollectionCache;
  readonly signal?: AbortSignal;
}

export class ProblemCollectionError extends Error {
  constructor(
    message: string,
    readonly kind: "configuration" | "network" | "integrity" | "schema",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProblemCollectionError";
  }
}

export function normalizeProblemCollectionSource(value: unknown): GithubProblemCollectionSource {
  if (!isRecord(value) || !hasExactKeys(value, ["provider", "owner", "repository", "ref", "indexPath"])) {
    throw new ProblemCollectionError("Problem collection settings have an invalid shape.", "configuration");
  }
  if (value.provider !== "github") {
    throw new ProblemCollectionError("Only GitHub problem collections are supported.", "configuration");
  }
  const owner = normalizedGithubName(value.owner, "owner");
  const repository = normalizedGithubName(value.repository, "repository");
  if (typeof value.ref !== "string" || !isValidGitRef(value.ref)) {
    throw new ProblemCollectionError("The GitHub ref is invalid.", "configuration");
  }
  const indexPath = normalizedRelativePath(value.indexPath, "index path");
  if (!indexPath.endsWith(".json")) {
    throw new ProblemCollectionError("The problem collection index must be a JSON file.", "configuration");
  }
  return { provider: "github", owner, repository, ref: value.ref, indexPath };
}

export function problemCollectionSourceKey(sourceValue: GithubProblemCollectionSource): string {
  const source = normalizeProblemCollectionSource(sourceValue);
  return `github:${source.owner}/${source.repository}@${source.ref}:${source.indexPath}`;
}

export function githubRawContentUrl(sourceValue: GithubProblemCollectionSource, repositoryPath: string): string {
  const source = normalizeProblemCollectionSource(sourceValue);
  const normalizedPath = normalizedRelativePath(repositoryPath, "repository path");
  const segments = [source.owner, source.repository, source.ref, ...normalizedPath.split("/")]
    .map((segment) => encodeURIComponent(segment));
  return `https://raw.githubusercontent.com/${segments.join("/")}`;
}

export function parseProblemCollectionIndex(value: unknown): ProblemCollectionIndex {
  if (!isRecord(value) || !hasExactKeys(value, ["schema", "problemSchema", "revision", "localization", "problems"])) {
    throw schemaError("The problem collection index has an invalid shape.");
  }
  if (value.schema !== BROWSER_COLLECTION_SCHEMA || value.problemSchema !== BROWSER_PROBLEM_SCHEMA) {
    throw schemaError("The problem collection uses an unsupported schema.");
  }
  if (typeof value.revision !== "string" || !SHA256_PATTERN.test(value.revision)) {
    throw schemaError("The problem collection revision is invalid.");
  }
  if (!isRecord(value.localization) || !hasExactKeys(value.localization, ["defaultLocale", "supportedLocales"]) || value.localization.defaultLocale !== "zh-TW" || !sameStringArray(value.localization.supportedLocales, PROBLEM_LOCALES)) {
    throw schemaError("The problem collection localization contract is unsupported.");
  }
  if (!Array.isArray(value.problems) || value.problems.length < 1 || value.problems.length > MAX_PROBLEMS) {
    throw schemaError(`The problem collection must contain between 1 and ${MAX_PROBLEMS} problems.`);
  }
  const ids = new Set<string>();
  const bundlePaths = new Set<string>();
  const bundleDigests = new Set<string>();
  const problems = value.problems.map((entry, index) => parseCollectionEntry(entry, index + 1, ids, bundlePaths, bundleDigests));
  return {
    schema: BROWSER_COLLECTION_SCHEMA,
    problemSchema: BROWSER_PROBLEM_SCHEMA,
    revision: value.revision,
    localization: { defaultLocale: "zh-TW", supportedLocales: PROBLEM_LOCALES },
    problems,
  };
}

export function parseProblemBundle(
  value: unknown,
  expected: ProblemCollectionEntry,
): JudgeProblem {
  if (!isRecord(value) || !hasExactKeys(value, ["schema", "problem"]) || value.schema !== BROWSER_PROBLEM_SCHEMA) {
    throw schemaError("The problem bundle uses an unsupported schema.");
  }
  const problem = parseJudgeProblem(value.problem);
  if (
    problem.id !== expected.id
    || problem.number !== expected.number
    || problem.difficulty !== expected.difficulty
    || problem.judgeCases.length !== expected.caseCount
    || !sameStringArray(problem.tags, expected.tags)
    || !sameLocalizedText(problem.title, expected.title)
    || problem.trackId !== expected.trackId
    || !sameLocalizedText(problem.track, expected.track)
  ) {
    throw schemaError(`Problem bundle '${expected.id}' disagrees with its collection index entry.`);
  }
  return problem;
}

export async function loadProblemCollection(
  sourceValue: GithubProblemCollectionSource,
  options: LoadProblemCollectionOptions = {},
): Promise<LoadedProblemCollection> {
  const source = normalizeProblemCollectionSource(sourceValue);
  const sourceKey = problemCollectionSourceKey(source);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (!fetchImplementation) throw new ProblemCollectionError("Fetch is unavailable in this browser.", "network");
  const cache = options.cache ?? createBrowserProblemCollectionCache();
  const indexUrl = githubRawContentUrl(source, source.indexPath);
  let indexBytes: Uint8Array;
  let origin: ProblemCollectionOrigin = "network";
  try {
    indexBytes = await fetchBoundedBytes(fetchImplementation, indexUrl, INDEX_MAX_BYTES, options.signal);
  } catch (error) {
    if (!(error instanceof ProblemCollectionError) || error.kind !== "network") throw error;
    const cached = await readCachedBytes(() => cache.getIndex(sourceKey));
    if (!cached) throw error;
    indexBytes = cached;
    origin = "verified-cache";
  }
  const index = parseProblemCollectionIndex(parseUtf8Json(indexBytes, "problem collection index"));
  await verifyCollectionRevision(index);
  if (origin === "network") await ignoreCacheWrite(() => cache.putIndex(sourceKey, indexBytes));

  const entryById = new Map(index.problems.map((entry) => [entry.id, entry]));
  const inMemory = new Map<string, JudgeProblem>();
  return {
    source,
    sourceKey,
    index,
    origin,
    loadProblem(id, signal) {
      const entry = entryById.get(id);
      if (!entry) return Promise.reject(new ProblemCollectionError(`Unknown problem '${id}'.`, "configuration"));
      const existing = inMemory.get(entry.bundle.sha256);
      if (existing) return Promise.resolve(existing);
      return loadVerifiedProblem(source, entry, fetchImplementation, cache, signal).then((problem) => {
        inMemory.set(entry.bundle.sha256, problem);
        return problem;
      });
    },
  };
}

export async function clearProblemCollectionCache(): Promise<void> {
  if (globalThis.caches) await globalThis.caches.delete(CACHE_NAME);
}

async function loadVerifiedProblem(
  source: GithubProblemCollectionSource,
  entry: ProblemCollectionEntry,
  fetchImplementation: typeof fetch,
  cache: ProblemCollectionCache,
  signal?: AbortSignal,
): Promise<JudgeProblem> {
  const cached = await readCachedBytes(() => cache.getBundle(entry.bundle.sha256));
  if (cached) {
    try {
      return await verifyProblemBytes(cached, entry);
    } catch {
      await ignoreCacheWrite(() => cache.deleteBundle(entry.bundle.sha256));
    }
  }
  const repositoryPath = resolveIndexRelativePath(source.indexPath, entry.bundle.path);
  const bytes = await fetchBoundedBytes(
    fetchImplementation,
    githubRawContentUrl(source, repositoryPath),
    entry.bundle.bytes,
    signal,
  );
  const problem = await verifyProblemBytes(bytes, entry);
  await ignoreCacheWrite(() => cache.putBundle(entry.bundle.sha256, bytes));
  return problem;
}

async function readCachedBytes(read: () => Promise<Uint8Array | undefined>): Promise<Uint8Array | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

async function ignoreCacheWrite(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch {
    // Persistent cache is an optimization; network bytes are still verified independently.
  }
}

async function verifyProblemBytes(bytes: Uint8Array, entry: ProblemCollectionEntry): Promise<JudgeProblem> {
  if (bytes.byteLength !== entry.bundle.bytes) {
    throw new ProblemCollectionError(`Problem '${entry.id}' byte length does not match its index.`, "integrity");
  }
  const digest = await sha256Hex(bytes);
  if (digest !== entry.bundle.sha256) {
    throw new ProblemCollectionError(`Problem '${entry.id}' failed SHA-256 verification.`, "integrity");
  }
  return parseProblemBundle(parseUtf8Json(bytes, `problem '${entry.id}'`), entry);
}

async function fetchBoundedBytes(
  fetchImplementation: typeof fetch,
  url: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImplementation(url, { cache: "no-cache", signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ProblemCollectionError(`Unable to reach the configured problem collection.`, "network", { cause: error });
  }
  if (!response.ok) {
    throw new ProblemCollectionError(`Problem collection request failed with HTTP ${response.status}.`, "configuration");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximumBytes) {
      throw new ProblemCollectionError("Problem collection response exceeds its size limit.", "integrity");
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new ProblemCollectionError("Problem collection response exceeds its size limit.", "integrity");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        try { await reader.cancel(); } catch { /* The integrity failure remains authoritative. */ }
        throw new ProblemCollectionError("Problem collection response exceeds its size limit.", "integrity");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProblemCollectionError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ProblemCollectionError("Problem collection response stream was interrupted.", "network", { cause: error });
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseCollectionEntry(
  value: unknown,
  expectedNumber: number,
  ids: Set<string>,
  bundlePaths: Set<string>,
  bundleDigests: Set<string>,
): ProblemCollectionEntry {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "number", "title", "trackId", "track", "statementPaths", "difficulty", "tags", "caseCount", "bundle"])) {
    throw schemaError(`Problem collection entry ${expectedNumber} has an invalid shape.`);
  }
  if (value.number !== expectedNumber || typeof value.id !== "string" || !ID_PATTERN.test(value.id) || ids.has(value.id)) {
    throw schemaError(`Problem collection entry ${expectedNumber} has an invalid identity.`);
  }
  ids.add(value.id);
  const difficulty = parseDifficulty(value.difficulty, `problem '${value.id}'`);
  const tags = parseTags(value.tags, `problem '${value.id}'`);
  if (typeof value.trackId !== "string" || !ID_PATTERN.test(value.trackId)) {
    throw schemaError(`Problem '${value.id}' has an invalid track ID.`);
  }
  if (!Number.isSafeInteger(value.caseCount) || (value.caseCount as number) < 1 || (value.caseCount as number) > 10_000) {
    throw schemaError(`Problem '${value.id}' has an invalid case count.`);
  }
  if (!isRecord(value.bundle) || !hasExactKeys(value.bundle, ["path", "sha256", "bytes"])) {
    throw schemaError(`Problem '${value.id}' has an invalid bundle descriptor.`);
  }
  const bundlePath = normalizedRelativePath(value.bundle.path, `problem '${value.id}' bundle path`);
  if (!bundlePath.startsWith("problems/") || !bundlePath.endsWith(".json")) {
    throw schemaError(`Problem '${value.id}' bundle path is outside the problems directory.`);
  }
  if (typeof value.bundle.sha256 !== "string" || !SHA256_PATTERN.test(value.bundle.sha256)) {
    throw schemaError(`Problem '${value.id}' has an invalid bundle digest.`);
  }
  if (!bundlePath.endsWith(`.${value.bundle.sha256}.json`) || bundlePaths.has(bundlePath) || bundleDigests.has(value.bundle.sha256)) {
    throw schemaError(`Problem '${value.id}' does not have a unique content-addressed bundle path.`);
  }
  bundlePaths.add(bundlePath);
  bundleDigests.add(value.bundle.sha256);
  const rawStatementPaths = parseLocalizedText(value.statementPaths, `problem '${value.id}' statement paths`);
  const statementPaths = {
    "zh-TW": normalizedRelativePath(
      rawStatementPaths["zh-TW"],
      `problem '${value.id}' statement path for 'zh-TW'`,
    ),
    en: normalizedRelativePath(
      rawStatementPaths.en,
      `problem '${value.id}' statement path for 'en'`,
    ),
  } satisfies LocalizedText;
  if (PROBLEM_LOCALES.some((locale) => !statementPaths[locale].endsWith(".md"))) {
    throw schemaError(`Problem '${value.id}' has a statement path that is not Markdown.`);
  }
  if (!Number.isSafeInteger(value.bundle.bytes) || (value.bundle.bytes as number) < 2 || (value.bundle.bytes as number) > BUNDLE_MAX_BYTES) {
    throw schemaError(`Problem '${value.id}' has an invalid bundle byte length.`);
  }
  return {
    id: value.id,
    number: expectedNumber,
    title: parseLocalizedText(value.title, `problem '${value.id}' title`),
    trackId: value.trackId,
    track: parseLocalizedText(value.track, `problem '${value.id}' track`),
    statementPaths,
    difficulty,
    tags,
    caseCount: value.caseCount as number,
    bundle: { path: bundlePath, sha256: value.bundle.sha256, bytes: value.bundle.bytes as number },
  };
}

function parseJudgeProblem(value: unknown): JudgeProblem {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "number", "title", "trackId", "track", "difficulty", "tags", "statement", "editorial", "judgeCases", "scoring", "complexities"])) {
    throw schemaError("The judge problem has an invalid shape.");
  }
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id) || !Number.isSafeInteger(value.number) || (value.number as number) < 1) {
    throw schemaError("The judge problem has an invalid identity.");
  }
  const id = value.id;
  const title = parseLocalizedText(value.title, `problem '${id}' title`);
  if (typeof value.trackId !== "string" || !ID_PATTERN.test(value.trackId)) {
    throw schemaError(`Problem '${id}' has an invalid track ID.`);
  }
  const track = parseLocalizedText(value.track, `problem '${id}' track`);
  const statement = parseLocalizedText(value.statement, `problem '${id}' statement`, false);
  const editorial = parseLocalizedText(value.editorial, `problem '${id}' editorial`, false);
  const difficulty = parseDifficulty(value.difficulty, `problem '${id}'`);
  const tags = parseTags(value.tags, `problem '${id}'`);
  if (!Array.isArray(value.judgeCases) || value.judgeCases.length < 1 || value.judgeCases.length > 10_000) {
    throw schemaError(`Problem '${value.id}' has an invalid case inventory.`);
  }
  const caseIds = new Set<string>();
  const judgeCases = value.judgeCases.map((testCase, index) => {
    if (!isRecord(testCase) || !hasExactKeys(testCase, ["id", "kind", "input", "output"]) || typeof testCase.id !== "string" || !ID_PATTERN.test(testCase.id) || caseIds.has(testCase.id) || !["sample", "adversarial", "regression"].includes(String(testCase.kind)) || typeof testCase.input !== "string" || typeof testCase.output !== "string") {
      throw schemaError(`Problem '${value.id}' has an invalid case at position ${index + 1}.`);
    }
    caseIds.add(testCase.id);
    return { id: testCase.id, kind: testCase.kind as "sample" | "adversarial" | "regression", input: testCase.input, output: testCase.output };
  });
  if (judgeCases.filter((testCase) => testCase.kind === "sample").length !== 3) {
    throw schemaError(`Problem '${value.id}' must contain exactly three sample cases.`);
  }
  const scoring = parseScoring(value.scoring, id);
  if (!Array.isArray(value.complexities) || value.complexities.length < 2 || value.complexities.length > 32) {
    throw schemaError(`Problem '${value.id}' has an invalid complexity inventory.`);
  }
  const complexities = value.complexities.map((complexity, index) => parseComplexity(complexity, id, index));
  if (!complexities.at(-1)?.accepted) throw schemaError(`Problem '${id}' must end with its accepted complexity.`);
  return { id, number: value.number as number, title, trackId: value.trackId, track, difficulty, tags, statement, editorial, judgeCases, scoring, complexities };
}

function parseScoring(value: unknown, problemId: string): JudgeProblem["scoring"] {
  if (!isRecord(value) || !hasExactKeys(value, ["maximumPoints", "calibration", "policies", "safetyLimits"]) || value.maximumPoints !== 100) {
    throw schemaError(`Problem '${problemId}' has invalid scoring metadata.`);
  }
  const calibration = value.calibration;
  if (!isRecord(calibration) || !hasExactKeys(calibration, ["method", "profiles"]) || calibration.method !== CALIBRATION_METHOD) {
    throw schemaError(`Problem '${problemId}' has invalid calibration metadata.`);
  }
  const profiles = calibration.profiles;
  if (!isRecord(profiles) || !hasExactKeys(profiles, LANGUAGES) || LANGUAGES.some((language) => typeof profiles[language] !== "string" || !(profiles[language] as string) || profiles[language] !== (profiles[language] as string).trim())) {
    throw schemaError(`Problem '${problemId}' has invalid calibration profiles.`);
  }
  if (!Array.isArray(value.policies) || value.policies.length !== POLICY_IDS.length) {
    throw schemaError(`Problem '${problemId}' has invalid scoring policies.`);
  }
  const policies = value.policies.map((policy, index) => parsePolicy(policy, problemId, POLICY_IDS[index]));
  if (policies.reduce((total, policy) => total + policy.points, 0) !== 100) throw schemaError(`Problem '${problemId}' policy points must sum to 100.`);
  for (let index = 1; index < policies.length; index += 1) {
    const broad = policies[index - 1].limits;
    const strict = policies[index].limits;
    const logicalInvalid = broad.logicalTimeLimitMs !== undefined
      && (strict.logicalTimeLimitMs === undefined || strict.logicalTimeLimitMs > broad.logicalTimeLimitMs);
    const anyStricter = strict.instructionBudget < broad.instructionBudget
      || strict.memoryLimitBytes < broad.memoryLimitBytes
      || (broad.logicalTimeLimitMs === undefined && strict.logicalTimeLimitMs !== undefined)
      || (broad.logicalTimeLimitMs !== undefined && strict.logicalTimeLimitMs !== undefined && strict.logicalTimeLimitMs < broad.logicalTimeLimitMs);
    if (strict.instructionBudget > broad.instructionBudget || strict.memoryLimitBytes > broad.memoryLimitBytes || logicalInvalid || !anyStricter) {
      throw schemaError(`Problem '${problemId}' policies are not broad-to-strict.`);
    }
  }
  if (!isRecord(value.safetyLimits) || !hasExactKeys(value.safetyLimits, ["wallTimeLimitMs"]) || !isPositiveSafeInteger(value.safetyLimits.wallTimeLimitMs) || (value.safetyLimits.wallTimeLimitMs as number) > MAX_WALL_TIME_LIMIT_MS) {
    throw schemaError(`Problem '${problemId}' has invalid safety limits.`);
  }
  return {
    maximumPoints: 100,
    calibration: { method: CALIBRATION_METHOD, profiles: profiles as Record<string, string> },
    policies,
    safetyLimits: { wallTimeLimitMs: value.safetyLimits.wallTimeLimitMs as number },
  };
}

function parsePolicy(value: unknown, problemId: string, expectedId: typeof POLICY_IDS[number]): ProblemScoringPolicy {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "title", "points", "limits"]) || value.id !== expectedId || !isPositiveSafeInteger(value.points) || !isRecord(value.limits)) {
    throw schemaError(`Problem '${problemId}' has an invalid '${expectedId}' policy.`);
  }
  const keys = Object.keys(value.limits).sort();
  if (JSON.stringify(keys) !== JSON.stringify(keys.includes("logicalTimeLimitMs") ? ["instructionBudget", "logicalTimeLimitMs", "memoryLimitBytes"] : ["instructionBudget", "memoryLimitBytes"])) {
    throw schemaError(`Problem '${problemId}' policy '${expectedId}' has invalid limits.`);
  }
  if (!isPositiveSafeInteger(value.limits.instructionBudget)
    || !isPositiveSafeInteger(value.limits.memoryLimitBytes)
    || (value.limits.memoryLimitBytes as number) < WASM_MEMORY_PAGE_BYTES
    || (value.limits.memoryLimitBytes as number) > MAX_MEMORY_LIMIT_BYTES
    || (value.limits.memoryLimitBytes as number) % WASM_MEMORY_PAGE_BYTES !== 0
    || (value.limits.logicalTimeLimitMs !== undefined && (!isPositiveSafeInteger(value.limits.logicalTimeLimitMs) || (value.limits.logicalTimeLimitMs as number) > MAX_LOGICAL_TIME_LIMIT_MS))) {
    throw schemaError(`Problem '${problemId}' policy '${expectedId}' has invalid resource values.`);
  }
  const limits: ProblemPolicyLimits = {
    instructionBudget: value.limits.instructionBudget as number,
    memoryLimitBytes: value.limits.memoryLimitBytes as number,
    ...(value.limits.logicalTimeLimitMs === undefined ? {} : { logicalTimeLimitMs: value.limits.logicalTimeLimitMs as number }),
  };
  return { id: expectedId, title: parseLocalizedText(value.title, `problem '${problemId}' policy '${expectedId}' title`), points: value.points as number, limits };
}

function parseComplexity(value: unknown, problemId: string, index: number): ProblemComplexity {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "time", "space", "accepted"]) || typeof value.time !== "string" || !value.time || typeof value.space !== "string" || !value.space || typeof value.accepted !== "boolean") {
    throw schemaError(`Problem '${problemId}' has an invalid complexity at position ${index + 1}.`);
  }
  return { name: parseLocalizedText(value.name, `problem '${problemId}' complexity name`), time: value.time, space: value.space, accepted: value.accepted };
}

function parseLocalizedText(value: unknown, label: string, trimmed = true): LocalizedText {
  if (!isRecord(value) || !hasExactKeys(value, PROBLEM_LOCALES)) throw schemaError(`${label} is invalid.`);
  for (const locale of PROBLEM_LOCALES) {
    if (typeof value[locale] !== "string" || !value[locale] || (trimmed && value[locale] !== (value[locale] as string).trim())) throw schemaError(`${label}[${locale}] is invalid.`);
  }
  return value as unknown as LocalizedText;
}

function parseDifficulty(value: unknown, label: string): ProblemDifficulty {
  if (value !== "easy" && value !== "medium" && value !== "hard") throw schemaError(`${label} has an invalid difficulty.`);
  return value;
}

function parseTags(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some((tag) => typeof tag !== "string" || !tag || tag !== tag.trim()) || new Set(value).size !== value.length) throw schemaError(`${label} has invalid tags.`);
  return value as string[];
}

function resolveIndexRelativePath(indexPath: string, bundlePath: string): string {
  const directory = indexPath.split("/").slice(0, -1);
  return normalizedRelativePath([...directory, ...bundlePath.split("/")].join("/"), "resolved bundle path");
}

function parseUtf8Json(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ProblemCollectionError(`${label} is not valid UTF-8.`, "integrity", { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProblemCollectionError(`${label} is not valid JSON.`, "schema", { cause: error });
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyCollectionRevision(index: ProblemCollectionIndex): Promise<void> {
  const revisionInput = index.problems
    .map((entry) => `${entry.number}\0${entry.bundle.sha256}\0${entry.statementPaths["zh-TW"]}\0${entry.statementPaths.en}\n`)
    .join("");
  if (await sha256Hex(new TextEncoder().encode(revisionInput)) !== index.revision) {
    throw new ProblemCollectionError("The problem collection revision does not match its ordered bundles.", "integrity");
  }
}

function createBrowserProblemCollectionCache(): ProblemCollectionCache {
  if (!globalThis.caches) return new MemoryProblemCollectionCache();
  const open = () => globalThis.caches.open(CACHE_NAME);
  const indexKey = (sourceKey: string) => `https://forge.problem-cache.invalid/index/${encodeURIComponent(sourceKey)}`;
  const bundleKey = (digest: string) => `https://forge.problem-cache.invalid/bundle/${digest}`;
  const read = async (key: string) => {
    const response = await (await open()).match(key);
    return response ? new Uint8Array(await response.arrayBuffer()) : undefined;
  };
  return {
    getIndex: (sourceKey) => read(indexKey(sourceKey)),
    async putIndex(sourceKey, bytes) { await (await open()).put(indexKey(sourceKey), new Response(bytes.slice().buffer)); },
    getBundle: (digest) => read(bundleKey(digest)),
    async putBundle(digest, bytes) { await (await open()).put(bundleKey(digest), new Response(bytes.slice().buffer)); },
    async deleteBundle(digest) { await (await open()).delete(bundleKey(digest)); },
  };
}

export class MemoryProblemCollectionCache implements ProblemCollectionCache {
  readonly indexes = new Map<string, Uint8Array>();
  readonly bundles = new Map<string, Uint8Array>();
  async getIndex(sourceKey: string) { return this.indexes.get(sourceKey)?.slice(); }
  async putIndex(sourceKey: string, bytes: Uint8Array) { this.indexes.set(sourceKey, bytes.slice()); }
  async getBundle(digest: string) { return this.bundles.get(digest)?.slice(); }
  async putBundle(digest: string, bytes: Uint8Array) { this.bundles.set(digest, bytes.slice()); }
  async deleteBundle(digest: string) { this.bundles.delete(digest); }
}

function normalizedGithubName(value: unknown, label: string): string {
  if (typeof value !== "string" || !GITHUB_NAME_PATTERN.test(value)) throw new ProblemCollectionError(`The GitHub ${label} is invalid.`, "configuration");
  return value;
}

function isValidGitRef(value: string): boolean {
  const forbidden = new Set(["~", "^", ":", "?", "*", "[", "\\"]);
  return value.length > 0
    && value.length <= 255
    && value === value.trim()
    && value !== "@"
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.includes("..")
    && !value.includes("//")
    && !value.includes("@{")
    && value.split("/").every((segment) => !segment.startsWith(".") && !segment.endsWith(".lock"))
    && [...value].every((character) => character.charCodeAt(0) > 0x20 && !forbidden.has(character));
}

function normalizedRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.endsWith("/") || value.includes("\\") || value.includes("\0")) throw new ProblemCollectionError(`The ${label} is not a normalized relative path.`, "configuration");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new ProblemCollectionError(`The ${label} is not a normalized relative path.`, "configuration");
  return value;
}

function sameLocalizedText(left: LocalizedText, right: LocalizedText): boolean {
  return PROBLEM_LOCALES.every((locale) => left[locale] === right[locale]);
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return actual.length === expectedKeys.length && actual.every((key, index) => key === expectedKeys[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function schemaError(message: string): ProblemCollectionError {
  return new ProblemCollectionError(message, "schema");
}
