import { canonicalJsonBytes } from "../src/core/canonical-json";
import type { ForgeValidationSource, VerifiedValidationSource } from "../src/online-judge/validation-source";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// Formal publication is one atomic D1 snapshot transaction. Keep the managed
// inventory below D1 batch and Worker subrequest limits; browser-only public
// collections retain the wider repository contract.
const MAX_PROBLEMS = 64;
const MAX_CANONICAL_OBJECTS = 132_000;
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;

export type ValidationObjectReference = {
  readonly key: string;
  readonly digest: string;
  readonly bytes: number;
};

/**
 * The complete durable Validation Workflow reference. Cloudflare persists this
 * value in both Workflow metadata and our delivery outbox, so it deliberately
 * contains no Organizer identity, repository metadata, GitHub installation,
 * commit/index coordinates, or R2 object key. Those values are hydrated from
 * DB inside bounded Workflow steps immediately before use.
 */
export interface ValidationWorkflowParameters {
  readonly importId: string;
  readonly expectedReleaseId: string;
  readonly expectedManifestSha256: string;
  readonly expectedContainerIdentitySha256: string;
}

export interface ValidationProblemOutput {
  readonly id: string;
  readonly number: number;
  readonly title: { readonly "zh-TW": string; readonly en: string };
  readonly difficulty: "easy" | "medium" | "hard";
  readonly tags: readonly string[];
  readonly trackId: string;
  readonly track: { readonly "zh-TW": string; readonly en: string };
  readonly bundleDigest: string;
  readonly allowedProfiles: Readonly<Record<string, { readonly target: "wasip1" | "wasix"; readonly optimization: "debug" | "release" }>>;
  readonly practice: ValidationObjectReference;
  readonly contestPublic: ValidationObjectReference;
  readonly judge: ValidationObjectReference;
}

export interface ValidationCore {
  readonly importId: string;
  readonly sourceKind: "github-archive";
  readonly forgeReleaseId: string;
  readonly collectionRevision: string;
  readonly canonicalSource: {
    readonly manifest: ValidationObjectReference;
    readonly objects: readonly ValidationObjectReference[];
  };
  readonly projections: {
    readonly practice: ValidationObjectReference;
    readonly contestPublic: ValidationObjectReference;
    readonly judge: ValidationObjectReference;
  };
  readonly outputs: readonly ValidationProblemOutput[];
}

export type ValidationWorkflowResult = ValidationCore & {
  readonly schema: "forge-validation-workflow-result-v1";
  readonly report: ValidationObjectReference;
};

export type ValidationReport = ValidationCore & {
  readonly schema: "forge-collection-validation-report-v1";
  readonly problemCount: number;
  readonly checks: readonly string[];
};

export interface ValidationExpectation {
  readonly importId: string;
  readonly forgeReleaseId: string;
}

export function trustedGithubArchiveRedirect(value: string | null): string {
  if (!value) throw new TypeError("GitHub archive response has no redirect location.");
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || (url.port !== "" && url.port !== "443")
    || !(url.hostname === "github.com" || url.hostname === "codeload.github.com" || url.hostname.endsWith(".githubusercontent.com"))
  ) throw new TypeError("GitHub archive redirect target is not trusted.");
  return url.toString();
}

