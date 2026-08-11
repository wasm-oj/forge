import { parseAttemptToken } from "./validation-contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const NORMALIZED_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000-\u001f\u007f]+$/;
const UUID_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SOURCE_R2_KEY = new RegExp(`^sources/(${UUID_SEGMENT})/(${UUID_SEGMENT})\\.([0-9a-f]{64})\\.json$`);

interface ContainerJobBase {
  readonly jobId: string;
  readonly attempt: number;
  readonly attemptToken: string;
  readonly expectedReleaseId: string;
  readonly expectedManifestSha256: string;
  readonly expectedContainerIdentitySha256: string;
}

export type SubmissionExecuteRequest = ContainerJobBase & {
  readonly kind: "submission";
  readonly submissionId: string;
  readonly sourceOwnerId: string;
  readonly sourceR2Key: string;
  readonly sourceSha256: string;
  readonly judgeR2Key: string;
  readonly judgeSha256: string;
  readonly expectedProblemBundleDigest: string;
};

export type ValidationExecuteRequest = ContainerJobBase & {
  readonly kind: "validation";
  readonly outputPrefix: "snapshots/objects";
  readonly forgeReleaseId: string;
  readonly githubRepositoryId: number;
  readonly commitSha: string;
  readonly indexPath: string;
  readonly source:
    | { readonly kind: "github-archive"; readonly archiveR2Key: string }
    | {
      readonly kind: "canonical-successor";
      readonly predecessorImportId: string;
      readonly canonicalSourceR2Key: string;
      readonly canonicalSourceSha256: string;
    };
};

export type ExecuteRequest = SubmissionExecuteRequest | ValidationExecuteRequest;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new TypeError(`${label} has an invalid shape.`);
}

function patterned(value: unknown, pattern: RegExp, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function base(value: Record<string, unknown>): ContainerJobBase {
  const jobId = patterned(value.jobId, UUID, "container jobId", 36);
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1 || (value.attempt as number) > 2) throw new TypeError("container attempt is invalid.");
  return {
    jobId,
    attempt: value.attempt as number,
    attemptToken: parseAttemptToken(value.attemptToken),
    expectedReleaseId: patterned(value.expectedReleaseId, UUID, "container expectedReleaseId", 36),
    expectedManifestSha256: patterned(value.expectedManifestSha256, DIGEST, "container expectedManifestSha256", 64),
    expectedContainerIdentitySha256: patterned(value.expectedContainerIdentitySha256, DIGEST, "container expectedContainerIdentitySha256", 64),
  };
}

export function parseExecuteRequest(value: unknown): ExecuteRequest {
  const input = object(value, "container job");
  if (input.kind === "submission") {
    exact(input, ["attempt", "attemptToken", "expectedContainerIdentitySha256", "expectedManifestSha256", "expectedProblemBundleDigest", "expectedReleaseId", "jobId", "judgeR2Key", "judgeSha256", "kind", "sourceOwnerId", "sourceR2Key", "sourceSha256", "submissionId"], "submission container job");
    const parsedBase = base(input);
    const submissionId = patterned(input.submissionId, UUID, "container submissionId", 36);
    if (submissionId !== parsedBase.jobId) throw new TypeError("container submission identity is inconsistent.");
    const sourceSha256 = patterned(input.sourceSha256, DIGEST, "container sourceSha256", 64);
    const sourceOwnerId = patterned(input.sourceOwnerId, UUID, "container sourceOwnerId", 36);
    const sourceR2Key = patterned(input.sourceR2Key, SOURCE_R2_KEY, "container sourceR2Key", 1024);
    const sourceMatch = SOURCE_R2_KEY.exec(sourceR2Key);
    if (sourceMatch?.[1] !== sourceOwnerId || sourceMatch[2] !== submissionId || sourceMatch[3] !== sourceSha256) {
      throw new TypeError("container source key is not bound to its submission and digest.");
    }
    const judgeSha256 = patterned(input.judgeSha256, DIGEST, "container judgeSha256", 64);
    if (input.judgeR2Key !== `snapshots/objects/${judgeSha256}`) throw new TypeError("container judge key is not content addressed.");
    return {
      ...parsedBase,
      kind: "submission",
      submissionId,
      sourceOwnerId,
      sourceR2Key,
      sourceSha256,
      judgeR2Key: input.judgeR2Key,
      judgeSha256,
      expectedProblemBundleDigest: patterned(input.expectedProblemBundleDigest, DIGEST, "container expectedProblemBundleDigest", 64),
    };
  }
  if (input.kind === "validation") {
    exact(input, ["attempt", "attemptToken", "commitSha", "expectedContainerIdentitySha256", "expectedManifestSha256", "expectedReleaseId", "forgeReleaseId", "githubRepositoryId", "indexPath", "jobId", "kind", "outputPrefix", "source"], "validation container job");
    const parsedBase = base(input);
    if (input.forgeReleaseId !== parsedBase.expectedReleaseId) throw new TypeError("validation release identity is inconsistent.");
    if (input.outputPrefix !== "snapshots/objects") throw new TypeError("validation output prefix is invalid.");
    if (!Number.isSafeInteger(input.githubRepositoryId) || (input.githubRepositoryId as number) < 1) throw new TypeError("validation repository identity is invalid.");
    const commitSha = patterned(input.commitSha, COMMIT, "validation commitSha", 40);
    const indexPath = patterned(input.indexPath, NORMALIZED_PATH, "validation indexPath", 512);
    const source = object(input.source, "validation container source");
    if (source.kind === "github-archive") {
      exact(source, ["archiveR2Key", "kind"], "validation GitHub archive source");
      const expected = `imports/${parsedBase.jobId}/${commitSha}.tar.gz`;
      if (source.archiveR2Key !== expected) throw new TypeError("validation archive key is not bound to the immutable import.");
      return {
        ...parsedBase,
        kind: "validation",
        outputPrefix: "snapshots/objects",
        forgeReleaseId: parsedBase.expectedReleaseId,
        githubRepositoryId: input.githubRepositoryId as number,
        commitSha,
        indexPath,
        source: { kind: "github-archive", archiveR2Key: expected },
      };
    }
    if (source.kind === "canonical-successor") {
      exact(source, ["canonicalSourceR2Key", "canonicalSourceSha256", "kind", "predecessorImportId"], "validation canonical successor source");
      const canonicalSourceSha256 = patterned(source.canonicalSourceSha256, DIGEST, "validation canonical source digest", 64);
      if (source.canonicalSourceR2Key !== `snapshots/objects/${canonicalSourceSha256}`) throw new TypeError("validation canonical source key is not content addressed.");
      return {
        ...parsedBase,
        kind: "validation",
        outputPrefix: "snapshots/objects",
        forgeReleaseId: parsedBase.expectedReleaseId,
        githubRepositoryId: input.githubRepositoryId as number,
        commitSha,
        indexPath,
        source: {
          kind: "canonical-successor",
          predecessorImportId: patterned(source.predecessorImportId, UUID, "validation predecessorImportId", 36),
          canonicalSourceR2Key: source.canonicalSourceR2Key,
          canonicalSourceSha256,
        },
      };
    }
    throw new TypeError("validation container source kind is unsupported.");
  }
  throw new TypeError("container job kind is unsupported.");
}
