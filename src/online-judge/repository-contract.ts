import { parseContestRules, type ContestRules } from "./contest-rules";

export const REPOSITORY_SCHEMA = "wasm-oj-platform/repository/v1";
export const PROBLEMS_SCHEMA = "wasm-oj-platform/problems/v1";
export const CONTESTS_SCHEMA = "wasm-oj-platform/contests/v2";

export const REPOSITORY_ROOT_PATH = "wasm-oj.json";
export const MAX_REPOSITORY_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_PUBLIC_BUNDLE_BYTES = 8 * 1024 * 1024;
export const MAX_JUDGE_PACKAGE_BYTES = 32 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000-\u001f\u007f]+$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface RepositoryObjectDescriptor {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LocalizedText {
  readonly "zh-TW": string;
  readonly en: string;
}

export interface RepositoryRootManifest {
  readonly schema: typeof REPOSITORY_SCHEMA;
  readonly problems: string;
  readonly contests: string;
}

export interface RepositoryProblem {
  readonly slug: string;
  readonly order: number;
  readonly title: LocalizedText;
  readonly summary: LocalizedText;
  readonly practiceEnabled: boolean;
  readonly practiceBundle: RepositoryObjectDescriptor;
  readonly contestBundle: RepositoryObjectDescriptor;
  readonly judgePackage: RepositoryObjectDescriptor;
}

export interface RepositoryProblemsManifest {
  readonly schema: typeof PROBLEMS_SCHEMA;
  readonly problems: readonly RepositoryProblem[];
}

export type RepositoryContestStatus = "draft" | "published" | "archived";
export type RepositoryContestAccessMode = "public" | "invite";

export interface RepositoryContest {
  readonly slug: string;
  readonly status: RepositoryContestStatus;
  readonly title: string;
  readonly description: string;
  readonly accessMode: RepositoryContestAccessMode;
  readonly rules: ContestRules;
}

export interface RepositoryContestsManifest {
  readonly schema: typeof CONTESTS_SCHEMA;
  readonly contests: readonly RepositoryContest[];
}

export interface RepositoryCatalog {
  readonly root: RepositoryRootManifest;
  readonly problems: RepositoryProblemsManifest;
  readonly contests: RepositoryContestsManifest;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) throw new TypeError(`${label} has an invalid shape.`);
}

export function repositoryPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || !PATH.test(value)) {
    throw new TypeError(`${label} must be a normalized repository-relative POSIX path.`);
  }
  return value;
}

function slug(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 128 || !SLUG.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new TypeError(`${label} exceeds its UTF-8 byte limit.`);
  }
  return value;
}

function localizedText(value: unknown, label: string, maximumBytes: number): LocalizedText {
  const input = record(value, label);
  exact(input, ["en", "zh-TW"], label);
  return {
    "zh-TW": boundedText(input["zh-TW"], `${label}.zh-TW`, maximumBytes),
    en: boundedText(input.en, `${label}.en`, maximumBytes),
  };
}

function descriptor(value: unknown, label: string, maximumBytes: number): RepositoryObjectDescriptor {
  const input = record(value, label);
  exact(input, ["bytes", "path", "sha256"], label);
  if (!Number.isSafeInteger(input.bytes) || (input.bytes as number) < 1 || (input.bytes as number) > maximumBytes) {
    throw new TypeError(`${label}.bytes is outside its limit.`);
  }
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) {
    throw new TypeError(`${label}.sha256 must be a lowercase SHA-256 digest.`);
  }
  return {
    path: repositoryPath(input.path, `${label}.path`),
    bytes: input.bytes as number,
    sha256: input.sha256,
  };
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > MAX_REPOSITORY_MANIFEST_BYTES) {
    throw new TypeError(`${label} bytes are outside the 2 MiB limit.`);
  }
  let text: string;
  try { text = decoder.decode(bytes); }
  catch (error) { throw new TypeError(`${label} must be valid UTF-8.`, { cause: error }); }
  try { return JSON.parse(text) as unknown; }
  catch (error) { throw new TypeError(`${label} must be valid JSON.`, { cause: error }); }
}

export function parseRepositoryRootValue(value: unknown): RepositoryRootManifest {
  const input = record(value, "repository manifest");
  exact(input, ["contests", "problems", "schema"], "repository manifest");
  if (input.schema !== REPOSITORY_SCHEMA) throw new TypeError(`Repository schema must be '${REPOSITORY_SCHEMA}'.`);
  const problems = repositoryPath(input.problems, "repository manifest problems");
  const contests = repositoryPath(input.contests, "repository manifest contests");
  if (problems === contests || problems === REPOSITORY_ROOT_PATH || contests === REPOSITORY_ROOT_PATH) {
    throw new TypeError("Repository manifest paths must be distinct from each other and the root manifest.");
  }
  return { schema: REPOSITORY_SCHEMA, problems, contests };
}

export function parseRepositoryRoot(bytes: Uint8Array): RepositoryRootManifest {
  return parseRepositoryRootValue(parseJsonBytes(bytes, "repository manifest"));
}

