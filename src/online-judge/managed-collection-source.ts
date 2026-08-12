import { parseJudgeAllowedProfiles, type JudgeAllowedProfiles } from "./compile-profiles.ts";
import {
  TRUSTED_JUDGE_RUNTIME_PROFILES,
  TRUSTED_JUDGE_WASM_MAX_BYTES,
  type TrustedJudgeRuntimeProfile,
} from "./trusted-judge-wasm.ts";

export const MANAGED_COLLECTION_SOURCE_SCHEMA = "wasm-oj-platform/managed-collection-source/v1";

const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000]+$/;
const GUEST_PATH = /^\/(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000]+$/;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_TOTAL_BYTES = 4 * 1024 * 1024;

export interface ManagedSourceObject {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ManagedSourceArtifact extends ManagedSourceObject {
  readonly runtimeProfile: TrustedJudgeRuntimeProfile;
}

export interface ManagedSourceAsset extends ManagedSourceObject {
  readonly guestPath: string;
}

export type ManagedSourceJudge =
  | { readonly kind: "text" }
  | {
    readonly kind: "checker";
    readonly artifact: ManagedSourceArtifact;
    readonly assets: readonly ManagedSourceAsset[];
    readonly args: readonly string[];
  }
  | {
    readonly kind: "interactive";
    readonly artifact: ManagedSourceArtifact;
    readonly assets: readonly ManagedSourceAsset[];
    readonly args: readonly string[];
    readonly inputPath: string;
  };

export interface ManagedCollectionSourceProblem {
  readonly slug: string;
  readonly allowedProfiles: JudgeAllowedProfiles;
  readonly judge: ManagedSourceJudge;
}

export interface ManagedCollectionSource {
  readonly schema: typeof MANAGED_COLLECTION_SOURCE_SCHEMA;
  readonly problems: readonly ManagedCollectionSourceProblem[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new TypeError(`${label} has an invalid shape.`);
}

function sourceObject(value: unknown, label: string, maximum: number): ManagedSourceObject {
  const object = record(value, label);
  exact(object, ["bytes", "path", "sha256"], label);
  if (typeof object.path !== "string" || object.path.length < 1 || object.path.length > 512 || !PATH.test(object.path)) {
    throw new TypeError(`${label}.path must be a normalized repository-relative POSIX path.`);
  }
  if (!Number.isSafeInteger(object.bytes) || (object.bytes as number) < 1 || (object.bytes as number) > maximum) {
    throw new TypeError(`${label}.bytes is outside its limit.`);
  }
  if (typeof object.sha256 !== "string" || !SHA256.test(object.sha256)) throw new TypeError(`${label}.sha256 is invalid.`);
  return { path: object.path, bytes: object.bytes as number, sha256: object.sha256 };
}

function profiles(value: unknown, slug: string): ManagedCollectionSourceProblem["allowedProfiles"] {
  return parseJudgeAllowedProfiles(value, `managed source '${slug}' allowedProfiles`);
}

function judge(value: unknown, slug: string): ManagedSourceJudge {
  const input = record(value, `managed source '${slug}' judge`);
  if (input.kind === "text") {
    exact(input, ["kind"], `managed source '${slug}' text judge`);
    return { kind: "text" };
  }
  if (input.kind !== "checker" && input.kind !== "interactive") throw new TypeError(`Managed source '${slug}' judge kind is unsupported.`);
  exact(input, input.kind === "checker"
    ? ["args", "artifact", "assets", "kind"]
    : ["args", "artifact", "assets", "inputPath", "kind"], `managed source '${slug}' ${input.kind}`);
  const artifactValue = record(input.artifact, `managed source '${slug}' ${input.kind} artifact`);
  exact(artifactValue, ["bytes", "path", "runtimeProfile", "sha256"], `managed source '${slug}' ${input.kind} artifact`);
  if (typeof artifactValue.runtimeProfile !== "string" || !TRUSTED_JUDGE_RUNTIME_PROFILES.has(artifactValue.runtimeProfile as TrustedJudgeRuntimeProfile)) {
    throw new TypeError(`Managed source '${slug}' ${input.kind} runtimeProfile is unsupported.`);
  }
  const artifact = {
    ...sourceObject({ bytes: artifactValue.bytes, path: artifactValue.path, sha256: artifactValue.sha256 }, `managed source '${slug}' ${input.kind} artifact`, TRUSTED_JUDGE_WASM_MAX_BYTES),
    runtimeProfile: artifactValue.runtimeProfile as TrustedJudgeRuntimeProfile,
  };
  if (!artifact.path.endsWith(".wasm")) throw new TypeError(`Managed source '${slug}' ${input.kind} artifact path must end in '.wasm'.`);
  if (!Array.isArray(input.assets) || input.assets.length > 256) throw new TypeError(`Managed source '${slug}' ${input.kind} assets are invalid.`);
  const namespace = input.kind === "checker" ? "/checker/assets/" : "/interactor/assets/";
  const assets = input.assets.map((candidate, index): ManagedSourceAsset => {
    const asset = record(candidate, `managed source '${slug}' ${input.kind} asset ${index}`);
    exact(asset, ["bytes", "guestPath", "path", "sha256"], `managed source '${slug}' ${input.kind} asset ${index}`);
    if (typeof asset.guestPath !== "string" || !GUEST_PATH.test(asset.guestPath) || !asset.guestPath.startsWith(namespace)) {
      throw new TypeError(`Managed source '${slug}' ${input.kind} asset ${index} guestPath must be inside '${namespace}'.`);
    }
    return {
      ...sourceObject({ bytes: asset.bytes, path: asset.path, sha256: asset.sha256 }, `managed source '${slug}' ${input.kind} asset ${index}`, MAX_ASSET_BYTES),
      guestPath: asset.guestPath,
    };
  });
  const guestPaths = assets.map((asset) => asset.guestPath);
  const repositoryPaths = [artifact.path, ...assets.map((asset) => asset.path)];
  if (new Set(guestPaths).size !== guestPaths.length || new Set(repositoryPaths).size !== repositoryPaths.length) {
    throw new TypeError(`Managed source '${slug}' ${input.kind} repeats an asset or repository path.`);
  }
  if (assets.reduce((total, asset) => total + asset.bytes, 0) > MAX_ASSET_TOTAL_BYTES) throw new TypeError(`Managed source '${slug}' ${input.kind} assets exceed 4 MiB.`);
  if (!Array.isArray(input.args) || input.args.length > 64 || input.args.some((argument) => (
    typeof argument !== "string" || argument.includes("\0") || new TextEncoder().encode(argument).byteLength > 4_096
  ))) throw new TypeError(`Managed source '${slug}' ${input.kind} args are invalid.`);
  const judgeArgs = [...input.args] as string[];
  if (input.kind === "checker") return { kind: "checker", artifact, assets, args: judgeArgs };
  if (typeof input.inputPath !== "string" || !GUEST_PATH.test(input.inputPath) || !input.inputPath.startsWith("/interactor/input/")) {
    throw new TypeError(`Managed source '${slug}' interactive inputPath must be inside '/interactor/input/'.`);
  }
  return { kind: "interactive", artifact, assets, args: judgeArgs, inputPath: input.inputPath };
}

/** Author-only parser. Platform publication parsers must never call this API. */
export function parseManagedCollectionSource(value: unknown): ManagedCollectionSource {
  const source = record(value, "managed collection source");
  exact(source, ["problems", "schema"], "managed collection source");
  if (source.schema !== MANAGED_COLLECTION_SOURCE_SCHEMA) throw new TypeError(`Managed collection source schema must be '${MANAGED_COLLECTION_SOURCE_SCHEMA}'.`);
  if (!Array.isArray(source.problems) || source.problems.length < 1 || source.problems.length > 1_000) throw new TypeError("Managed collection source must contain between 1 and 1000 problems.");
  const slugs = new Set<string>();
  const problems = source.problems.map((candidate, index): ManagedCollectionSourceProblem => {
    const problem = record(candidate, `managed source problem ${index + 1}`);
    exact(problem, ["allowedProfiles", "judge", "slug"], `managed source problem ${index + 1}`);
    if (typeof problem.slug !== "string" || !SLUG.test(problem.slug) || slugs.has(problem.slug)) throw new TypeError(`Managed source problem ${index + 1} has an invalid or duplicate slug.`);
    slugs.add(problem.slug);
    return { slug: problem.slug, allowedProfiles: profiles(problem.allowedProfiles, problem.slug), judge: judge(problem.judge, problem.slug) };
  });
  return { schema: MANAGED_COLLECTION_SOURCE_SCHEMA, problems };
}
