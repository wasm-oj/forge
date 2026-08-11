import { isBuiltinLanguage, type BuiltinLanguage, type OptimizationLevel, type TargetAbi } from "../core/types";
import { TOOLCHAINS } from "../core/toolchains";
import { SUBMISSION_SOURCE_LIMITS } from "./contracts";

export const MANAGED_COLLECTION_SCHEMA = "forge-managed-collection-v1";

export interface ManagedSourceFile {
  readonly path: string;
  readonly repositoryPath: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ManagedReferenceProgram {
  readonly language: BuiltinLanguage;
  readonly target: TargetAbi;
  readonly optimization: OptimizationLevel;
  readonly entry: string;
  readonly files: readonly ManagedSourceFile[];
}

export interface ManagedRuntimeAsset {
  /** Absolute guest path used only when the trusted judge program runs. */
  readonly path: string;
  readonly repositoryPath: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ManagedJudgeProgram extends ManagedReferenceProgram {
  readonly args: readonly string[];
  readonly assets: readonly ManagedRuntimeAsset[];
}

export type ManagedJudgeContract =
  | { readonly kind: "text" }
  | { readonly kind: "checker"; readonly program: ManagedJudgeProgram }
  | {
    readonly kind: "interactive";
    readonly program: ManagedJudgeProgram;
    /** Secret case stdin is mounted here for the interactor, never the contestant. */
    readonly inputPath: string;
  };

export interface ManagedProblemContract {
  readonly id: string;
  readonly allowedLanguages: readonly BuiltinLanguage[];
  readonly references: readonly ManagedReferenceProgram[];
  readonly judge: ManagedJudgeContract;
}

export interface ManagedCollectionContract {
  readonly schema: typeof MANAGED_COLLECTION_SCHEMA;
  readonly collectionRevision: string;
  readonly problems: readonly ManagedProblemContract[];
}

const PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000]+$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GUEST_PATH = /^\/(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000]+$/;
const TRUSTED_JUDGE_LANGUAGES = new Set<BuiltinLanguage>(["c", "cpp", "go", "rust"]);
const MAX_JUDGE_ASSETS = 256;
const MAX_JUDGE_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_JUDGE_ASSETS_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_JUDGE_ARGUMENTS = 64;
const MAX_JUDGE_ARGUMENT_BYTES = 4_096;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sorted)) throw new TypeError(`${label} must contain exactly: ${sorted.join(", ")}.`);
}

function path(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || !PATH.test(value)) throw new TypeError(`${label} must be a normalized relative POSIX path.`);
  return value;
}

function sourceFile(value: unknown, label: string): ManagedSourceFile {
  const file = record(value, label);
  exact(file, ["path", "repositoryPath", "bytes", "sha256"], label);
  if (!Number.isSafeInteger(file.bytes) || (file.bytes as number) < 1 || (file.bytes as number) > SUBMISSION_SOURCE_LIMITS.fileBytes || typeof file.sha256 !== "string" || !DIGEST.test(file.sha256)) {
    throw new TypeError(`${label} size or digest is invalid.`);
  }
  return {
    path: path(file.path, `${label}.path`),
    repositoryPath: path(file.repositoryPath, `${label}.repositoryPath`),
    bytes: file.bytes as number,
    sha256: file.sha256,
  };
}

function guestPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 2 || value.length > 512 || !GUEST_PATH.test(value)) {
    throw new TypeError(`${label} must be an absolute normalized guest file path.`);
  }
  return value;
}

function runtimeAsset(value: unknown, label: string, namespace: "/checker/assets/" | "/interactor/assets/"): ManagedRuntimeAsset {
  const asset = record(value, label);
  exact(asset, ["path", "repositoryPath", "bytes", "sha256"], label);
  if (!Number.isSafeInteger(asset.bytes) || (asset.bytes as number) < 1 || (asset.bytes as number) > MAX_JUDGE_ASSET_BYTES || typeof asset.sha256 !== "string" || !DIGEST.test(asset.sha256)) {
    throw new TypeError(`${label} size or digest is invalid.`);
  }
  const pathValue = guestPath(asset.path, `${label}.path`);
  if (!pathValue.startsWith(namespace)) throw new TypeError(`${label}.path must be inside '${namespace}'.`);
  return {
    path: pathValue,
    repositoryPath: path(asset.repositoryPath, `${label}.repositoryPath`),
    bytes: asset.bytes as number,
    sha256: asset.sha256,
  };
}

