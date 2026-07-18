import { FORGE_CONTRACT_VERSION } from "../core/contract";
import { assertValidBuildArtifact } from "../core/artifact-validation";
import { resolveDeterminism } from "../core/determinism";
import { resolveResourcePolicy } from "../core/resources";
import type { BuildArtifact, DeterminismConfig, ResourcePolicy } from "../core/types";
import type { OutputNormalization } from "./normalization";

export type JudgeInputSpec =
  | { kind: "inline"; value: string }
  | { kind: "provider"; provider: string; key: string; sha256?: string };

/** Serializable matcher descriptor. Libraries may register additional matcher IDs. */
export interface JudgeMatcherSpec {
  id: string;
  config: Readonly<Record<string, unknown>>;
}

export interface JudgeProgramSpec {
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  resources?: Partial<ResourcePolicy>;
}

interface JudgeCaseBase {
  id: string;
  input: JudgeInputSpec;
  /** Additional secret inputs resolved with the same provider contract as stdin. */
  files?: Readonly<Record<string, JudgeInputSpec>>;
  determinism?: Partial<DeterminismConfig>;
}

export interface BatchJudgeCaseSpec extends JudgeCaseBase, JudgeProgramSpec {
  kind: "batch";
  /** Guest files collected for file-output matchers and custom checkers. */
  outputPaths?: readonly string[];
  matcher: JudgeMatcherSpec;
}

export interface InteractiveJudgeCaseSpec extends JudgeCaseBase {
  kind: "interactive";
  /** Contestant execution policy. Secret case files are never mounted here. */
  contestant?: JudgeProgramSpec;
  interactor: JudgeProgramSpec & {
    artifact: BuildArtifact;
    /** Absolute guest path receiving the resolved primary case input. */
    inputPath: string;
  };
}

export type JudgeCaseSpec = BatchJudgeCaseSpec | InteractiveJudgeCaseSpec;

export interface JudgeSpec {
  version: typeof FORGE_CONTRACT_VERSION;
  cases: readonly JudgeCaseSpec[];
  /** Stop after the first non-accepted case. Defaults to true. */
  failFast?: boolean;
}

export function textMatcher(
  expected: string,
  normalization: OutputNormalization = "lines",
): JudgeMatcherSpec {
  return { id: "text", config: { expected, normalization } };
}

export function sha256Matcher(
  digest: string,
  normalization: OutputNormalization = "trimmed-lines",
): JudgeMatcherSpec {
  return { id: "sha256", config: { digest: digest.toLowerCase(), normalization } };
}

export function fileMatcher(
  expected: Readonly<Record<string, string>>,
  normalization: OutputNormalization = "lines",
): JudgeMatcherSpec {
  return { id: "files", config: { expected: { ...expected }, normalization } };
}

export function tokenMatcher(expected: string): JudgeMatcherSpec {
  return { id: "tokens", config: { expected } };
}

export function floatMatcher(
  expected: string,
  absoluteTolerance = 1e-6,
  relativeTolerance = 1e-6,
): JudgeMatcherSpec {
  assertTolerance(absoluteTolerance, "absolute");
  assertTolerance(relativeTolerance, "relative");
  return { id: "float", config: { expected, absoluteTolerance, relativeTolerance } };
}

export function setMatcher(expected: string, multiplicity = false): JudgeMatcherSpec {
  return { id: "set", config: { expected, multiplicity } };
}

export function wasmCheckerMatcher(
  checker: BuildArtifact,
  expected: string,
  args: readonly string[] = [],
): JudgeMatcherSpec {
  return { id: "wasm-checker", config: { checker, expected, args: [...args] } };
}

function assertTolerance(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`Float matcher ${label} tolerance must be finite and non-negative.`);
  }
}

