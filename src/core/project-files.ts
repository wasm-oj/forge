import { assertLanguageIdentifier, type ProjectFile } from "./types.ts";

export const PROJECT_SOURCE_LIMITS = Object.freeze({
  files: 256,
  bytesPerFile: 4 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
});

const UTF8_ENCODER = new TextEncoder();

/** Locale-independent ordering used anywhere file order can affect build output. */
export function compareCanonicalPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertSafeRelativePath(path: unknown, label = "Project path"): asserts path is string {
  if (typeof path !== "string" || !path || path !== path.trim() || path.length > 4_096) {
    throw new Error(`${label} must be a non-empty, trimmed string of at most 4096 characters.`);
  }
  if (
    path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} '${path}' must be a normalized relative path that cannot escape the project.`);
  }
}

/**
 * Validates a project file set and returns a fresh, locale-independently sorted
 * array. Build hosts must use this order for filesystem creation and argv.
 */
export function canonicalProjectFiles(files: readonly ProjectFile[]): ProjectFile[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("A project must contain at least one source file.");
  }
  if (files.length > PROJECT_SOURCE_LIMITS.files) {
    throw new Error(`A project cannot contain more than ${PROJECT_SOURCE_LIMITS.files} source files.`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const canonical = files.map((file, index) => {
    if (!file || typeof file !== "object") throw new Error(`Project file ${index} is invalid.`);
    assertSafeRelativePath(file.path, `Project file ${index} path`);
    assertLanguageIdentifier(file.language);
    if (typeof file.content !== "string") throw new Error(`Project file '${file.path}' content must be a string.`);
    if (file.content.length > PROJECT_SOURCE_LIMITS.bytesPerFile) {
      throw new Error(
        `Project file '${file.path}' exceeds the ${PROJECT_SOURCE_LIMITS.bytesPerFile} byte source limit.`,
      );
    }
    const contentBytes = UTF8_ENCODER.encode(file.content).byteLength;
    if (contentBytes > PROJECT_SOURCE_LIMITS.bytesPerFile) {
      throw new Error(
        `Project file '${file.path}' exceeds the ${PROJECT_SOURCE_LIMITS.bytesPerFile} byte source limit.`,
      );
    }
    totalBytes += contentBytes;
    if (totalBytes > PROJECT_SOURCE_LIMITS.totalBytes) {
      throw new Error(`Project sources exceed the ${PROJECT_SOURCE_LIMITS.totalBytes} byte total limit.`);
    }
    if (seen.has(file.path)) throw new Error(`Duplicate project path '${file.path}'.`);
    seen.add(file.path);
    return { path: file.path, language: file.language, content: file.content };
  });
  return canonical.sort((left, right) => compareCanonicalPaths(left.path, right.path));
}

export function canonicalFileEntries<T>(files: Readonly<Record<string, T>>): Array<[string, T]> {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("Runtime bundle files must be a record.");
  }
  return Object.entries(files)
    .map(([path, contents]) => {
      assertSafeRelativePath(path, "Runtime bundle path");
      return [path, contents] as [string, T];
    })
    .sort(([left], [right]) => compareCanonicalPaths(left, right));
}

export function canonicalFileRecord<T>(files: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(canonicalFileEntries(files));
}
