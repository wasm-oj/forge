import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBytes, parseCanonicalJsonBytes } from "../src/core/canonical-json.ts";

const OCI_TAG_VERIFICATION_SCHEMA = "wasm-oj-v2/oci-tag-verification";

const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_OCI_DOCUMENT_BYTES = 1024 * 1024;
const OCI_INDEX_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const OCI_MANIFEST_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const MANIFEST_ACCEPT = [...OCI_INDEX_TYPES, ...OCI_MANIFEST_TYPES].join(", ");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function digest(value, label) {
  if (typeof value !== "string" || !OCI_DIGEST.test(value)) {
    throw new TypeError(`${label} must be a lowercase sha256 OCI digest.`);
  }
  return value;
}

function mediaType(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new TypeError(`${label} has an unsupported media type.`);
  }
  return value;
}

function parseJson(bytes, label) {
  try {
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), label);
  } catch (error) {
    throw new TypeError(`${label} is not valid UTF-8 JSON.`, { cause: error });
  }
}

export function parseTaggedOciReference(value) {
  if (typeof value !== "string" || value.includes("://") || value.includes("@")) {
    throw new TypeError("OCI reference must be one credential-free registry/repository:tag value.");
  }
  const slash = value.indexOf("/");
  const colon = value.lastIndexOf(":");
  if (slash < 1 || colon <= slash + 1 || colon === value.length - 1) {
    throw new TypeError("OCI reference must include a registry, repository, and non-empty tag.");
  }
  const registry = value.slice(0, slash);
  const repository = value.slice(slash + 1, colon);
  const tag = value.slice(colon + 1);
  let url;
  try {
    url = new URL(`https://${registry}`);
  } catch (error) {
    throw new TypeError("OCI registry is invalid.", { cause: error });
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?$/u.test(registry)
    || repository.split("/").some((part) => !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(part))
    || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u.test(tag)
    || tag === "latest"
  ) {
    throw new TypeError("OCI reference is not canonical or uses the forbidden latest tag.");
  }
  return Object.freeze({ registry, repository, tag, reference: value });
}

function descriptor(pathname, bytes, mediaTypeValue) {
  return Object.freeze({
    bytes: bytes.byteLength,
    mediaType: mediaTypeValue,
    path: pathname,
    sha256: sha256(bytes),
  });
}

async function boundedResponseBytes(response, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}.`);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_OCI_DOCUMENT_BYTES)) {
    throw new Error(`${label} exceeds the bounded OCI document size.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_OCI_DOCUMENT_BYTES) {
    throw new Error(`${label} has an invalid size.`);
  }
  return bytes;
}

