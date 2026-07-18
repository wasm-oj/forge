import { resolveDeterminism } from "./determinism.ts";
import { canonicalProjectFiles } from "./project-files.ts";
import { resolveResourcePolicy } from "./resources.ts";
import { TOOLCHAINS } from "./toolchains.ts";
import {
  assertLanguageIdentifier,
  isBuiltinLanguage,
  type DeterminismConfig,
  type Project,
  type ProjectConfig,
  type ProjectFile,
  type ResourcePolicy,
} from "./types.ts";

const PROJECT_KEYS = Object.freeze(["id", "name", "files", "config", "activeFile", "updatedAt"] as const);
const PROJECT_FILE_KEYS = Object.freeze(["path", "language", "content"] as const);
const PROJECT_CONFIG_KEYS = Object.freeze([
  "language",
  "target",
  "optimization",
  "entry",
  "args",
  "stdin",
  "env",
  "determinism",
  "resources",
] as const);
const DETERMINISM_KEYS = Object.freeze(["randomSeed", "realtimeEpochMs", "clockStepNs"] as const);
const RESOURCE_KEYS = Object.freeze([
  "instructionBudget",
  "logicalTimeLimitMs",
  "memoryLimitBytes",
  "outputLimitBytes",
  "filesystemWriteLimitBytes",
  "filesystemEntryLimit",
  "wallTimeLimitMs",
] as const);

function plainDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${label} cannot contain symbol properties.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be an enumerable data property.`);
    }
  }
  return value as Record<string, unknown>;
}

function exactDataRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const record = plainDataRecord(value, label);
  const actualKeys = Object.keys(record);
  if (
    actualKeys.length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error(`${label} must contain exactly: ${expectedKeys.join(", ")}.`);
  }
  return record;
}

function denseDataArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a plain array.`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== value.length
    || keys.some((key, index) => key !== String(index))
    || Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw new Error(`${label} must be a dense array without custom properties.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}[${key}] must be an enumerable data property.`);
    }
  }
  return value;
}

function requiredTrimmedString(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty, trimmed string of at most ${maximum} characters.`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  const values = denseDataArray(value, label);
  if (values.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must contain only strings.`);
  }
}

function assertEnvironment(value: unknown): asserts value is Record<string, string> {
  const environment = plainDataRecord(value, "Project environment");
  for (const [name, entry] of Object.entries(environment)) {
    if (!name || name.includes("=") || name.includes("\0")) {
      throw new Error(`Project environment variable name '${name}' is invalid.`);
    }
    if (typeof entry !== "string" || entry.includes("\0")) {
      throw new Error(`Project environment variable '${name}' must be a NUL-free string.`);
    }
  }
}

function assertProjectFiles(value: unknown): asserts value is ProjectFile[] {
  const files = denseDataArray(value, "Project files");
  for (const [index, file] of files.entries()) {
    exactDataRecord(file, `Project file ${index}`, PROJECT_FILE_KEYS);
  }
  canonicalProjectFiles(files as ProjectFile[]);
}

function assertDeterminism(value: unknown): asserts value is DeterminismConfig {
  exactDataRecord(value, "Project determinism", DETERMINISM_KEYS);
  resolveDeterminism(value as DeterminismConfig);
}

function assertResources(value: unknown): asserts value is ResourcePolicy {
  exactDataRecord(value, "Project resources", RESOURCE_KEYS);
  resolveResourcePolicy(value as ResourcePolicy);
}

function assertProjectConfig(value: unknown): asserts value is ProjectConfig {
  const config = exactDataRecord(value, "Project config", PROJECT_CONFIG_KEYS);
  assertLanguageIdentifier(config.language);
  if (config.target !== "wasip1" && config.target !== "wasix") {
    throw new Error("Project target must be 'wasip1' or 'wasix'.");
  }
  if (config.optimization !== "debug" && config.optimization !== "release") {
    throw new Error("Project optimization must be 'debug' or 'release'.");
  }
  if (
    isBuiltinLanguage(config.language)
    && !TOOLCHAINS[config.language].targets.includes(config.target)
  ) {
    throw new Error(`Project target '${config.target}' is unsupported for built-in language '${config.language}'.`);
  }
  requiredTrimmedString(config.entry, "Project entry", 4_096);
  assertStringArray(config.args, "Project arguments");
  if (typeof config.stdin !== "string") throw new Error("Project stdin must be a string.");
  assertEnvironment(config.env);
  assertDeterminism(config.determinism);
  assertResources(config.resources);
}

/**
 * Fail-closed validation boundary for projects crossing persistence or
 * transport boundaries. The candidate is checked without mutation, defaults,
 * type coercion, or shape recovery.
 */
export function assertValidProject(candidate: unknown): asserts candidate is Project {
  const project = exactDataRecord(candidate, "Project", PROJECT_KEYS);
  requiredTrimmedString(project.id, "Project id", 16_384);
  requiredTrimmedString(project.name, "Project name", 4_096);
  assertProjectFiles(project.files);
  assertProjectConfig(project.config);
  if (typeof project.activeFile !== "string") throw new Error("Project activeFile must be a string.");
  const paths = new Set(project.files.map((file) => file.path));
  if (!paths.has(project.config.entry)) {
    throw new Error(`Project entry '${project.config.entry}' is not present in files.`);
  }
  if (!paths.has(project.activeFile)) {
    throw new Error(`Project activeFile '${project.activeFile}' is not present in files.`);
  }
  if (typeof project.updatedAt !== "number" || !Number.isFinite(project.updatedAt) || project.updatedAt < 0) {
    throw new Error("Project updatedAt must be a non-negative finite number.");
  }
}
