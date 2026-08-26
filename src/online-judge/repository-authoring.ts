import { parseJudgeAllowedProfiles, type JudgeAllowedProfiles } from "./compile-profiles.ts";
import {
  TRUSTED_JUDGE_RUNTIME_PROFILES,
  TRUSTED_JUDGE_WASM_MAX_BYTES,
  type TrustedJudgeRuntimeProfile,
} from "./trusted-judge-wasm.ts";

export const REPOSITORY_AUTHORING_JUDGES_SCHEMA = "wasm-oj-platform/repository-authoring-judges/v1";

const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000]+$/;
const GUEST_PATH = /^\/(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000]+$/;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_TOTAL_BYTES = 4 * 1024 * 1024;

export interface RepositorySourceObject { readonly path: string; readonly bytes: number; readonly sha256: string; }
export interface RepositorySourceArtifact extends RepositorySourceObject { readonly runtimeProfile: TrustedJudgeRuntimeProfile; }
export interface RepositorySourceAsset extends RepositorySourceObject { readonly guestPath: string; }
export type RepositorySourceJudge =
  | { readonly kind: "text" }
  | { readonly kind: "checker"; readonly artifact: RepositorySourceArtifact; readonly assets: readonly RepositorySourceAsset[]; readonly args: readonly string[] }
  | { readonly kind: "interactive"; readonly artifact: RepositorySourceArtifact; readonly assets: readonly RepositorySourceAsset[]; readonly args: readonly string[]; readonly inputPath: string };
export interface RepositoryAuthoringJudgeProblem { readonly slug: string; readonly allowedProfiles: JudgeAllowedProfiles; readonly judge: RepositorySourceJudge; }
export interface RepositoryAuthoringJudges { readonly schema: typeof REPOSITORY_AUTHORING_JUDGES_SCHEMA; readonly problems: readonly RepositoryAuthoringJudgeProblem[]; }

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new TypeError(`${label} has an invalid shape.`);
}

function sourceObject(value: unknown, label: string, maximum: number): RepositorySourceObject {
  const object = record(value, label);
  exact(object, ["bytes", "path", "sha256"], label);
  if (typeof object.path !== "string" || object.path.length < 1 || object.path.length > 512 || !PATH.test(object.path)) throw new TypeError(`${label}.path must be a normalized repository-relative POSIX path.`);
  if (!Number.isSafeInteger(object.bytes) || (object.bytes as number) < 1 || (object.bytes as number) > maximum) throw new TypeError(`${label}.bytes is outside its limit.`);
  if (typeof object.sha256 !== "string" || !SHA256.test(object.sha256)) throw new TypeError(`${label}.sha256 is invalid.`);
  return { path: object.path, bytes: object.bytes as number, sha256: object.sha256 };
}

