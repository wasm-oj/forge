import { canonicalJsonBytes, parseCanonicalJsonBytes } from "./core/canonical-json.ts";
import { FORGE_CONTRACT_VERSION, FORGE_SCHEMAS } from "./core/contract.ts";
import { FORGE_RUNTIME_IDENTITY_SHA256 } from "./core/runtime-identity.ts";
import { WEIGHTED_METER_MODEL } from "./core/resources.ts";
import { sha256Hex } from "./core/sha256.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;

export const FORGE_RELEASE_MANIFEST_SCHEMA = FORGE_SCHEMAS.releaseManifest;
export const FORGE_CONTAINER_PROTOCOL_VERSION = "forge-container-v1";

export interface ForgeReleaseManifest {
  readonly schema: typeof FORGE_RELEASE_MANIFEST_SCHEMA;
  readonly releaseId: string;
  readonly version: string;
  readonly forgeContract: typeof FORGE_CONTRACT_VERSION;
  readonly createdAt: string;
  readonly source: {
    readonly repository: string;
    readonly commit: string;
    readonly sourceTreeSha256: string;
    readonly tag?: string;
  };
  readonly build: {
    readonly nodeVersion: string;
    readonly pnpmVersion: string;
    readonly rustVersion: string;
    readonly lockSha256: string;
    readonly sbomSha256: string;
    readonly licensesSha256: string;
    readonly auditSha256: string;
  };
  readonly artifacts: {
    readonly npmPackage: ArtifactDigest;
    readonly workerBundle: ArtifactDigest;
    readonly staticAssets: ArtifactDigest;
    readonly containerImage: {
      readonly registry: string;
      readonly digest: string;
      readonly identitySha256: string;
      readonly platform: "linux/amd64";
      readonly dockerfileSha256: string;
      readonly baseImages: readonly {
        readonly stage: "node-build" | "rust-build" | "judge";
        readonly image: string;
        readonly digest: string;
      }[];
    };
  };
  readonly runtime: {
    readonly protocolVersion: typeof FORGE_CONTAINER_PROTOCOL_VERSION;
    readonly executionRootSha256: string;
    readonly rootSha256: string;
    readonly runtimeIdentitySha256: string;
    readonly runtimeCoreSha256: string;
    readonly wasmerVersion: string;
    readonly wasmerSha256: string;
    readonly compilerSha256: string;
    readonly runnerSha256: string;
  };
  readonly toolchains: {
    readonly rootSha256: string;
    readonly manifestSha256: string;
  };
  readonly cost: {
    readonly model: typeof WEIGHTED_METER_MODEL;
    readonly profileRootSha256: string;
    readonly baselineSha256: string;
  };
  readonly evidence: {
    readonly conformanceSha256: string;
    readonly testsSha256: string;
    readonly costCalibrationSha256: string;
  };
  readonly migrations: {
    readonly databaseSha256: string;
  };
  readonly provenance: {
    readonly issuer: string;
    readonly subject: string;
  };
}

