import { WEIGHTED_METER_MODEL } from "./resources.ts";
import { FORGE_CONTRACT_VERSION } from "./contract.ts";
import { toolchainContentIdentity } from "./toolchains.ts";
import {
  assertLanguageIdentifier,
  isBuiltinLanguage,
  type Language,
  type OptimizationLevel,
  type TargetAbi,
} from "./types.ts";

function coordinates(
  language: Language,
  target: TargetAbi,
  optimization: OptimizationLevel,
): string[] {
  assertLanguageIdentifier(language);
  return [
    "wasm-oj-forge-cost",
    `contract-${FORGE_CONTRACT_VERSION}`,
    encodeURIComponent(language),
    target,
    optimization,
  ];
}

/** Stable identity for one calibrated compiler/runtime overhead profile. */
export function costProfileId(
  language: Language,
  target: TargetAbi,
  optimization: OptimizationLevel,
  downstreamToolchainContent?: string,
): string {
  const content = isBuiltinLanguage(language)
    ? toolchainContentIdentity(language)
    : downstreamToolchainContent;
  if (!content || !/^[A-Za-z0-9._-]+$/.test(content)) {
    throw new Error(
      isBuiltinLanguage(language)
        ? `Forge toolchain content identity is invalid for '${language}'.`
        : `Downstream language '${language}' requires an explicit content identity using letters, digits, '.', '_' or '-'.`,
    );
  }
  return [
    ...coordinates(language, target, optimization),
    `content-${content}`,
    WEIGHTED_METER_MODEL,
  ].join(":");
}

export function isCostProfileFor(
  profile: string,
  language: Language,
  target: TargetAbi,
  optimization: OptimizationLevel,
): boolean {
  const prefix = `${coordinates(language, target, optimization).join(":")}:content-`;
  const suffix = `:${WEIGHTED_METER_MODEL}`;
  if (!profile.startsWith(prefix) || !profile.endsWith(suffix)) return false;
  const content = profile.slice(prefix.length, -suffix.length);
  return Boolean(content) && /^[A-Za-z0-9._-]+$/.test(content);
}