export function githubRepositoryCoordinates(
  value: unknown,
  repositoryId: number,
  expectedOwner: string,
  expectedRepository: string,
): { readonly owner: string; readonly repository: string } {
  const repository = object(value, "GitHub numeric repository response");
  const owner = object(repository.owner, "GitHub numeric repository owner");
  if (repository.id !== repositoryId || typeof owner.login !== "string" || typeof repository.name !== "string") {
    throw new TypeError("GitHub repository numeric identity is inconsistent.");
  }
  if (owner.login.toLowerCase() !== expectedOwner.toLowerCase() || repository.name.toLowerCase() !== expectedRepository.toLowerCase()) {
    throw new TypeError("GitHub repository coordinates changed.");
  }
  return { owner: safeText(owner.login, "GitHub repository owner", 100), repository: safeText(repository.name, "GitHub repository name", 100) };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, required: readonly string[], label: string): void {
  if (Object.keys(value).length !== required.length || required.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function string(value: unknown, pattern: RegExp, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function safeText(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function repositoryObjectKey(digest: string, label: string, value: unknown): string {
  const expected = `snapshots/objects/${digest}`;
  if (value !== expected) throw new TypeError(`${label} is not the expected content address.`);
  return expected;
}

function reference(value: unknown, label: string): ValidationObjectReference {
  const item = object(value, label);
  exact(item, ["bytes", "digest", "key"], label);
  const digest = string(item.digest, DIGEST, `${label}.digest`, 64);
  if (!Number.isSafeInteger(item.bytes) || (item.bytes as number) < 1 || (item.bytes as number) > MAX_OBJECT_BYTES) {
    throw new TypeError(`${label}.bytes is invalid.`);
  }
  return {
    key: repositoryObjectKey(digest, `${label}.key`, item.key),
    digest,
    bytes: item.bytes as number,
  };
}

function equalReference(left: ValidationObjectReference, right: ValidationObjectReference): boolean {
  return left.key === right.key && left.digest === right.digest && left.bytes === right.bytes;
}

function profiles(value: unknown, label: string): ValidationProblemOutput["allowedProfiles"] {
  const candidate = object(value, label);
  const entries = Object.entries(candidate);
  if (entries.length < 1 || entries.length > 16) throw new TypeError(`${label} is empty or oversized.`);
  const result: Record<string, { target: "wasip1" | "wasix"; optimization: "debug" | "release" }> = {};
  for (const [language, raw] of entries) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(language)) throw new TypeError(`${label} has an invalid language.`);
    const profile = object(raw, `${label}.${language}`);
    exact(profile, ["optimization", "target"], `${label}.${language}`);
    if ((profile.target !== "wasip1" && profile.target !== "wasix") || (profile.optimization !== "debug" && profile.optimization !== "release")) {
      throw new TypeError(`${label}.${language} is invalid.`);
    }
    result[language] = { target: profile.target, optimization: profile.optimization };
  }
  return result;
}

function problemOutput(value: unknown, index: number): ValidationProblemOutput {
  const label = `validation output ${index}`;
  const output = object(value, label);
  exact(output, ["allowedProfiles", "bundleDigest", "contestPublic", "difficulty", "id", "judge", "number", "practice", "tags", "title", "track", "trackId"], label);
  const title = object(output.title, `${label}.title`);
  exact(title, ["en", "zh-TW"], `${label}.title`);
  const track = object(output.track, `${label}.track`);
  exact(track, ["en", "zh-TW"], `${label}.track`);
  if (output.difficulty !== "easy" && output.difficulty !== "medium" && output.difficulty !== "hard") throw new TypeError(`${label}.difficulty is invalid.`);
  if (!Array.isArray(output.tags) || output.tags.length > 16 || output.tags.some((tag) => typeof tag !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(tag))) {
    throw new TypeError(`${label}.tags is invalid.`);
  }
  if (!Number.isSafeInteger(output.number) || (output.number as number) < 1 || (output.number as number) > MAX_PROBLEMS) {
    throw new TypeError(`${label}.number is invalid.`);
  }
  return {
    id: string(output.id, SLUG, `${label}.id`, 80),
    number: output.number as number,
    title: {
      "zh-TW": safeText(title["zh-TW"], `${label}.title.zh-TW`, 256),
      en: safeText(title.en, `${label}.title.en`, 256),
    },
    difficulty: output.difficulty,
    tags: output.tags as string[],
    trackId: string(output.trackId, SLUG, `${label}.trackId`, 80),
    track: {
      "zh-TW": safeText(track["zh-TW"], `${label}.track.zh-TW`, 256),
      en: safeText(track.en, `${label}.track.en`, 256),
    },
    bundleDigest: string(output.bundleDigest, DIGEST, `${label}.bundleDigest`, 64),
    allowedProfiles: profiles(output.allowedProfiles, `${label}.allowedProfiles`),
    practice: reference(output.practice, `${label}.practice`),
    contestPublic: reference(output.contestPublic, `${label}.contestPublic`),
    judge: reference(output.judge, `${label}.judge`),
  };
}

function core(
  value: Record<string, unknown>,
  expectation: ValidationExpectation,
  schema: "forge-validation-workflow-result-v1" | "forge-collection-validation-report-v1",
): ValidationCore {
  if (value.schema !== schema || value.importId !== expectation.importId || value.sourceKind !== "github-archive" || value.forgeReleaseId !== expectation.forgeReleaseId) {
    throw new TypeError("Validation result identity does not match the immutable workflow.");
  }
  const collectionRevision = string(value.collectionRevision, DIGEST, "validation collectionRevision", 64);
  const canonical = object(value.canonicalSource, "validation canonicalSource");
  exact(canonical, ["manifest", "objects"], "validation canonicalSource");
  const manifest = reference(canonical.manifest, "validation canonical source manifest");
  if (!Array.isArray(canonical.objects) || canonical.objects.length < 1 || canonical.objects.length > MAX_CANONICAL_OBJECTS) {
    throw new TypeError("Validation canonical object inventory is invalid.");
  }
  const objects = canonical.objects.map((item, index) => reference(item, `validation canonical object ${index}`));
  const objectKeys = new Set(objects.map((item) => item.key));
  if (objectKeys.size !== objects.length || objectKeys.has(manifest.key)) throw new TypeError("Validation canonical object inventory repeats an object.");
  const projectionObject = object(value.projections, "validation projections");
  exact(projectionObject, ["contestPublic", "judge", "practice"], "validation projections");
  const projections = {
    practice: reference(projectionObject.practice, "validation practice collection projection"),
    contestPublic: reference(projectionObject.contestPublic, "validation contest public collection projection"),
    judge: reference(projectionObject.judge, "validation judge collection projection"),
  };
  if (new Set(Object.values(projections).map((item) => item.key)).size !== 3) throw new TypeError("Validation collection projection roles are not distinct.");
  if (!Array.isArray(value.outputs) || value.outputs.length < 1 || value.outputs.length > MAX_PROBLEMS) throw new TypeError("Validation outputs are invalid.");
  const outputs = value.outputs.map(problemOutput);
  if (new Set(outputs.map((item) => item.id)).size !== outputs.length || new Set(outputs.map((item) => item.number)).size !== outputs.length) {
    throw new TypeError("Validation output identities are not unique.");
  }
  for (const output of outputs) {
    if (new Set([output.practice.key, output.contestPublic.key, output.judge.key]).size !== 3) {
      throw new TypeError(`Validation output '${output.id}' projection roles are not distinct.`);
    }
  }
  return {
    importId: expectation.importId,
    sourceKind: "github-archive",
    forgeReleaseId: expectation.forgeReleaseId,
    collectionRevision,
    canonicalSource: { manifest, objects },
    projections,
    outputs,
  };
}

export function parseValidationWorkflowParameters(value: unknown): ValidationWorkflowParameters {
  const input = object(value, "validation workflow parameters");
  exact(input, ["expectedContainerIdentitySha256", "expectedManifestSha256", "expectedReleaseId", "importId"], "validation workflow parameters");
  return {
    importId: string(input.importId, UUID, "validation importId", 36),
    expectedReleaseId: string(input.expectedReleaseId, UUID, "validation expectedReleaseId", 36),
    expectedManifestSha256: string(input.expectedManifestSha256, DIGEST, "validation expectedManifestSha256", 64),
    expectedContainerIdentitySha256: string(input.expectedContainerIdentitySha256, DIGEST, "validation expectedContainerIdentitySha256", 64),
  };
}

export function parseAttemptToken(value: unknown): string {
  return string(value, TOKEN, "container attemptToken", 43);
}

export function parseValidationWorkflowResult(value: unknown, expectation: ValidationExpectation): ValidationWorkflowResult {
  const result = object(value, "validation workflow result");
  exact(result, ["canonicalSource", "collectionRevision", "forgeReleaseId", "importId", "outputs", "projections", "report", "schema", "sourceKind"], "validation workflow result");
  const parsed = core(result, expectation, "forge-validation-workflow-result-v1");
  return { ...parsed, schema: "forge-validation-workflow-result-v1", report: reference(result.report, "validation report") };
}

export function parseValidationReport(value: unknown, expectation: ValidationExpectation): ValidationReport {
  const report = object(value, "validation report");
  exact(report, ["canonicalSource", "checks", "collectionRevision", "forgeReleaseId", "importId", "outputs", "problemCount", "projections", "schema", "sourceKind"], "validation report");
  const parsed = core(report, expectation, "forge-collection-validation-report-v1");
  if (report.problemCount !== parsed.outputs.length) throw new TypeError("Validation report problem count is inconsistent.");
  if (!Array.isArray(report.checks) || report.checks.length < 1 || report.checks.length > 32 || report.checks.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(item)) || new Set(report.checks).size !== report.checks.length) {
    throw new TypeError("Validation report checks are invalid.");
  }
  return { ...parsed, schema: "forge-collection-validation-report-v1", problemCount: parsed.outputs.length, checks: [...report.checks] as string[] };
}

function sameJson(left: unknown, right: unknown): boolean {
  const leftBytes = canonicalJsonBytes(left);
  const rightBytes = canonicalJsonBytes(right);
  return leftBytes.byteLength === rightBytes.byteLength && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function projection(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const result = object(value, label);
  exact(result, keys, label);
  return result;
}

function assertReference(value: unknown, expected: ValidationObjectReference, label: string): void {
  const parsed = reference(value, label);
  if (!equalReference(parsed, expected)) throw new TypeError(`${label} does not match the validation report.`);
}

/**
 * Bind every published projection to its semantic role and canonical source.
 * This is intentionally stricter than integrity hashing: a valid hidden judge
 * object can never stand in for a contest-public object merely because its hash
 * is valid.
 */
export function verifyManagedProjectionBindings(
  report: ValidationReport,
  source: ForgeValidationSource,
  verified: VerifiedValidationSource,
  valuesByKey: ReadonlyMap<string, unknown>,
): void {
  if (source.collectionRevision !== report.collectionRevision || verified.index.revision !== report.collectionRevision) {
    throw new TypeError("Published projection revision does not match canonical source.");
  }
  if (report.outputs.length !== verified.index.problems.length || report.outputs.length !== verified.problems.length) {
    throw new TypeError("Published projection inventory does not match canonical source.");
  }
  const expectedKeys = new Set<string>();
  const requireValue = (referenceValue: ValidationObjectReference, label: string): unknown => {
    expectedKeys.add(referenceValue.key);
    if (!valuesByKey.has(referenceValue.key)) throw new TypeError(`${label} bytes are missing.`);
    return valuesByKey.get(referenceValue.key);
  };
  for (const [index, output] of report.outputs.entries()) {
    const entry = verified.index.problems[index];
    const problemEntry = verified.problems[index];
    const managed = verified.managed.problems[index];
    if (!entry || !problemEntry || !managed || output.id !== entry.id || output.number !== entry.number || !sameJson(output.title, entry.title) || output.bundleDigest !== entry.bundle.sha256) {
      throw new TypeError("Published problem metadata does not match canonical source.");
    }
    const languages = Object.keys(output.allowedProfiles).sort();
    if (!sameJson(languages, [...managed.allowedLanguages].sort())) throw new TypeError(`Published problem '${output.id}' profiles do not match its managed contract.`);
    const expectedProblem = problemEntry.problem;
    const practice = projection(requireValue(output.practice, `practice problem '${output.id}'`), ["digest", "problem", "schema"], `practice problem '${output.id}'`);
    if (practice.schema !== "forge-practice-problem-projection-v1" || practice.digest !== output.bundleDigest || !sameJson(practice.problem, expectedProblem)) {
      throw new TypeError(`Practice projection '${output.id}' is not bound to its canonical problem.`);
    }
    const expectedContestProblem = {
      ...expectedProblem,
      editorial: { "zh-TW": "", en: "" },
      judgeCases: expectedProblem.judgeCases.filter((item) => item.kind === "sample"),
    };
    const contest = projection(requireValue(output.contestPublic, `contest public problem '${output.id}'`), ["digest", "problem", "schema"], `contest public problem '${output.id}'`);
    if (contest.schema !== "forge-contest-public-problem-projection-v1" || contest.digest !== output.bundleDigest || !sameJson(contest.problem, expectedContestProblem)) {
      throw new TypeError(`Contest-public projection '${output.id}' contains bytes outside its public role.`);
    }
    const judge = projection(requireValue(output.judge, `server judge problem '${output.id}'`), ["allowedProfiles", "digest", "forgeReleaseId", "judge", "problem", "schema"], `server judge problem '${output.id}'`);
    if (judge.schema !== "forge-server-judge-projection-v1" || judge.forgeReleaseId !== report.forgeReleaseId || judge.digest !== output.bundleDigest || !sameJson(judge.problem, expectedProblem) || !sameJson(judge.allowedProfiles, output.allowedProfiles) || !judge.judge || typeof judge.judge !== "object") {
      throw new TypeError(`Server-judge projection '${output.id}' is not bound to its release and canonical problem.`);
    }
  }
  const collectionRoles = [
    [report.projections.practice, "forge-practice-collection-projection-v1", "practice"] as const,
    [report.projections.contestPublic, "forge-contest-public-collection-projection-v1", "contestPublic"] as const,
    [report.projections.judge, "forge-server-judge-collection-projection-v1", "judge"] as const,
  ];
  for (const [referenceValue, schema, role] of collectionRoles) {
    const keys = role === "judge" ? ["collectionRevision", "forgeReleaseId", "problems", "schema"] : ["collectionRevision", "problems", "schema"];
    const collection = projection(requireValue(referenceValue, `${role} collection`), keys, `${role} collection`);
    if (collection.schema !== schema || collection.collectionRevision !== report.collectionRevision || (role === "judge" && collection.forgeReleaseId !== report.forgeReleaseId) || !Array.isArray(collection.problems) || collection.problems.length !== report.outputs.length) {
      throw new TypeError(`${role} collection projection is not bound to its role.`);
    }
    for (const [index, itemValue] of collection.problems.entries()) {
      const item = object(itemValue, `${role} collection problem ${index}`);
      exact(item, ["id", "projection"], `${role} collection problem ${index}`);
      const output = report.outputs[index];
      if (!output || item.id !== output.id) throw new TypeError(`${role} collection inventory is inconsistent.`);
      assertReference(item.projection, output[role], `${role} collection problem ${index}`);
    }
  }
  if (valuesByKey.size !== expectedKeys.size || [...valuesByKey.keys()].some((key) => !expectedKeys.has(key))) {
    throw new TypeError("Published projection set contains an undeclared object.");
  }
}