function judge(value: unknown, slug: string): RepositorySourceJudge {
  const input = record(value, `repository authoring '${slug}' judge`);
  if (input.kind === "text") { exact(input, ["kind"], `repository authoring '${slug}' text judge`); return { kind: "text" }; }
  if (input.kind !== "checker" && input.kind !== "interactive") throw new TypeError(`Repository authoring '${slug}' judge kind is unsupported.`);
  exact(input, input.kind === "checker" ? ["args", "artifact", "assets", "kind"] : ["args", "artifact", "assets", "inputPath", "kind"], `repository authoring '${slug}' ${input.kind}`);
  const artifactValue = record(input.artifact, `repository authoring '${slug}' ${input.kind} artifact`);
  exact(artifactValue, ["bytes", "path", "runtimeProfile", "sha256"], `repository authoring '${slug}' ${input.kind} artifact`);
  if (typeof artifactValue.runtimeProfile !== "string" || !TRUSTED_JUDGE_RUNTIME_PROFILES.has(artifactValue.runtimeProfile as TrustedJudgeRuntimeProfile)) throw new TypeError(`Repository authoring '${slug}' ${input.kind} runtimeProfile is unsupported.`);
  const artifact = {
    ...sourceObject({ bytes: artifactValue.bytes, path: artifactValue.path, sha256: artifactValue.sha256 }, `repository authoring '${slug}' ${input.kind} artifact`, TRUSTED_JUDGE_WASM_MAX_BYTES),
    runtimeProfile: artifactValue.runtimeProfile as TrustedJudgeRuntimeProfile,
  };
  if (!artifact.path.endsWith(".wasm")) throw new TypeError(`Repository authoring '${slug}' ${input.kind} artifact path must end in '.wasm'.`);
  if (!Array.isArray(input.assets) || input.assets.length > 256) throw new TypeError(`Repository authoring '${slug}' ${input.kind} assets are invalid.`);
  const namespace = input.kind === "checker" ? "/checker/assets/" : "/interactor/assets/";
  const assets = input.assets.map((candidate, index): RepositorySourceAsset => {
    const asset = record(candidate, `repository authoring '${slug}' ${input.kind} asset ${index}`);
    exact(asset, ["bytes", "guestPath", "path", "sha256"], `repository authoring '${slug}' ${input.kind} asset ${index}`);
    if (typeof asset.guestPath !== "string" || !GUEST_PATH.test(asset.guestPath) || !asset.guestPath.startsWith(namespace)) throw new TypeError(`Repository authoring '${slug}' ${input.kind} asset ${index} guestPath must be inside '${namespace}'.`);
    return { ...sourceObject({ bytes: asset.bytes, path: asset.path, sha256: asset.sha256 }, `repository authoring '${slug}' ${input.kind} asset ${index}`, MAX_ASSET_BYTES), guestPath: asset.guestPath };
  });
  const guestPaths = assets.map((asset) => asset.guestPath);
  const repositoryPaths = [artifact.path, ...assets.map((asset) => asset.path)];
  if (new Set(guestPaths).size !== guestPaths.length || new Set(repositoryPaths).size !== repositoryPaths.length) throw new TypeError(`Repository authoring '${slug}' ${input.kind} repeats an asset or repository path.`);
  if (assets.reduce((total, asset) => total + asset.bytes, 0) > MAX_ASSET_TOTAL_BYTES) throw new TypeError(`Repository authoring '${slug}' ${input.kind} assets exceed 4 MiB.`);
  if (!Array.isArray(input.args) || input.args.length > 64 || input.args.some((argument) => typeof argument !== "string" || argument.includes("\0") || new TextEncoder().encode(argument).byteLength > 4_096)) throw new TypeError(`Repository authoring '${slug}' ${input.kind} args are invalid.`);
  const args = [...input.args] as string[];
  if (input.kind === "checker") return { kind: "checker", artifact, assets, args };
  if (typeof input.inputPath !== "string" || !GUEST_PATH.test(input.inputPath) || !input.inputPath.startsWith("/interactor/input/")) throw new TypeError(`Repository authoring '${slug}' interactive inputPath must be inside '/interactor/input/'.`);
  return { kind: "interactive", artifact, assets, args, inputPath: input.inputPath };
}

/** Author-only input used by collection build; never accepted by the platform sync boundary. */
export function parseRepositoryAuthoringJudges(value: unknown): RepositoryAuthoringJudges {
  const source = record(value, "repository authoring judges");
  exact(source, ["problems", "schema"], "repository authoring judges");
  if (source.schema !== REPOSITORY_AUTHORING_JUDGES_SCHEMA) throw new TypeError(`Repository authoring judge schema must be '${REPOSITORY_AUTHORING_JUDGES_SCHEMA}'.`);
  if (!Array.isArray(source.problems) || source.problems.length < 1 || source.problems.length > 1_000) throw new TypeError("Repository authoring judges must contain between 1 and 1000 problems.");
  const slugs = new Set<string>();
  const problems = source.problems.map((candidate, index): RepositoryAuthoringJudgeProblem => {
    const problem = record(candidate, `repository authoring judge problem ${index + 1}`);
    exact(problem, ["allowedProfiles", "judge", "slug"], `repository authoring judge problem ${index + 1}`);
    if (typeof problem.slug !== "string" || !SLUG.test(problem.slug) || slugs.has(problem.slug)) throw new TypeError(`Repository authoring judge problem ${index + 1} has an invalid or duplicate slug.`);
    slugs.add(problem.slug);
    return { slug: problem.slug, allowedProfiles: parseJudgeAllowedProfiles(problem.allowedProfiles, `repository authoring '${problem.slug}' allowedProfiles`), judge: judge(problem.judge, problem.slug) };
  });
  return { schema: REPOSITORY_AUTHORING_JUDGES_SCHEMA, problems };
}