export function validateJudgeSpec(spec: JudgeSpec): void {
  if (!spec || typeof spec !== "object") throw new TypeError("Judge spec must be an object.");
  if (spec.version !== FORGE_CONTRACT_VERSION) {
    throw new Error(`Unsupported judge spec version '${String(spec.version)}'.`);
  }
  if (!Array.isArray(spec.cases)) throw new TypeError("Judge spec cases must be an array.");
  if (spec.cases.length === 0) throw new Error("A judge spec must contain at least one case.");
  if (spec.failFast !== undefined && typeof spec.failFast !== "boolean") {
    throw new TypeError("Judge spec failFast must be a boolean.");
  }
  const ids = new Set<string>();
  for (const [index, item] of spec.cases.entries()) {
    if (!item || typeof item !== "object") throw new TypeError(`Judge case ${index} must be an object.`);
    assertJudgeIdentifier(item.id, `Judge case ${index} ID`);
    if (ids.has(item.id)) throw new Error(`Duplicate judge case ID '${item.id}'.`);
    ids.add(item.id);
    if (item.kind !== "batch" && item.kind !== "interactive") {
      throw new Error(`Judge case '${item.id}' kind must be 'batch' or 'interactive'.`);
    }
    if (item.kind === "batch") {
      if (!item.matcher || typeof item.matcher !== "object") {
        throw new TypeError(`Judge case '${item.id}' matcher must be an object.`);
      }
      assertJudgeIdentifier(item.matcher.id, `Judge case '${item.id}' matcher ID`);
      if (!item.matcher.config || typeof item.matcher.config !== "object" || Array.isArray(item.matcher.config)) {
        throw new TypeError(`Judge case '${item.id}' matcher config must be a record.`);
      }
      validateProgramSpec(item, item.id, "batch program");
      validateOutputPaths(item.outputPaths, item.id);
    } else {
      validateInteractiveCase(item);
    }
    if (!item.input || typeof item.input !== "object") {
      throw new TypeError(`Judge case '${item.id}' input must be an object.`);
    }
    if (item.files !== undefined) {
      if (!item.files || typeof item.files !== "object" || Array.isArray(item.files)) {
        throw new TypeError(`Judge case '${item.id}' files must be a record.`);
      }
      if (Object.keys(item.files).length > 256) throw new Error(`Judge case '${item.id}' has too many input files.`);
      for (const [path, input] of Object.entries(item.files as Readonly<Record<string, JudgeInputSpec>>)) {
        assertGuestFilePath(path, `Judge case '${item.id}' input file path`);
        validateInputSpec(input, `Judge case '${item.id}' input file '${path}'`);
      }
    }
    if (item.input.kind === "inline") {
      if (typeof item.input.value !== "string") {
        throw new TypeError(`Judge case '${item.id}' inline input must be a string.`);
      }
    } else if (item.input.kind === "provider") {
      assertJudgeIdentifier(item.input.provider, `Judge case '${item.id}' input provider`);
      assertCanonicalString(item.input.key, `Judge case '${item.id}' input key`, 4_096);
      if (item.input.sha256 !== undefined && (
        typeof item.input.sha256 !== "string"
        || !/^[0-9a-f]{64}$/.test(item.input.sha256)
      )) {
        throw new Error(`Judge case '${item.id}' input SHA-256 digest must be lowercase hexadecimal.`);
      }
    } else {
      throw new Error(`Judge case '${item.id}' has unsupported input kind '${String((item.input as { kind?: unknown }).kind)}'.`);
    }
    if (item.determinism !== undefined && (!item.determinism || typeof item.determinism !== "object" || Array.isArray(item.determinism))) {
      throw new TypeError(`Judge case '${item.id}' determinism must be a record.`);
    }
    resolveDeterminism(item.determinism);
  }
}

function validateInteractiveCase(item: InteractiveJudgeCaseSpec): void {
  if (item.contestant !== undefined) validateProgramSpec(item.contestant, item.id, "contestant");
  if (!item.interactor || typeof item.interactor !== "object" || Array.isArray(item.interactor)) {
    throw new TypeError(`Judge case '${item.id}' interactor must be an object.`);
  }
  validateProgramSpec(item.interactor, item.id, "interactor");
  assertGuestFilePath(item.interactor.inputPath, `Judge case '${item.id}' interactor inputPath`);
  if (!item.interactor.artifact || typeof item.interactor.artifact !== "object") {
    throw new TypeError(`Judge case '${item.id}' interactor artifact must be a build artifact.`);
  }
  if (item.interactor.artifact.kind !== "wasm") {
    throw new Error(`Judge case '${item.id}' interactor must be a standalone Wasm artifact.`);
  }
  assertValidBuildArtifact(item.interactor.artifact);
}

