import type { ForgeWorkerEnv } from "./env";
import {
  parseValidationWorkflowParameters,
  type ValidationWorkflowParameters,
} from "./validation-contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const INDEX_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000-\u001f\u007f]+$/;

export type ValidationImportStatus = "queued" | "downloading" | "validating" | "valid" | "invalid" | "infrastructure-error";
export type ValidationSourceKind = "github-archive" | "canonical-successor";

interface StoredValidationContext {
  readonly organizer_user_id: string;
  readonly github_repository_id: number;
  readonly commit_sha: string;
  readonly index_path: string;
  readonly forge_release_id: string;
  readonly release_manifest_sha256: string;
  readonly source_kind: string;
  readonly predecessor_import_id: string | null;
  readonly canonical_source_r2_key: string | null;
  readonly canonical_source_mirror_r2_key: string | null;
  readonly canonical_source_sha256: string | null;
  readonly archive_r2_key: string | null;
  readonly archive_disposition: string;
  readonly status: string;
  readonly installation_id: number;
  readonly owner_login: string;
  readonly repository_name: string;
  readonly repository_authorization_status: string;
  readonly installation_status: string;
  readonly installed_by_user_id: string | null;
  readonly predecessor_fence: number;
}

interface ValidationWorkflowCommonContext extends ValidationWorkflowParameters {
  readonly organizerUserId: string;
  readonly githubRepositoryId: number;
  readonly commitSha: string;
  readonly indexPath: string;
  readonly status: ValidationImportStatus;
}

export type HydratedValidationWorkflowContext = ValidationWorkflowCommonContext & {
  readonly source:
    | {
      readonly kind: "github-archive";
      readonly installationId: number;
      readonly expectedOwner: string;
      readonly expectedRepository: string;
      readonly archiveR2Key?: string;
    }
    | {
      readonly kind: "canonical-successor";
      readonly predecessorImportId: string;
      readonly canonicalSourceR2Key: string;
      readonly canonicalSourceMirrorR2Key: string;
      readonly canonicalSourceSha256: string;
    };
};

export interface ValidationWorkflowStepMarker {
  readonly sourceKind: ValidationSourceKind;
}

export const HYDRATE_VALIDATION_WORKFLOW_SQL = `SELECT
    imports.organizer_user_id,
    imports.github_repository_id,
    imports.commit_sha,
    imports.index_path,
    imports.forge_release_id,
    releases.manifest_sha256 AS release_manifest_sha256,
    imports.source_kind,
    imports.predecessor_import_id,
    imports.canonical_source_r2_key,
    imports.canonical_source_mirror_r2_key,
    imports.canonical_source_sha256,
    imports.archive_r2_key,
    imports.archive_disposition,
    imports.status,
    repositories.installation_id,
    repositories.owner_login,
    repositories.name AS repository_name,
    repositories.authorization_status AS repository_authorization_status,
    installations.status AS installation_status,
    installations.installed_by_user_id,
    CASE WHEN EXISTS (
      SELECT 1
      FROM collection_imports AS predecessor
      JOIN managed_snapshots AS snapshot
        ON snapshot.import_id=predecessor.id
       AND snapshot.mode='official-practice'
       AND snapshot.status='published'
      WHERE predecessor.id=imports.predecessor_import_id
        AND predecessor.status='valid'
        AND predecessor.forge_release_id<>imports.forge_release_id
        AND predecessor.organizer_user_id=imports.organizer_user_id
        AND predecessor.github_repository_id=imports.github_repository_id
        AND predecessor.commit_sha=imports.commit_sha
        AND predecessor.index_path=imports.index_path
        AND predecessor.canonical_source_r2_key=imports.canonical_source_r2_key
        AND predecessor.canonical_source_mirror_r2_key=imports.canonical_source_mirror_r2_key
        AND predecessor.canonical_source_sha256=imports.canonical_source_sha256
    ) THEN 1 ELSE 0 END AS predecessor_fence
  FROM collection_imports AS imports
  JOIN forge_releases AS releases ON releases.id=imports.forge_release_id
  JOIN github_repositories AS repositories ON repositories.github_repository_id=imports.github_repository_id
  JOIN github_installations AS installations ON installations.installation_id=repositories.installation_id
  WHERE imports.id=?`;