export interface ArtifactDigest {
  readonly sha256: string;
  readonly bytes: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function version(value: unknown, label: string): string {
  if (typeof value !== "string" || !VERSION.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function artifact(value: unknown, label: string): ArtifactDigest {
  const item = record(value, label);
  exact(item, ["bytes", "sha256"], [], label);
  if (!Number.isSafeInteger(item.bytes) || (item.bytes as number) < 1) throw new TypeError(`${label}.bytes must be a positive safe integer.`);
  return { bytes: item.bytes as number, sha256: digest(item.sha256, `${label}.sha256`) };
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new TypeError("createdAt must be a canonical ISO timestamp.");
  return value;
}

function sourceRepository(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("source.repository must be a GitHub HTTPS URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError("source.repository must be a GitHub HTTPS URL.", { cause: error });
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash || url.pathname.split("/").filter(Boolean).length !== 2) {
    throw new TypeError("source.repository must identify one credential-free GitHub repository.");
  }
  return url.toString().replace(/\/$/, "");
}

export function parseForgeReleaseManifest(value: unknown): ForgeReleaseManifest {
  const manifest = record(value, "release manifest");
  exact(manifest, [
    "artifacts", "build", "cost", "createdAt", "evidence", "forgeContract", "migrations",
    "provenance", "releaseId", "runtime", "schema", "source", "toolchains", "version",
  ], [], "release manifest");
  if (manifest.schema !== FORGE_RELEASE_MANIFEST_SCHEMA) throw new TypeError("Release manifest schema is unsupported.");
  if (manifest.forgeContract !== FORGE_CONTRACT_VERSION) throw new TypeError("Release manifest uses another Forge contract.");
  if (typeof manifest.releaseId !== "string" || !UUID.test(manifest.releaseId)) throw new TypeError("releaseId must be a UUID.");
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) throw new TypeError("version must be semantic versioning.");

  const source = record(manifest.source, "source");
  exact(source, ["commit", "repository", "sourceTreeSha256"], ["tag"], "source");
  if (typeof source.commit !== "string" || !/^[0-9a-f]{40}$/.test(source.commit)) throw new TypeError("source.commit must be an exact Git commit SHA.");
  if (source.tag !== undefined && (typeof source.tag !== "string" || !VERSION.test(source.tag))) throw new TypeError("source.tag is invalid.");

  const build = record(manifest.build, "build");
  exact(build, ["auditSha256", "licensesSha256", "lockSha256", "nodeVersion", "pnpmVersion", "rustVersion", "sbomSha256"], [], "build");

  const artifacts = record(manifest.artifacts, "artifacts");
  exact(artifacts, ["containerImage", "npmPackage", "staticAssets", "workerBundle"], [], "artifacts");
  const container = record(artifacts.containerImage, "artifacts.containerImage");
  exact(container, ["baseImages", "digest", "dockerfileSha256", "identitySha256", "platform", "registry"], [], "artifacts.containerImage");
  if (typeof container.registry !== "string" || !IDENTITY.test(container.registry)) throw new TypeError("Container registry identity is invalid.");
  if (typeof container.digest !== "string" || !OCI_DIGEST.test(container.digest) || container.platform !== "linux/amd64") {
    throw new TypeError("Container image identity is invalid.");
  }
  if (!Array.isArray(container.baseImages) || container.baseImages.length !== 3) throw new TypeError("Container base image inventory is invalid.");
  const expectedStages = ["node-build", "rust-build", "judge"] as const;
  const baseImages = container.baseImages.map((value, index) => {
    const base = record(value, `container base image ${index}`);
    exact(base, ["digest", "image", "stage"], [], `container base image ${index}`);
    if (base.stage !== expectedStages[index] || typeof base.image !== "string" || !IDENTITY.test(base.image) || typeof base.digest !== "string" || !OCI_DIGEST.test(base.digest)) {
      throw new TypeError("Container base image inventory is invalid.");
    }
    return { stage: base.stage, image: base.image, digest: base.digest } as ForgeReleaseManifest["artifacts"]["containerImage"]["baseImages"][number];
  });

  const runtime = record(manifest.runtime, "runtime");
  exact(runtime, ["compilerSha256", "executionRootSha256", "protocolVersion", "rootSha256", "runnerSha256", "runtimeCoreSha256", "runtimeIdentitySha256", "wasmerSha256", "wasmerVersion"], [], "runtime");
  if (runtime.protocolVersion !== FORGE_CONTAINER_PROTOCOL_VERSION) throw new TypeError("Container protocol is unsupported.");
  if (runtime.runtimeIdentitySha256 !== FORGE_RUNTIME_IDENTITY_SHA256) throw new TypeError("Release runtime identity does not match this Forge build.");

  const toolchains = record(manifest.toolchains, "toolchains");
  exact(toolchains, ["manifestSha256", "rootSha256"], [], "toolchains");
  const cost = record(manifest.cost, "cost");
  exact(cost, ["baselineSha256", "model", "profileRootSha256"], [], "cost");
  if (cost.model !== WEIGHTED_METER_MODEL) throw new TypeError("Release cost model is unsupported.");
  const evidence = record(manifest.evidence, "evidence");
  exact(evidence, ["conformanceSha256", "costCalibrationSha256", "testsSha256"], [], "evidence");
  const migrations = record(manifest.migrations, "migrations");
  exact(migrations, ["databaseSha256"], [], "migrations");
  const provenance = record(manifest.provenance, "provenance");
  exact(provenance, ["issuer", "subject"], [], "provenance");
  if (typeof provenance.issuer !== "string" || !IDENTITY.test(provenance.issuer) || typeof provenance.subject !== "string" || !IDENTITY.test(provenance.subject)) {
    throw new TypeError("Release provenance identity is invalid.");
  }

  return {
    schema: FORGE_RELEASE_MANIFEST_SCHEMA,
    releaseId: manifest.releaseId,
    version: manifest.version,
    forgeContract: FORGE_CONTRACT_VERSION,
    createdAt: timestamp(manifest.createdAt),
    source: {
      repository: sourceRepository(source.repository),
      commit: source.commit,
      sourceTreeSha256: digest(source.sourceTreeSha256, "source.sourceTreeSha256"),
      ...(source.tag === undefined ? {} : { tag: source.tag as string }),
    },
    build: {
      nodeVersion: version(build.nodeVersion, "build.nodeVersion"),
      pnpmVersion: version(build.pnpmVersion, "build.pnpmVersion"),
      rustVersion: version(build.rustVersion, "build.rustVersion"),
      lockSha256: digest(build.lockSha256, "build.lockSha256"),
      sbomSha256: digest(build.sbomSha256, "build.sbomSha256"),
      licensesSha256: digest(build.licensesSha256, "build.licensesSha256"),
      auditSha256: digest(build.auditSha256, "build.auditSha256"),
    },
    artifacts: {
      npmPackage: artifact(artifacts.npmPackage, "artifacts.npmPackage"),
      workerBundle: artifact(artifacts.workerBundle, "artifacts.workerBundle"),
      staticAssets: artifact(artifacts.staticAssets, "artifacts.staticAssets"),
      containerImage: {
        registry: container.registry as string,
        digest: container.digest as string,
        identitySha256: digest(container.identitySha256, "artifacts.containerImage.identitySha256"),
        platform: "linux/amd64",
        dockerfileSha256: digest(container.dockerfileSha256, "artifacts.containerImage.dockerfileSha256"),
        baseImages,
      },
    },
    runtime: {
      protocolVersion: FORGE_CONTAINER_PROTOCOL_VERSION,
      executionRootSha256: digest(runtime.executionRootSha256, "runtime.executionRootSha256"),
      rootSha256: digest(runtime.rootSha256, "runtime.rootSha256"),
      runtimeIdentitySha256: FORGE_RUNTIME_IDENTITY_SHA256,
      runtimeCoreSha256: digest(runtime.runtimeCoreSha256, "runtime.runtimeCoreSha256"),
      wasmerVersion: version(runtime.wasmerVersion, "runtime.wasmerVersion"),
      wasmerSha256: digest(runtime.wasmerSha256, "runtime.wasmerSha256"),
      compilerSha256: digest(runtime.compilerSha256, "runtime.compilerSha256"),
      runnerSha256: digest(runtime.runnerSha256, "runtime.runnerSha256"),
    },
    toolchains: {
      rootSha256: digest(toolchains.rootSha256, "toolchains.rootSha256"),
      manifestSha256: digest(toolchains.manifestSha256, "toolchains.manifestSha256"),
    },
    cost: {
      model: WEIGHTED_METER_MODEL,
      profileRootSha256: digest(cost.profileRootSha256, "cost.profileRootSha256"),
      baselineSha256: digest(cost.baselineSha256, "cost.baselineSha256"),
    },
    evidence: {
      conformanceSha256: digest(evidence.conformanceSha256, "evidence.conformanceSha256"),
      testsSha256: digest(evidence.testsSha256, "evidence.testsSha256"),
      costCalibrationSha256: digest(evidence.costCalibrationSha256, "evidence.costCalibrationSha256"),
    },
    migrations: {
      databaseSha256: digest(migrations.databaseSha256, "migrations.databaseSha256"),
    },
    provenance: { issuer: provenance.issuer, subject: provenance.subject } as ForgeReleaseManifest["provenance"],
  };
}

export function createForgeReleaseManifest(value: ForgeReleaseManifest): ForgeReleaseManifest {
  return parseForgeReleaseManifest(value);
}

export function forgeReleaseManifestBytes(value: ForgeReleaseManifest): Uint8Array {
  return canonicalJsonBytes(parseForgeReleaseManifest(value));
}

export async function forgeReleaseManifestSha256(value: ForgeReleaseManifest): Promise<string> {
  return sha256Hex(forgeReleaseManifestBytes(value));
}

export async function verifyForgeReleaseManifestBytes(
  bytes: Uint8Array,
  expectedSha256?: string,
): Promise<ForgeReleaseManifest> {
  if (expectedSha256 !== undefined) {
    const expected = digest(expectedSha256, "expected release manifest digest");
    if (expected !== await sha256Hex(bytes)) throw new TypeError("Release manifest bytes do not match the expected digest.");
  }
  return parseForgeReleaseManifest(parseCanonicalJsonBytes(bytes, "release manifest"));
}