async function fetchDigestDocument({ fetchImpl, baseUrl, repository, reference, authorization, accept, label }) {
  const response = await fetchImpl(
    `${baseUrl}/v2/${repository}/manifests/${encodeURIComponent(reference)}`,
    {
      headers: { Accept: accept, Authorization: authorization },
      redirect: "error",
    },
  );
  const bytes = await boundedResponseBytes(response, label);
  const actualDigest = `sha256:${sha256(bytes)}`;
  const headerDigest = response.headers.get("docker-content-digest");
  if (headerDigest !== actualDigest) {
    throw new Error(`${label} Docker-Content-Digest does not match its exact response bytes.`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  return { bytes, digest: actualDigest, contentType };
}

async function fetchConfigBlob({ fetchImpl, baseUrl, repository, expectedDigest, authorization }) {
  const response = await fetchImpl(
    `${baseUrl}/v2/${repository}/blobs/${expectedDigest}`,
    { headers: { Authorization: authorization }, redirect: "error" },
  );
  const bytes = await boundedResponseBytes(response, "OCI image config fetch");
  if (`sha256:${sha256(bytes)}` !== expectedDigest) {
    throw new Error("OCI image config bytes do not match the platform manifest digest.");
  }
  const headerDigest = response.headers.get("docker-content-digest");
  if (headerDigest !== null && headerDigest !== expectedDigest) {
    throw new Error("OCI image config Docker-Content-Digest is inconsistent.");
  }
  return bytes;
}

/** Resolve one immutable release tag and preserve the exact OCI bytes used as proof. */
export async function resolveOciTag({
  reference,
  expectedDigest,
  credentials,
  outputDirectory,
  fetchImpl = fetch,
}) {
  const parsedReference = parseTaggedOciReference(reference);
  digest(expectedDigest, "expectedDigest");
  const credential = record(credentials, "registry credentials");
  exactKeys(credential, ["password", "username"], "registry credentials");
  if (
    typeof credential.username !== "string"
    || credential.username.length < 1
    || typeof credential.password !== "string"
    || credential.password.length < 1
  ) throw new TypeError("Registry credentials are incomplete.");
  const authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
  const baseUrl = `https://${parsedReference.registry}`;
  const tagged = await fetchDigestDocument({
    fetchImpl,
    baseUrl,
    repository: parsedReference.repository,
    reference: parsedReference.tag,
    authorization,
    accept: MANIFEST_ACCEPT,
    label: "OCI tag resolution",
  });
  if (tagged.digest !== expectedDigest) {
    throw new Error(`OCI tag resolved to ${tagged.digest}, expected ${expectedDigest}.`);
  }
  const taggedJson = parseJson(tagged.bytes, "OCI tagged manifest");
  const taggedMediaType = mediaType(
    taggedJson.mediaType ?? tagged.contentType,
    new Set([...OCI_INDEX_TYPES, ...OCI_MANIFEST_TYPES]),
    "OCI tagged manifest",
  );

  let platformBytes;
  let platformDigest;
  let platformMediaType;
  if (OCI_INDEX_TYPES.has(taggedMediaType)) {
    if (!Array.isArray(taggedJson.manifests)) throw new TypeError("OCI image index is missing manifests.");
    const matches = taggedJson.manifests.filter((value) => {
      const item = record(value, "OCI image index descriptor");
      return item.platform?.os === "linux"
        && item.platform?.architecture === "amd64"
        && (item.platform?.variant === undefined || item.platform.variant === "");
    });
    if (matches.length !== 1) throw new Error("OCI image index must contain exactly one linux/amd64 manifest.");
    const selected = record(matches[0], "OCI linux/amd64 descriptor");
    platformDigest = digest(selected.digest, "OCI linux/amd64 descriptor.digest");
    platformMediaType = mediaType(selected.mediaType, OCI_MANIFEST_TYPES, "OCI linux/amd64 descriptor");
    const fetched = await fetchDigestDocument({
      fetchImpl,
      baseUrl,
      repository: parsedReference.repository,
      reference: platformDigest,
      authorization,
      accept: [...OCI_MANIFEST_TYPES].join(", "),
      label: "OCI linux/amd64 manifest fetch",
    });
    if (fetched.digest !== platformDigest) throw new Error("OCI platform descriptor does not match its manifest bytes.");
    platformBytes = fetched.bytes;
    const fetchedMediaType = parseJson(platformBytes, "OCI linux/amd64 manifest").mediaType ?? fetched.contentType;
    if (fetchedMediaType !== platformMediaType) throw new Error("OCI platform manifest media type is inconsistent.");
  } else {
    platformBytes = tagged.bytes;
    platformDigest = tagged.digest;
    platformMediaType = mediaType(taggedMediaType, OCI_MANIFEST_TYPES, "OCI platform manifest");
  }

  const platformJson = parseJson(platformBytes, "OCI platform manifest");
  const config = record(platformJson.config, "OCI platform manifest config");
  const configDigest = digest(config.digest, "OCI platform manifest config.digest");
  const configBytes = await fetchConfigBlob({
    fetchImpl,
    baseUrl,
    repository: parsedReference.repository,
    expectedDigest: configDigest,
    authorization,
  });
  const configJson = parseJson(configBytes, "OCI image config");
  if (configJson.os !== "linux" || configJson.architecture !== "amd64") {
    throw new Error("OCI image config is not linux/amd64.");
  }

  await mkdir(outputDirectory, { recursive: false });
  const tagPath = "tag-manifest.json";
  const platformPath = platformBytes === tagged.bytes ? tagPath : "platform-manifest.json";
  const configPath = "config.json";
  const evidence = {
    schema: OCI_TAG_VERIFICATION_SCHEMA,
    digest: tagged.digest,
    platform: "linux/amd64",
    platformDigest,
    reference: parsedReference.reference,
    documents: {
      config: descriptor(configPath, configBytes, "application/vnd.oci.image.config.v1+json"),
      platformManifest: descriptor(platformPath, platformBytes, platformMediaType),
      tagManifest: descriptor(tagPath, tagged.bytes, taggedMediaType),
    },
  };
  const writes = [
    writeFile(path.join(outputDirectory, tagPath), tagged.bytes, { flag: "wx" }),
    writeFile(path.join(outputDirectory, configPath), configBytes, { flag: "wx" }),
    writeFile(path.join(outputDirectory, "evidence.json"), canonicalJsonBytes(evidence), { flag: "wx" }),
  ];
  if (platformPath !== tagPath) writes.push(writeFile(path.join(outputDirectory, platformPath), platformBytes, { flag: "wx" }));
  await Promise.all(writes);
  return Object.freeze(evidence);
}

function parseEvidenceDescriptor(value, label) {
  const item = record(value, label);
  exactKeys(item, ["bytes", "mediaType", "path", "sha256"], label);
  if (!Number.isSafeInteger(item.bytes) || item.bytes < 2) throw new TypeError(`${label}.bytes is invalid.`);
  if (typeof item.path !== "string" || !/^[a-z][a-z0-9-]*\.json$/u.test(item.path)) {
    throw new TypeError(`${label}.path is invalid.`);
  }
  if (typeof item.sha256 !== "string" || !SHA256.test(item.sha256)) throw new TypeError(`${label}.sha256 is invalid.`);
  if (typeof item.mediaType !== "string" || item.mediaType.length < 1) throw new TypeError(`${label}.mediaType is invalid.`);
  return { bytes: item.bytes, mediaType: item.mediaType, path: item.path, sha256: item.sha256 };
}

export function parseOciTagVerification(value) {
  const evidence = record(value, "OCI tag verification evidence");
  exactKeys(evidence, ["digest", "documents", "platform", "platformDigest", "reference", "schema"], "OCI tag verification evidence");
  if (evidence.schema !== OCI_TAG_VERIFICATION_SCHEMA || evidence.platform !== "linux/amd64") {
    throw new TypeError("OCI tag verification evidence uses another schema or platform.");
  }
  const documents = record(evidence.documents, "OCI tag verification documents");
  exactKeys(documents, ["config", "platformManifest", "tagManifest"], "OCI tag verification documents");
  return {
    schema: OCI_TAG_VERIFICATION_SCHEMA,
    digest: digest(evidence.digest, "OCI evidence digest"),
    platform: "linux/amd64",
    platformDigest: digest(evidence.platformDigest, "OCI evidence platformDigest"),
    reference: parseTaggedOciReference(evidence.reference).reference,
    documents: {
      config: parseEvidenceDescriptor(documents.config, "OCI config evidence"),
      platformManifest: parseEvidenceDescriptor(documents.platformManifest, "OCI platform manifest evidence"),
      tagManifest: parseEvidenceDescriptor(documents.tagManifest, "OCI tag manifest evidence"),
    },
  };
}

/** Re-hash every saved OCI response before it can authorize release configuration. */
export async function verifyOciTagVerificationFile(evidencePath, expected = {}) {
  const evidenceBytes = await readFile(evidencePath);
  const evidence = parseOciTagVerification(parseCanonicalJsonBytes(evidenceBytes, "OCI tag verification evidence"));
  const root = path.dirname(evidencePath);
  for (const [name, item] of Object.entries(evidence.documents)) {
    const bytes = await readFile(path.join(root, item.path));
    if (bytes.byteLength !== item.bytes || sha256(bytes) !== item.sha256) {
      throw new Error(`Saved OCI ${name} bytes do not match their evidence descriptor.`);
    }
  }
  if (evidence.documents.tagManifest.sha256 !== evidence.digest.slice("sha256:".length)) {
    throw new Error("Saved OCI tag manifest bytes do not match the resolved digest.");
  }
  if (evidence.documents.platformManifest.sha256 !== evidence.platformDigest.slice("sha256:".length)) {
    throw new Error("Saved OCI platform manifest bytes do not match the platform digest.");
  }
  if (expected.reference !== undefined && evidence.reference !== expected.reference) {
    throw new Error("OCI verification evidence references another release tag.");
  }
  if (expected.digest !== undefined && evidence.digest !== expected.digest) {
    throw new Error("OCI verification evidence resolved another digest.");
  }
  return evidence;
}