function reference(value: unknown, label: string): ManagedReferenceProgram {
  const program = record(value, label);
  exact(program, ["language", "target", "optimization", "entry", "files"], label);
  if (typeof program.language !== "string" || !isBuiltinLanguage(program.language)) throw new TypeError(`${label}.language is unsupported.`);
  if (program.target !== "wasip1" && program.target !== "wasix") throw new TypeError(`${label}.target is unsupported.`);
  if (program.optimization !== "debug" && program.optimization !== "release") throw new TypeError(`${label}.optimization is unsupported.`);
  if (!Array.isArray(program.files) || program.files.length < 1 || program.files.length > SUBMISSION_SOURCE_LIMITS.maximumFiles) throw new TypeError(`${label}.files has an invalid count.`);
  const files = program.files.map((file, index) => sourceFile(file, `${label}.files[${index}]`));
  const paths = new Set(files.map((file) => file.path));
  const repositoryPaths = new Set(files.map((file) => file.repositoryPath));
  if (paths.size !== files.length || repositoryPaths.size !== files.length) throw new TypeError(`${label} has duplicate source paths.`);
  const entry = path(program.entry, `${label}.entry`);
  if (!paths.has(entry)) throw new TypeError(`${label}.entry must identify one declared source file.`);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > SUBMISSION_SOURCE_LIMITS.totalBytes) throw new TypeError(`${label} source exceeds 1 MiB.`);
  return { language: program.language, target: program.target, optimization: program.optimization, entry, files };
}

function judgeProgram(
  value: unknown,
  label: string,
  namespace: "/checker/assets/" | "/interactor/assets/",
): ManagedJudgeProgram {
  const program = record(value, label);
  exact(program, ["language", "target", "optimization", "entry", "files", "assets", "args"], label);
  const compiled = reference({
    language: program.language,
    target: program.target,
    optimization: program.optimization,
    entry: program.entry,
    files: program.files,
  }, label);
  if (!TRUSTED_JUDGE_LANGUAGES.has(compiled.language) || TOOLCHAINS[compiled.language].artifact !== "wasm") {
    throw new TypeError(`${label}.language must compile to a standalone Wasm module.`);
  }
  if (!TOOLCHAINS[compiled.language].targets.includes(compiled.target)) {
    throw new TypeError(`${label}.target is unsupported by its compiler.`);
  }
  if (!Array.isArray(program.assets) || program.assets.length > MAX_JUDGE_ASSETS) {
    throw new TypeError(`${label}.assets has an invalid count.`);
  }
  const assets = program.assets.map((asset, index) => runtimeAsset(asset, `${label}.assets[${index}]`, namespace));
  if (new Set(assets.map((asset) => asset.path)).size !== assets.length || new Set(assets.map((asset) => asset.repositoryPath)).size !== assets.length) {
    throw new TypeError(`${label} has duplicate asset paths.`);
  }
  const sourceRepositoryPaths = new Set(compiled.files.map((file) => file.repositoryPath));
  if (assets.some((asset) => sourceRepositoryPaths.has(asset.repositoryPath))) {
    throw new TypeError(`${label} must not reuse one repository file as both source and runtime asset.`);
  }
  if (assets.reduce((total, asset) => total + asset.bytes, 0) > MAX_JUDGE_ASSETS_TOTAL_BYTES) {
    throw new TypeError(`${label} runtime assets exceed 4 MiB.`);
  }
  if (!Array.isArray(program.args) || program.args.length > MAX_JUDGE_ARGUMENTS || program.args.some((argument) => typeof argument !== "string" || new TextEncoder().encode(argument).byteLength > MAX_JUDGE_ARGUMENT_BYTES || argument.includes("\0"))) {
    throw new TypeError(`${label}.args must contain at most ${MAX_JUDGE_ARGUMENTS} bounded strings.`);
  }
  return { ...compiled, args: [...program.args] as string[], assets };
}

