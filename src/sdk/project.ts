import { DEFAULT_DETERMINISM } from "../core/determinism";
import { DEFAULT_RESOURCE_POLICY } from "../core/resources";
import { extensionLanguage, TOOLCHAINS } from "../core/toolchains";
import { assertSafeRelativePath, canonicalProjectFiles } from "../core/project-files";
import {
  assertLanguageIdentifier,
  isBuiltinLanguage,
  type Language,
  type OptimizationLevel,
  type Project,
  type ProjectFile,
  type TargetAbi,
} from "../core/types";
import {
  assertValidDependencyBuildBundle,
  type DependencyBuildBundle,
} from "../dependencies/build";

export interface CompileInput {
  language: Language;
  entry: string;
  files: Readonly<Record<string, string>>;
  target?: TargetAbi;
  optimization?: OptimizationLevel;
  name?: string;
  projectId?: string;
  dependencies?: DependencyBuildBundle;
}

function optionalMetadata(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty, trimmed string of at most ${maximum} characters.`);
  }
  return value;
}

function fileLanguage(path: string, projectLanguage: Language): Language {
  const inferred = extensionLanguage(path);
  if (!inferred || path.endsWith(".h") || path.endsWith(".hpp")) return projectLanguage;
  return inferred;
}

export function createSdkProject(input: CompileInput): Project {
  if (!input || typeof input !== "object") throw new TypeError("Compile input must be an object.");
  assertLanguageIdentifier(input.language);
  assertSafeRelativePath(input.entry, "Entry file");
  const entry = input.entry;
  if (!input.files || typeof input.files !== "object" || Array.isArray(input.files)) {
    throw new TypeError("Compile input files must be a record.");
  }
  const entries = Object.entries(input.files);
  if (entries.length === 0) throw new Error("A project must contain at least one source file.");

  const files: ProjectFile[] = entries.map(([path, content]) => {
    assertSafeRelativePath(path, "Source file path");
    return { path, content, language: fileLanguage(path, input.language) };
  });
  if (!Object.hasOwn(input.files, entry)) throw new Error(`Entry file '${entry}' is not present in files.`);

  const target = input.target ?? "wasip1";
  if (target !== "wasip1" && target !== "wasix") throw new Error(`Unsupported target '${String(target)}'.`);
  if (isBuiltinLanguage(input.language) && !TOOLCHAINS[input.language].targets.includes(target)) {
    throw new Error(`${input.language} does not support the ${target.toUpperCase()} target.`);
  }
  const optimization = input.optimization ?? "release";
  if (optimization !== "debug" && optimization !== "release") {
    throw new Error(`Unsupported optimization level '${String(optimization)}'.`);
  }
  const inferredName = entry.split("/").at(-1)?.replace(/\.[^.]+$/, "") || "forge-project";
  const name = optionalMetadata(input.name, "Project name", 4_096) ?? inferredName;
  const projectId = optionalMetadata(input.projectId, "Project ID", 16_384) ?? `sdk:${name}`;
  if (input.dependencies !== undefined) assertValidDependencyBuildBundle(input.dependencies);
  return {
    id: projectId,
    name,
    files: canonicalProjectFiles(files),
    activeFile: entry,
    updatedAt: Date.now(),
    ...(input.dependencies === undefined ? {} : { dependencies: structuredClone(input.dependencies) }),
    config: {
      language: input.language,
      target,
      optimization,
      entry,
      args: [],
      stdin: "",
      env: {},
      determinism: { ...DEFAULT_DETERMINISM },
      resources: { ...DEFAULT_RESOURCE_POLICY },
    },
  };
}
