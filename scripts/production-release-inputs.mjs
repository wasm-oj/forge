import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBytes, parseCanonicalJsonBytes } from "../src/core/canonical-json.ts";
import {
  WASM_OJ_RUNTIME_IDENTITY_SHA256,
  runtimeIdentityBytes,
} from "../src/core/runtime-identity.ts";
import { computeFileTreeInventory } from "../container/tree-digest.mjs";
import { verifyOciTagVerificationFile } from "./oci-release-image.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;
const PRODUCTION_RELEASE_INPUTS_SCHEMA = "wasm-oj-v2/production-release-inputs";
const RELEASE_CHECK_EVIDENCE_SCHEMA = "wasm-oj-v2/release-check-evidence";
const RECORD_KINDS = Object.freeze({
  audit: "file",
  conformance: "file",
  containerIdentity: "file",
  costBaseline: "file",
  costCalibration: "file",
  costProfiles: "file",
  dockerfile: "file",
  licenses: "tree",
  lock: "file",
  migrations: "tree",
  npmPackage: "file",
  ociEvidence: "tree",
  runtimeCore: "file",
  runtimeIdentity: "file",
  sbom: "file",
  staticAssets: "tree",
  tests: "file",
  toolchains: "tree",
  wasmer: "file",
  workerBundle: "tree",
});

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function exact(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function string(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function canonicalRelativePath(value, label) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value !== value.normalize("NFC")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\\")
    || value.split("/").some((part) => part.length < 1 || part === "." || part === ".." || /[\u0000-\u001f\u007f]/u.test(part))
  ) throw new TypeError(`${label} must be a canonical relative path.`);
  return value;
}

function safePath(root, relative) {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, ...relative.split("/"));
  if (absolute === absoluteRoot || !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new TypeError("Release input path escapes its bundle root.");
  }
  return absolute;
}

async function hashFile(pathname) {
  const before = await lstat(pathname, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Release input must be a regular file.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(pathname)) hash.update(chunk);
  const after = await lstat(pathname, { bigint: true });
  if (
    !after.isFile()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mode !== after.mode
    || before.mtimeNs !== after.mtimeNs
  ) throw new Error("Release input file changed while it was hashed.");
  const bytes = Number(after.size);
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("Release input file has an invalid size.");
  return { bytes, sha256: hash.digest("hex") };
}

export async function describeReleaseInput(root, relative, kind) {
  canonicalRelativePath(relative, "release input path");
  const pathname = safePath(root, relative);
  if (kind === "file") {
    const file = await hashFile(pathname);
    return Object.freeze({ kind, path: relative, ...file });
  }
  if (kind !== "tree") throw new TypeError("Release input kind must be file or tree.");
  const inventory = await computeFileTreeInventory(pathname);
  const bytes = inventory.entries.reduce((total, entry) => total + ("bytes" in entry ? entry.bytes : 0), 0);
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("Release input tree has an invalid size.");
  return Object.freeze({
    bytes,
    entries: inventory.entries.length,
    kind,
    path: relative,
    sha256: inventory.rootSha256,
  });
}

export async function copyReleaseInput(source, outputRoot, relative, kind) {
  canonicalRelativePath(relative, "release input destination");
  const destination = safePath(outputRoot, relative);
  if (kind === "file") {
    const sourceDescriptor = await hashFile(source);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await chmod(destination, 0o644);
    const descriptor = await describeReleaseInput(outputRoot, relative, kind);
    if (descriptor.bytes !== sourceDescriptor.bytes || descriptor.sha256 !== sourceDescriptor.sha256) {
      throw new Error("Copied release input does not match its source bytes.");
    }
    return descriptor;
  }
  if (kind !== "tree") throw new TypeError("Release input kind must be file or tree.");
  const sourceInventory = await computeFileTreeInventory(source);
  await mkdir(destination, { recursive: true });
  for (const entry of sourceInventory.entries) {
    if (!("sha256" in entry)) throw new Error("Release input trees cannot contain symlinks.");
    const target = safePath(destination, entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(safePath(source, entry.path), target);
    await chmod(target, entry.executable ? 0o755 : 0o644);
  }
  const descriptor = await describeReleaseInput(outputRoot, relative, kind);
  if (descriptor.sha256 !== sourceInventory.rootSha256 || descriptor.entries !== sourceInventory.entries.length) {
    throw new Error("Copied release input tree does not match its source inventory.");
  }
  return descriptor;
}

function parseInputRecord(value, expectedKind, label) {
  const item = object(value, label);
  exact(item, expectedKind === "tree"
    ? ["bytes", "entries", "kind", "path", "sha256"]
    : ["bytes", "kind", "path", "sha256"], [], label);
  if (item.kind !== expectedKind) throw new TypeError(`${label}.kind is invalid.`);
  if (!Number.isSafeInteger(item.bytes) || item.bytes < 1) throw new TypeError(`${label}.bytes is invalid.`);
  if (typeof item.sha256 !== "string" || !SHA256.test(item.sha256)) throw new TypeError(`${label}.sha256 is invalid.`);
  if (expectedKind === "tree" && (!Number.isSafeInteger(item.entries) || item.entries < 1)) {
    throw new TypeError(`${label}.entries is invalid.`);
  }
  return Object.freeze({
    bytes: item.bytes,
    ...(expectedKind === "tree" ? { entries: item.entries } : {}),
    kind: expectedKind,
    path: canonicalRelativePath(item.path, `${label}.path`),
    sha256: item.sha256,
  });
}

function sourceRepository(value) {
  if (typeof value !== "string") throw new TypeError("release inputs source.repository is invalid.");
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.hostname !== "github.com"
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname.split("/").filter(Boolean).length !== 2
  ) throw new TypeError("release inputs source.repository must identify one credential-free GitHub repository.");
  return url.toString().replace(/\/$/u, "");
}