function validText(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function contentAddressedKey(value: string | null, digest: string | null): value is string {
  return digest !== null && DIGEST.test(digest) && value === `snapshots/objects/${digest}`;
}

function exactArchiveKey(importId: string, commitSha: string, value: string | null): value is string {
  return value === `imports/${importId}/${commitSha}.tar.gz`;
}

/**
 * Load sensitive validation context from the authoritative database. Callers
 * must use the result only inside the current Workflow step closure; returning
 * it from `step.do` would copy private repository metadata into Workflow state.
 */
export async function hydrateValidationWorkflowContext(
  env: ForgeWorkerEnv,
  opaque: unknown,
  allowedStatuses: readonly ValidationImportStatus[],
  expectedSourceKind?: ValidationSourceKind,
): Promise<HydratedValidationWorkflowContext> {
  const parameters = parseValidationWorkflowParameters(opaque);
  if (allowedStatuses.length < 1) throw new TypeError("Validation Workflow status fence is empty.");
  const stored = await env.CORE_DB.prepare(HYDRATE_VALIDATION_WORKFLOW_SQL)
    .bind(parameters.importId).first<StoredValidationContext>();
  if (
    !stored
    || !UUID.test(stored.organizer_user_id)
    || !Number.isSafeInteger(stored.github_repository_id) || stored.github_repository_id < 1
    || !COMMIT.test(stored.commit_sha)
    || !INDEX_PATH.test(stored.index_path) || stored.index_path.length > 512
    || stored.forge_release_id !== parameters.expectedReleaseId
    || stored.release_manifest_sha256 !== parameters.expectedManifestSha256
    || !allowedStatuses.includes(stored.status as ValidationImportStatus)
    || (stored.source_kind !== "github-archive" && stored.source_kind !== "canonical-successor")
    || (expectedSourceKind !== undefined && stored.source_kind !== expectedSourceKind)
  ) throw new Error("Validation Workflow reference does not match its immutable import row.");

  const common: ValidationWorkflowCommonContext = {
    ...parameters,
    organizerUserId: stored.organizer_user_id,
    githubRepositoryId: stored.github_repository_id,
    commitSha: stored.commit_sha,
    indexPath: stored.index_path,
    status: stored.status as ValidationImportStatus,
  };

  if (stored.source_kind === "github-archive") {
    if (
      stored.predecessor_import_id !== null
      || stored.canonical_source_r2_key !== null
      || stored.canonical_source_mirror_r2_key !== null
      || stored.canonical_source_sha256 !== null
      || !Number.isSafeInteger(stored.installation_id) || stored.installation_id < 1
      || stored.repository_authorization_status !== "authorized"
      || stored.installation_status !== "active"
      || stored.installed_by_user_id !== stored.organizer_user_id
      || !validText(stored.owner_login, 100)
      || !validText(stored.repository_name, 100)
      || stored.archive_disposition !== "pending"
      || (stored.archive_r2_key !== null && !exactArchiveKey(parameters.importId, stored.commit_sha, stored.archive_r2_key))
      || (stored.archive_r2_key === null && stored.status !== "queued")
    ) throw new Error("GitHub archive validation context lost its repository or archive fence.");
    return {
      ...common,
      source: {
        kind: "github-archive",
        installationId: stored.installation_id,
        expectedOwner: stored.owner_login,
        expectedRepository: stored.repository_name,
        ...(stored.archive_r2_key === null ? {} : { archiveR2Key: stored.archive_r2_key }),
      },
    };
  }

  const canonicalDigest = stored.canonical_source_sha256;
  if (
    stored.predecessor_fence !== 1
    || stored.predecessor_import_id === null || !UUID.test(stored.predecessor_import_id)
    || canonicalDigest === null
    || !contentAddressedKey(stored.canonical_source_r2_key, canonicalDigest)
    || stored.canonical_source_mirror_r2_key !== stored.canonical_source_r2_key
    || stored.archive_r2_key !== null
    || stored.archive_disposition !== "deleted"
  ) throw new Error("Canonical successor validation context lost its published predecessor fence.");
  return {
    ...common,
    source: {
      kind: "canonical-successor",
      predecessorImportId: stored.predecessor_import_id,
      canonicalSourceR2Key: stored.canonical_source_r2_key,
      canonicalSourceMirrorR2Key: stored.canonical_source_r2_key,
      canonicalSourceSha256: canonicalDigest,
    },
  };
}

/** The only hydrated value that a Workflow step is allowed to persist. */
export function validationWorkflowStepMarker(context: HydratedValidationWorkflowContext): ValidationWorkflowStepMarker {
  return { sourceKind: context.source.kind };
}
