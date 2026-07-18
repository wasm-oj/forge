import type { Project } from "./types.ts";
import { toolchainCacheIdentity } from "./toolchains.ts";
import { canonicalProjectFiles } from "./project-files.ts";

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const source = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function projectCacheKey(project: Project): Promise<string> {
  return sha256Hex(projectBuildIdentity(project));
}

export async function projectCacheKeyForCompiler(
  project: Project,
  compilerCacheIdentity: string,
): Promise<string> {
  return sha256Hex(projectBuildIdentity(project, compilerCacheIdentity));
}

export function assertCompilerCacheKey(cacheKey: unknown): asserts cacheKey is string {
  if (typeof cacheKey !== "string" || !cacheKey || cacheKey !== cacheKey.trim() || cacheKey.length > 16_384) {
    throw new Error("Compiler cache keys must be non-empty, trimmed strings of at most 16384 characters.");
  }
}

/** Stable synchronous identity used to debounce compile-ahead work in UIs. */
export function projectBuildIdentity(
  project: Project,
  compilerCacheIdentity = JSON.stringify(toolchainCacheIdentity(project.config.language)),
): string {
  if (
    !compilerCacheIdentity
    || compilerCacheIdentity !== compilerCacheIdentity.trim()
    || compilerCacheIdentity.length > 16_384
  ) {
    throw new Error("Compiler cache identities must be non-empty, trimmed strings of at most 16384 characters.");
  }
  return JSON.stringify({
    project: {
      id: project.id,
      name: project.name,
    },
    config: {
      language: project.config.language,
      target: project.config.target,
      optimization: project.config.optimization,
      entry: project.config.entry,
    },
    compiler: compilerCacheIdentity,
    files: canonicalProjectFiles(project.files)
      .map(({ path, language, content }) => ({ path, language, content })),
  });
}