function validateProgramSpec(value: JudgeProgramSpec, caseId: string, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Judge case '${caseId}' ${label} must be an object.`);
  }
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((argument: unknown) => typeof argument !== "string"))) {
    throw new TypeError(`Judge case '${caseId}' ${label} args must be an array of strings.`);
  }
  if (value.env !== undefined) validateEnvironment(value.env, `Judge case '${caseId}' ${label} environment`);
  if (value.cwd !== undefined) assertGuestDirectoryPath(value.cwd, `Judge case '${caseId}' ${label} cwd`);
  if (value.resources !== undefined && (!value.resources || typeof value.resources !== "object" || Array.isArray(value.resources))) {
    throw new TypeError(`Judge case '${caseId}' ${label} resources must be a record.`);
  }
  resolveResourcePolicy(value.resources);
}

function validateOutputPaths(outputPaths: readonly string[] | undefined, caseId: string): void {
  if (outputPaths === undefined) return;
  if (!Array.isArray(outputPaths) || outputPaths.length > 256) {
    throw new TypeError(`Judge case '${caseId}' outputPaths must be an array of at most 256 paths.`);
  }
  const paths = (outputPaths as readonly unknown[])
    .map((path: unknown) => assertGuestFilePath(path, `Judge case '${caseId}' output path`))
    .sort();
  if (paths.some((path, index) => index > 0 && paths[index - 1] === path)) {
    throw new Error(`Judge case '${caseId}' output paths must be unique.`);
  }
}

function validateInputSpec(input: JudgeInputSpec, label: string): void {
  if (!input || typeof input !== "object") throw new TypeError(`${label} must be an object.`);
  if (input.kind === "inline") {
    if (typeof input.value !== "string") throw new TypeError(`${label} inline value must be a string.`);
    return;
  }
  if (input.kind !== "provider") throw new Error(`${label} has an unsupported input kind.`);
  assertJudgeIdentifier(input.provider, `${label} provider`);
  assertCanonicalString(input.key, `${label} key`, 4_096);
  if (input.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new Error(`${label} SHA-256 digest must be lowercase hexadecimal.`);
  }
}

function assertGuestFilePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "/" || !isNormalizedGuestPath(value)) {
    throw new Error(`${label} must be an absolute normalized file path.`);
  }
  return value;
}

function assertGuestDirectoryPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isNormalizedGuestPath(value)) {
    throw new Error(`${label} must be an absolute normalized path.`);
  }
  return value;
}

function isNormalizedGuestPath(path: string): boolean {
  return path.startsWith("/") && path.length <= 4_096 && !path.includes("\\") && !path.includes("\0")
    && (path === "/" || (!path.endsWith("/") && !path.includes("//")))
    && !path.split("/").some((part) => part === "." || part === "..");
}

function assertJudgeIdentifier(value: unknown, label: string): asserts value is string {
  assertCanonicalString(value, label, 128);
}

function assertCanonicalString(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty, trimmed string of at most ${maximum} characters.`);
  }
}

function validateEnvironment(value: unknown, caseLabel: string): asserts value is Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Judge case '${caseLabel}' env must be a record.`);
  }
  for (const [name, contents] of Object.entries(value)) {
    if (!name || name.includes("=") || name.includes("\0")) {
      throw new Error(`Judge case '${caseLabel}' has invalid environment variable name '${name}'.`);
    }
    if (typeof contents !== "string" || contents.includes("\0")) {
      throw new Error(`Judge case '${caseLabel}' environment variable '${name}' must be a NUL-free string.`);
    }
  }
}