function judgeContract(value: unknown, problemId: string): ManagedJudgeContract {
  const judge = record(value, `managed problem '${problemId}' judge`);
  if (judge.kind === "text") {
    exact(judge, ["kind"], `managed problem '${problemId}' judge`);
    return { kind: "text" };
  }
  if (judge.kind === "checker") {
    exact(judge, ["kind", "program"], `managed problem '${problemId}' judge`);
    return {
      kind: "checker",
      program: judgeProgram(judge.program, `managed problem '${problemId}' checker`, "/checker/assets/"),
    };
  }
  if (judge.kind === "interactive") {
    exact(judge, ["kind", "program", "inputPath"], `managed problem '${problemId}' judge`);
    const inputPath = guestPath(judge.inputPath, `managed problem '${problemId}' judge.inputPath`);
    if (!inputPath.startsWith("/interactor/input/")) {
      throw new TypeError(`Managed problem '${problemId}' judge.inputPath must be inside '/interactor/input/'.`);
    }
    return {
      kind: "interactive",
      inputPath,
      program: judgeProgram(judge.program, `managed problem '${problemId}' interactor`, "/interactor/assets/"),
    };
  }
  throw new TypeError(`Managed problem '${problemId}' uses an unsupported judge kind.`);
}

export function parseManagedCollectionContract(value: unknown): ManagedCollectionContract {
  const collection = record(value, "managed collection");
  exact(collection, ["schema", "collectionRevision", "problems"], "managed collection");
  if (collection.schema !== MANAGED_COLLECTION_SCHEMA || typeof collection.collectionRevision !== "string" || !DIGEST.test(collection.collectionRevision)) throw new TypeError("Managed collection schema or revision is invalid.");
  if (!Array.isArray(collection.problems) || collection.problems.length < 1 || collection.problems.length > 1_000) throw new TypeError("Managed collection has an invalid problem count.");
  const ids = new Set<string>();
  const problems = collection.problems.map((value, index): ManagedProblemContract => {
    const problem = record(value, `managed problem ${index + 1}`);
    exact(problem, ["id", "allowedLanguages", "references", "judge"], `managed problem ${index + 1}`);
    if (typeof problem.id !== "string" || !ID.test(problem.id) || ids.has(problem.id)) throw new TypeError(`Managed problem ${index + 1} has an invalid identity.`);
    ids.add(problem.id);
    if (!Array.isArray(problem.allowedLanguages) || problem.allowedLanguages.length < 1 || problem.allowedLanguages.some((language) => typeof language !== "string" || !isBuiltinLanguage(language)) || new Set(problem.allowedLanguages).size !== problem.allowedLanguages.length) {
      throw new TypeError(`Managed problem '${problem.id}' allowedLanguages is invalid.`);
    }
    if (!Array.isArray(problem.references)) throw new TypeError(`Managed problem '${problem.id}' references is invalid.`);
    const references = problem.references.map((item, referenceIndex) => reference(item, `managed problem '${problem.id}' reference ${referenceIndex + 1}`));
    const languages = problem.allowedLanguages as BuiltinLanguage[];
    if (references.length !== languages.length || languages.some((language) => references.filter((item) => item.language === language).length !== 1)) {
      throw new TypeError(`Managed problem '${problem.id}' requires exactly one reference per allowed language.`);
    }
    const judge = judgeContract(problem.judge, problem.id);
    return { id: problem.id, allowedLanguages: languages, references, judge };
  });
  return { schema: MANAGED_COLLECTION_SCHEMA, collectionRevision: collection.collectionRevision, problems };
}
