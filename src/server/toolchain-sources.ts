import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  toolchainAssetSource,
  toolchainProfileSource,
  validateServerToolchainSources,
} from "@wasm-oj/core";
import type {
  OptimizationLevel,
  ServerToolchainSource,
  TargetAbi,
  ToolchainDescriptor,
} from "@wasm-oj/contracts";

export interface SerializedServerToolchainSource {
  readonly kind: "server";
  readonly descriptor: ToolchainDescriptor;
  readonly directory: string;
}

export function snapshotServerToolchainSources(
  sources: readonly ServerToolchainSource[],
): readonly ServerToolchainSource[] {
  validateServerToolchainSources(sources);
  return Object.freeze(sources.map((source) => Object.freeze({
    kind: "server" as const,
    descriptor: freezeDescriptor(source.descriptor),
    directory: new URL(source.directory.href),
  })));
}

export function serializeServerToolchainSources(
  sources: readonly ServerToolchainSource[],
): readonly SerializedServerToolchainSource[] {
  return Object.freeze(sources.map((source) => Object.freeze({
    kind: "server" as const,
    descriptor: source.descriptor,
    directory: source.directory.href,
  })));
}

export function deserializeServerToolchainSources(
  sources: readonly SerializedServerToolchainSource[],
): readonly ServerToolchainSource[] {
  if (!Array.isArray(sources)) {
    throw new Error("The isolated server stage did not receive toolchain sources.");
  }
  return snapshotServerToolchainSources(sources.map((source) => {
    if (typeof source !== "object" || source === null || Array.isArray(source)
      || source.kind !== "server" || typeof source.directory !== "string") {
      throw new Error("The isolated server stage received an invalid toolchain source.");
    }
    return {
      kind: "server" as const,
      descriptor: source.descriptor,
      directory: new URL(source.directory),
    };
  }));
}

export function serverToolchainAssetFile(
  sources: readonly ServerToolchainSource[],
  assetPath: string,
): string {
  const { source, asset } = toolchainAssetSource(sources, assetPath);
  const filename = path.basename(asset.path);
  const file = fileURLToPath(new URL(filename, source.directory));
  const directory = fileURLToPath(source.directory);
  const relative = path.relative(directory, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Toolchain asset escapes its package directory: '${assetPath}'.`);
  }
  return file;
}

export function serverToolchainAssetFiles(
  sources: readonly ServerToolchainSource[],
  assetPaths: readonly string[],
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(assetPaths.map((assetPath) => [
    assetPath,
    serverToolchainAssetFile(sources, assetPath),
  ])));
}

export function serverToolchainDirectories(
  sources: readonly ServerToolchainSource[],
): readonly string[] {
  return Object.freeze([...new Set(sources.map((source) => fileURLToPath(source.directory)))]);
}

export function assertServerToolchainProfile(
  sources: readonly ServerToolchainSource[],
  language: string,
  target: TargetAbi,
  optimization: OptimizationLevel,
): void {
  toolchainProfileSource(sources, language, target, optimization);
}

function freezeDescriptor(descriptor: ToolchainDescriptor): ToolchainDescriptor {
  return Object.freeze({
    ...descriptor,
    languages: Object.freeze([...descriptor.languages]),
    profiles: Object.freeze(descriptor.profiles.map((profile) => Object.freeze({ ...profile }))),
    assets: Object.freeze(descriptor.assets.map((asset) => Object.freeze({ ...asset }))),
  });
}
