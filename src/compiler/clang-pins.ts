import { sha256Hex } from "../core/hash.ts";
import { FORGE_SCHEMAS } from "../core/contract.ts";
import { CLANG_CC1_PINS_SHA256 } from "../core/toolchains.ts";

export interface ClangPinPlaceholders {
  input: string;
  output: string;
  mainFileName: string;
  objects: string;
}

export interface ClangPinConfig {
  cc1: readonly string[];
  link: readonly string[];
}

export interface ClangPins {
  schema: typeof FORGE_SCHEMAS.clangPins;
  version: string;
  source: string;
  sourceSha256: string;
  command: string;
  linkerCommand: string;
  placeholders: ClangPinPlaceholders;
  configs: Record<string, ClangPinConfig>;
}

const decoder = new TextDecoder();

export async function decodeClangPins(bytes: Uint8Array): Promise<ClangPins> {
  const digest = await sha256Hex(bytes);
  if (digest !== CLANG_CC1_PINS_SHA256) {
    throw new Error(
      `The pinned cc1 manifest drifted from its contract: expected ${CLANG_CC1_PINS_SHA256}, received ${digest}. `
      + "Regenerate it with scripts/pin-clang-cc1-argv.mjs and update CLANG_CC1_PINS_SHA256.",
    );
  }
  const parsed = JSON.parse(decoder.decode(bytes)) as ClangPins;
  if (parsed.schema !== FORGE_SCHEMAS.clangPins) {
    throw new Error(`Unsupported cc1 pin schema '${parsed.schema}'.`);
  }
  for (const key of ["input", "output", "mainFileName", "objects"] as const) {
    if (typeof parsed.placeholders?.[key] !== "string") {
      throw new Error(`The cc1 pin manifest is missing the '${key}' placeholder.`);
    }
  }
  if (!parsed.command || !parsed.linkerCommand) {
    throw new Error("The cc1 pin manifest is missing a compiler or linker command.");
  }
  if (!parsed.source || !/^[a-f0-9]{64}$/.test(parsed.sourceSha256)) {
    throw new Error("The cc1 pin manifest is missing its source toolchain identity.");
  }
  for (const [key, config] of Object.entries(parsed.configs)) {
    if (!Array.isArray(config.cc1) || !Array.isArray(config.link) || config.cc1[0] !== "-cc1") {
      throw new Error(`The cc1 pin manifest entry '${key}' is malformed.`);
    }
  }
  return parsed;
}

export function instantiateClangCc1(
  template: readonly string[],
  placeholders: ClangPinPlaceholders,
  source: string,
  objectPath: string,
): string[] {
  const basename = source.slice(source.lastIndexOf("/") + 1);
  const inputPath = source.startsWith("/") ? source : `/project/${source}`;
  return template.map((token) => {
    if (token === placeholders.input) return inputPath;
    if (token === placeholders.output) return objectPath;
    if (token === placeholders.mainFileName) return basename;
    return token;
  });
}

export function instantiateClangPch(
  template: readonly string[],
  placeholders: ClangPinPlaceholders,
  header: string,
  outputPath: string,
): string[] {
  return instantiateClangCc1(
    template.map((token) => token === "-emit-obj" ? "-emit-pch" : token === "c++" ? "c++-header" : token),
    placeholders,
    header,
    outputPath,
  );
}

export function instantiateClangLink(
  template: readonly string[],
  placeholders: ClangPinPlaceholders,
  objectPaths: readonly string[],
  outputPath: string,
): string[] {
  const argv: string[] = [];
  for (const token of template) {
    if (token === placeholders.objects) argv.push(...objectPaths);
    else if (token === placeholders.output) argv.push(outputPath);
    else argv.push(token);
  }
  return argv;
}