function timestamp(value) {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new TypeError("release inputs createdAt must be a canonical ISO timestamp.");
  }
  return value;
}

function parseBaseImages(value) {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError("release inputs baseImages are invalid.");
  const expectedStages = ["node-build", "rust-build", "judge"];
  return value.map((entry, index) => {
    const image = object(entry, `release inputs base image ${index}`);
    exact(image, ["digest", "image", "stage"], [], `release inputs base image ${index}`);
    if (
      image.stage !== expectedStages[index]
      || typeof image.image !== "string"
      || !IDENTITY.test(image.image)
      || typeof image.digest !== "string"
      || !OCI_DIGEST.test(image.digest)
    ) throw new TypeError("release inputs baseImages are invalid.");
    return Object.freeze({ stage: image.stage, image: image.image, digest: image.digest });
  });
}

export function parseProductionReleaseInputs(value) {
  const inputs = object(value, "production release inputs");
  exact(inputs, ["build", "container", "provenance", "records", "release", "schema", "source"], [], "production release inputs");
  if (inputs.schema !== PRODUCTION_RELEASE_INPUTS_SCHEMA) throw new TypeError("Production release input schema is unsupported.");

  const release = object(inputs.release, "release inputs release");
  exact(release, ["createdAt", "expectedCurrentReleaseId", "releaseId", "version"], [], "release inputs release");
  string(release.releaseId, UUID, "release inputs releaseId");
  string(release.version, SEMVER, "release inputs version");
  if (release.expectedCurrentReleaseId !== null) string(release.expectedCurrentReleaseId, UUID, "release inputs expectedCurrentReleaseId");

  const source = object(inputs.source, "release inputs source");
  exact(source, ["commit", "repository", "sourceTreeSha256"], ["tag"], "release inputs source");
  string(source.commit, GIT_COMMIT, "release inputs source.commit");
  string(source.sourceTreeSha256, SHA256, "release inputs source.sourceTreeSha256");
  if (source.tag !== undefined) string(source.tag, VERSION, "release inputs source.tag");

  const build = object(inputs.build, "release inputs build");
  exact(build, ["nodeVersion", "pnpmVersion", "rustVersion", "wasmerVersion"], [], "release inputs build");
  for (const key of ["nodeVersion", "pnpmVersion", "rustVersion", "wasmerVersion"]) string(build[key], VERSION, `release inputs build.${key}`);

  const container = object(inputs.container, "release inputs container");
  exact(container, ["baseImages", "digest", "platform", "registry", "tag"], [], "release inputs container");
  if (
    typeof container.registry !== "string"
    || !IDENTITY.test(container.registry)
    || container.platform !== "linux/amd64"
    || container.tag !== release.releaseId
  ) throw new TypeError("release inputs container identity is invalid.");
  string(container.digest, OCI_DIGEST, "release inputs container.digest");

  const provenance = object(inputs.provenance, "release inputs provenance");
  exact(provenance, ["issuer", "subject"], [], "release inputs provenance");
  string(provenance.issuer, IDENTITY, "release inputs provenance.issuer");
  string(provenance.subject, IDENTITY, "release inputs provenance.subject");

  const recordsValue = object(inputs.records, "release inputs records");
  exact(recordsValue, Object.keys(RECORD_KINDS), [], "release inputs records");
  const records = Object.fromEntries(Object.entries(RECORD_KINDS).map(([role, kind]) => [
    role,
    parseInputRecord(recordsValue[role], kind, `release inputs records.${role}`),
  ]));
  if (new Set(Object.values(records).map((record) => record.path)).size !== Object.keys(records).length) {
    throw new TypeError("Release input roles must use distinct paths.");
  }

  return Object.freeze({
    schema: PRODUCTION_RELEASE_INPUTS_SCHEMA,
    release: Object.freeze({
      createdAt: timestamp(release.createdAt),
      expectedCurrentReleaseId: release.expectedCurrentReleaseId,
      releaseId: release.releaseId,
      version: release.version,
    }),
    source: Object.freeze({
      commit: source.commit,
      repository: sourceRepository(source.repository),
      sourceTreeSha256: source.sourceTreeSha256,
      ...(source.tag === undefined ? {} : { tag: source.tag }),
    }),
    build: Object.freeze({
      nodeVersion: build.nodeVersion,
      pnpmVersion: build.pnpmVersion,
      rustVersion: build.rustVersion,
      wasmerVersion: build.wasmerVersion,
    }),
    container: Object.freeze({
      baseImages: Object.freeze(parseBaseImages(container.baseImages)),
      digest: container.digest,
      platform: "linux/amd64",
      registry: container.registry,
      tag: container.tag,
    }),
    provenance: Object.freeze({ issuer: provenance.issuer, subject: provenance.subject }),
    records: Object.freeze(records),
  });
}

