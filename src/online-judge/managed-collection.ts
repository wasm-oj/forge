import { parseCanonicalJsonBytes } from "../core/canonical-json.ts";
import { parseJudgeAllowedProfiles, type JudgeAllowedProfiles } from "./compile-profiles.ts";

export const MANAGED_COLLECTION_SCHEMA = "wasm-oj-platform/managed-collection/v2";

const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000]+$/;
const MAX_MANAGED_COLLECTION_BYTES = 2 * 1024 * 1024;
const MAX_PROJECTION_BYTES = 32 * 1024 * 1024;

export interface ManagedRepositoryObject {
  /** Normalized path relative to the directory containing collection/index.json. */
  readonly repositoryPath: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ManagedProblemPublication {
  readonly slug: string;
  readonly allowedProfiles: JudgeAllowedProfiles;
  readonly contestPublic: ManagedRepositoryObject;
  readonly judgePackage: ManagedRepositoryObject;
}

export interface ManagedCollectionV2 {
  readonly schema: typeof MANAGED_COLLECTION_SCHEMA;
  readonly collectionRevision: string;
  readonly problems: readonly ManagedProblemPublication[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new TypeError(`${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function repositoryObject(value: unknown, label: string, maximum: number): ManagedRepositoryObject {
  const object = record(value, label);
  exact(object, ["bytes", "repositoryPath", "sha256"], label);
  if (typeof object.repositoryPath !== "string" || object.repositoryPath.length < 1 || object.repositoryPath.length > 512 || !PATH.test(object.repositoryPath)) {
    throw new TypeError(`${label}.repositoryPath must be a normalized relative POSIX path.`);
  }
  if (!Number.isSafeInteger(object.bytes) || (object.bytes as number) < 1 || (object.bytes as number) > maximum) {
    throw new TypeError(`${label}.bytes is outside its publication limit.`);
  }
  if (typeof object.sha256 !== "string" || !SHA256.test(object.sha256)) {
    throw new TypeError(`${label}.sha256 must be a lowercase SHA-256 digest.`);
  }
  return { repositoryPath: object.repositoryPath, bytes: object.bytes as number, sha256: object.sha256 };
}

/** Parse the value form used by the authoring CLI after JSON decoding. */
export function parseManagedCollectionValueV2(value: unknown): ManagedCollectionV2 {
  const collection = record(value, "managed collection");
  exact(collection, ["collectionRevision", "problems", "schema"], "managed collection");
  if (collection.schema !== MANAGED_COLLECTION_SCHEMA) {
    throw new TypeError(`Managed collection schema must be '${MANAGED_COLLECTION_SCHEMA}'.`);
  }
  if (typeof collection.collectionRevision !== "string" || !SHA256.test(collection.collectionRevision)) {
    throw new TypeError("Managed collection revision must be a lowercase SHA-256 digest.");
  }
  if (!Array.isArray(collection.problems) || collection.problems.length < 1 || collection.problems.length > 1_000) {
    throw new TypeError("Managed collection must contain between 1 and 1000 problems.");
  }
  const slugs = new Set<string>();
  const paths = new Set<string>();
  const problems = collection.problems.map((candidate, index): ManagedProblemPublication => {
    const problem = record(candidate, `managed problem ${index + 1}`);
    exact(problem, ["allowedProfiles", "contestPublic", "judgePackage", "slug"], `managed problem ${index + 1}`);
    if (typeof problem.slug !== "string" || !SLUG.test(problem.slug) || slugs.has(problem.slug)) {
      throw new TypeError(`Managed problem ${index + 1} has an invalid or duplicate slug.`);
    }
    slugs.add(problem.slug);
    const allowedProfiles = parseJudgeAllowedProfiles(problem.allowedProfiles, `managed problem '${problem.slug}' allowedProfiles`);
    const contestPublic = repositoryObject(problem.contestPublic, `managed problem '${problem.slug}' contestPublic`, 8 * 1024 * 1024);
    const judgePackage = repositoryObject(problem.judgePackage, `managed problem '${problem.slug}' judgePackage`, MAX_PROJECTION_BYTES);
    for (const path of [contestPublic.repositoryPath, judgePackage.repositoryPath]) {
      if (paths.has(path)) throw new TypeError(`Managed publication path '${path}' is declared more than once.`);
      paths.add(path);
    }
    return { slug: problem.slug, allowedProfiles, contestPublic, judgePackage };
  });
  return {
    schema: MANAGED_COLLECTION_SCHEMA,
    collectionRevision: collection.collectionRevision,
    problems,
  };
}

/**
 * Stable platform boundary for generated collection/managed.json bytes.
 * Published managed contracts must use WASM-OJ canonical JSON; author-only
 * managed-source documents are intentionally not accepted here.
 */
export function parseManagedCollectionV2(bytes: Uint8Array): ManagedCollectionV2 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_MANAGED_COLLECTION_BYTES) {
    throw new TypeError("Managed collection bytes are outside the 2 MiB limit.");
  }
  return parseManagedCollectionValueV2(parseCanonicalJsonBytes(bytes, "managed collection"));
}

/** Same v2-only value parser retained as the environment-neutral library entry point. */
export const parseManagedCollectionContract = parseManagedCollectionValueV2;