export function parseRepositoryProblemsValue(value: unknown): RepositoryProblemsManifest {
  const input = record(value, "problems manifest");
  exact(input, ["problems", "schema"], "problems manifest");
  if (input.schema !== PROBLEMS_SCHEMA) throw new TypeError(`Problems schema must be '${PROBLEMS_SCHEMA}'.`);
  if (!Array.isArray(input.problems) || input.problems.length < 1 || input.problems.length > 1_000) {
    throw new TypeError("Problems manifest must contain between 1 and 1000 problems.");
  }
  const slugs = new Set<string>();
  const orders = new Set<number>();
  const paths = new Set<string>();
  const problems = input.problems.map((candidate, index): RepositoryProblem => {
    const problem = record(candidate, `problem ${index + 1}`);
    exact(problem, ["contestBundle", "judgePackage", "order", "practiceBundle", "practiceEnabled", "slug", "summary", "title"], `problem ${index + 1}`);
    const problemSlug = slug(problem.slug, `problem ${index + 1}.slug`);
    if (slugs.has(problemSlug)) throw new TypeError(`Problem slug '${problemSlug}' is duplicated.`);
    if (!Number.isSafeInteger(problem.order) || (problem.order as number) < 1 || (problem.order as number) > 1_000 || orders.has(problem.order as number)) {
      throw new TypeError(`Problem '${problemSlug}' order is invalid or duplicated.`);
    }
    if (typeof problem.practiceEnabled !== "boolean") throw new TypeError(`Problem '${problemSlug}' practiceEnabled must be boolean.`);
    const practiceBundle = descriptor(problem.practiceBundle, `problem '${problemSlug}' practiceBundle`, MAX_PUBLIC_BUNDLE_BYTES);
    const contestBundle = descriptor(problem.contestBundle, `problem '${problemSlug}' contestBundle`, MAX_PUBLIC_BUNDLE_BYTES);
    const judgePackage = descriptor(problem.judgePackage, `problem '${problemSlug}' judgePackage`, MAX_JUDGE_PACKAGE_BYTES);
    for (const object of [practiceBundle, contestBundle, judgePackage]) {
      if (paths.has(object.path)) throw new TypeError(`Repository object path '${object.path}' is declared more than once.`);
      paths.add(object.path);
    }
    slugs.add(problemSlug);
    orders.add(problem.order as number);
    return {
      slug: problemSlug,
      order: problem.order as number,
      title: localizedText(problem.title, `problem '${problemSlug}' title`, 4_096),
      summary: localizedText(problem.summary, `problem '${problemSlug}' summary`, 16_384),
      practiceEnabled: problem.practiceEnabled,
      practiceBundle,
      contestBundle,
      judgePackage,
    };
  });
  problems.sort((left, right) => left.order - right.order);
  return { schema: PROBLEMS_SCHEMA, problems };
}

export function parseRepositoryProblems(bytes: Uint8Array): RepositoryProblemsManifest {
  return parseRepositoryProblemsValue(parseJsonBytes(bytes, "problems manifest"));
}

export function parseRepositoryContestsValue(value: unknown): RepositoryContestsManifest {
  const input = record(value, "contests manifest");
  exact(input, ["contests", "schema"], "contests manifest");
  if (input.schema !== CONTESTS_SCHEMA) throw new TypeError(`Contests schema must be '${CONTESTS_SCHEMA}'.`);
  if (!Array.isArray(input.contests) || input.contests.length > 1_000) throw new TypeError("Contests manifest may contain at most 1000 contests.");
  const slugs = new Set<string>();
  const contests = input.contests.map((candidate, index): RepositoryContest => {
    const contest = record(candidate, `contest ${index + 1}`);
    exact(contest, ["accessMode", "description", "rules", "slug", "status", "title"], `contest ${index + 1}`);
    const contestSlug = slug(contest.slug, `contest ${index + 1}.slug`);
    if (slugs.has(contestSlug)) throw new TypeError(`Contest slug '${contestSlug}' is duplicated.`);
    if (contest.status !== "draft" && contest.status !== "published" && contest.status !== "archived") throw new TypeError(`Contest '${contestSlug}' status is invalid.`);
    if (contest.accessMode !== "public" && contest.accessMode !== "invite") throw new TypeError(`Contest '${contestSlug}' accessMode is invalid.`);
    const rules = parseContestRules(contest.rules, `contest '${contestSlug}' rules`);
    slugs.add(contestSlug);
    return {
      slug: contestSlug,
      status: contest.status,
      title: boundedText(contest.title, `contest '${contestSlug}' title`, 4_096),
      description: boundedText(contest.description, `contest '${contestSlug}' description`, 65_536),
      accessMode: contest.accessMode,
      rules,
    };
  });
  return { schema: CONTESTS_SCHEMA, contests };
}

export function parseRepositoryContests(bytes: Uint8Array): RepositoryContestsManifest {
  return parseRepositoryContestsValue(parseJsonBytes(bytes, "contests manifest"));
}

export function validateRepositoryCatalog(
  root: RepositoryRootManifest,
  problems: RepositoryProblemsManifest,
  contests: RepositoryContestsManifest,
): RepositoryCatalog {
  const problemSlugs = new Set(problems.problems.map((problem) => problem.slug));
  for (const contest of contests.contests) {
    for (const problem of contest.rules.problems) {
      if (!problemSlugs.has(problem.slug)) throw new TypeError(`Contest '${contest.slug}' references unknown problem '${problem.slug}'.`);
    }
  }
  return { root, problems, contests };
}