export function productionReleaseInputBytes(value) {
  return canonicalJsonBytes(parseProductionReleaseInputs(value));
}

export function releaseCheckEvidenceBytes(check) {
  if (!["conformance", "cost-baseline", "cost-calibration", "cost-profiles"].includes(check)) {
    throw new TypeError("Release check identity is unsupported.");
  }
  return canonicalJsonBytes({
    check,
    schema: RELEASE_CHECK_EVIDENCE_SCHEMA,
    status: "not-run",
  });
}

export function parseDockerfileBaseImages(bytes) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const stages = { build: "node-build", "runtime-build": "rust-build", judge: "judge" };
  const matches = [...source.matchAll(/^FROM ([^\s@]+)@(sha256:[0-9a-f]{64}) AS ([a-z-]+)$/gmu)];
  if (matches.length !== 3 || matches.some((match) => !Object.hasOwn(stages, match[3]))) {
    throw new TypeError("Dockerfile must contain exactly the three pinned release stages.");
  }
  return matches.map((match) => ({ stage: stages[match[3]], image: match[1], digest: match[2] }));
}

export function assertRuntimeIdentityBytes(bytes) {
  const expected = Buffer.from(runtimeIdentityBytes());
  if (!Buffer.from(bytes).equals(expected) || createHash("sha256").update(bytes).digest("hex") !== WASM_OJ_RUNTIME_IDENTITY_SHA256) {
    throw new Error("Release runtime identity bytes do not match this build.");
  }
}

export async function verifyProductionReleaseInputs(inputPath) {
  const inputBytes = await readFile(inputPath);
  const inputs = parseProductionReleaseInputs(parseCanonicalJsonBytes(inputBytes, "production release inputs"));
  const root = path.dirname(inputPath);
  for (const [role, record] of Object.entries(inputs.records)) {
    const actual = await describeReleaseInput(root, record.path, record.kind);
    if (
      actual.kind !== record.kind
      || actual.path !== record.path
      || actual.bytes !== record.bytes
      || actual.sha256 !== record.sha256
      || (record.kind === "tree" && actual.entries !== record.entries)
    ) {
      throw new Error(`Release input '${role}' does not match its saved bytes.`);
    }
  }
  assertRuntimeIdentityBytes(await readFile(safePath(root, inputs.records.runtimeIdentity.path)));
  const dockerBaseImages = parseDockerfileBaseImages(await readFile(safePath(root, inputs.records.dockerfile.path)));
  if (JSON.stringify(dockerBaseImages) !== JSON.stringify(inputs.container.baseImages)) {
    throw new Error("Release Dockerfile base-image pins do not match the generated inputs.");
  }
  const ociEvidencePath = safePath(root, `${inputs.records.ociEvidence.path}/evidence.json`);
  await verifyOciTagVerificationFile(ociEvidencePath, {
    reference: `${inputs.container.registry}:${inputs.container.tag}`,
    digest: inputs.container.digest,
  });
  return { inputs, root };
}

export const PRODUCTION_RELEASE_INPUT_RECORD_KINDS = RECORD_KINDS;
