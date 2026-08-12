import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseCanonicalJsonBytes } from "../src/core/canonical-json.ts";
import { parseReleaseManifest, releaseManifestBytes } from "../src/release-manifest.ts";
import { verifyOciTagVerificationFile } from "./oci-release-image.mjs";

const RELEASE_ID_PLACEHOLDER = "__WASM_OJ_RELEASE_ID__";
const MANIFEST_SHA256_PLACEHOLDER = "__WASM_OJ_RELEASE_MANIFEST_SHA256__";
const CONTAINER_DIGEST_PLACEHOLDER = "__WASM_OJ_CONTAINER_IMAGE_DIGEST__";
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_ACTIVATION_REQUEST_BYTES = 300 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function occurrences(source, token) {
  return source.split(token).length - 1;
}

export function decodeCanonicalBase64(value, label = "activation request") {
  if (typeof value !== "string" || value.length === 0 || !STANDARD_BASE64.test(value)) {
    throw new TypeError(`${label} must be non-empty canonical standard Base64 without whitespace.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new TypeError(`${label} must use canonical standard Base64 encoding.`);
  }
  return bytes;
}

/** Parse the canonical Admin activation request into deployable Worker coordinates. */
export function productionReleaseCoordinates(
  activationRequestBytes,
  { expectedGitCommit, expectNoActiveRelease = false } = {},
) {
  if (
    !(activationRequestBytes instanceof Uint8Array)
    || activationRequestBytes.byteLength < 2
    || activationRequestBytes.byteLength > MAX_ACTIVATION_REQUEST_BYTES
  ) {
    throw new TypeError("Activation request has an invalid size.");
  }
  const request = record(
    parseCanonicalJsonBytes(activationRequestBytes, "activation request"),
    "activation request",
  );
  requireExactKeys(request, ["expectedCurrentReleaseId", "manifest"], "activation request");
  if (request.expectedCurrentReleaseId !== null && (
    typeof request.expectedCurrentReleaseId !== "string"
    || !UUID.test(request.expectedCurrentReleaseId)
  )) {
    throw new TypeError("activation request.expectedCurrentReleaseId must be null or a UUID.");
  }
  if (expectNoActiveRelease && request.expectedCurrentReleaseId !== null) {
    throw new TypeError("Architecture-v2 cutover activation must expect no active release.");
  }
  const manifest = parseReleaseManifest(request.manifest);
  if (expectedGitCommit !== undefined) {
    if (!GIT_COMMIT.test(expectedGitCommit)) {
      throw new TypeError("expectedGitCommit must be a full lowercase Git commit SHA.");
    }
    if (manifest.source.commit !== expectedGitCommit) {
      throw new TypeError("Release manifest source commit does not match the checked-out Git commit.");
    }
  }
  const containerTag = `${manifest.artifacts.containerImage.registry}:${manifest.releaseId}`;
  const containerDigest = manifest.artifacts.containerImage.digest;
  return {
    releaseId: manifest.releaseId,
    manifestSha256: sha256(releaseManifestBytes(manifest)),
    sourceGitCommit: manifest.source.commit,
    containerDigest,
    containerImage: `${containerTag}@${containerDigest}`,
    containerTag,
  };
}

/** Replace only the explicit production placeholders and validate the complete binding. */
export function renderProductionReleaseConfig(template, coordinates) {
  if (typeof template !== "string") throw new TypeError("Production Worker config must be text.");
  if (occurrences(template, RELEASE_ID_PLACEHOLDER) !== 2) {
    throw new TypeError(`Production Worker config must contain exactly two ${RELEASE_ID_PLACEHOLDER} placeholders.`);
  }
  if (occurrences(template, MANIFEST_SHA256_PLACEHOLDER) !== 1) {
    throw new TypeError(`Production Worker config must contain exactly one ${MANIFEST_SHA256_PLACEHOLDER} placeholder.`);
  }
  if (occurrences(template, CONTAINER_DIGEST_PLACEHOLDER) !== 1) {
    throw new TypeError(`Production Worker config must contain exactly one ${CONTAINER_DIGEST_PLACEHOLDER} placeholder.`);
  }
  const rendered = template
    .replaceAll(RELEASE_ID_PLACEHOLDER, coordinates.releaseId)
    .replace(MANIFEST_SHA256_PLACEHOLDER, coordinates.manifestSha256)
    .replace(CONTAINER_DIGEST_PLACEHOLDER, coordinates.containerDigest);
  if (
    rendered.includes(RELEASE_ID_PLACEHOLDER)
    || rendered.includes(MANIFEST_SHA256_PLACEHOLDER)
    || rendered.includes(CONTAINER_DIGEST_PLACEHOLDER)
  ) {
    throw new TypeError("Production Worker config still contains release placeholders.");
  }

  let config;
  try {
    config = JSON.parse(rendered);
  } catch (error) {
    throw new TypeError("Rendered production Worker config is not valid JSON.", { cause: error });
  }
  if (
    config.vars?.ENVIRONMENT !== "production"
    || config.vars?.WASM_OJ_RELEASE_ID !== coordinates.releaseId
    || config.vars?.WASM_OJ_RELEASE_MANIFEST_SHA256 !== coordinates.manifestSha256
  ) {
    throw new TypeError("Rendered production Worker variables do not match the release manifest.");
  }
  const submissionContainers = config.containers?.filter(
    (container) => container.class_name === "SubmissionJudgeContainer",
  );
  if (submissionContainers?.length !== 1 || submissionContainers[0].image !== coordinates.containerImage) {
    throw new TypeError("Rendered production Container image does not match the release manifest.");
  }
  return rendered;
}

async function writeAtomic(pathname, bytes) {
  const temporary = `${pathname}.wasm-oj-release-${process.pid}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, pathname);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function usage() {
  return `Usage: node scripts/configure-production-release.mjs \\
  (--activation-request <canonical-request.json> | --activation-request-base64-env <environment-variable>) \\
  --config <wrangler.quick-production.jsonc> --expected-git-commit <sha> \\
  --oci-evidence <oci-verification/evidence.json> \\
  [--activation-request-output <path>] [--expect-no-active-release]

The config must contain the committed WASM-OJ release placeholders. Base64 input must use
canonical standard Base64 without whitespace. The optional output preserves the exact validated
activation request for a later authenticated Admin activation call.
`;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "activation-request": { type: "string" },
      "activation-request-base64-env": { type: "string" },
      "activation-request-output": { type: "string" },
      config: { type: "string" },
      "expected-git-commit": { type: "string" },
      "expect-no-active-release": { type: "boolean" },
      "oci-evidence": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (Boolean(values["activation-request"]) === Boolean(values["activation-request-base64-env"])) {
    throw new TypeError(`Exactly one activation request source is required.\n\n${usage()}`);
  }
  if (!values.config || !values["expected-git-commit"] || !values["oci-evidence"]) {
    throw new TypeError(`--config, --expected-git-commit, and --oci-evidence are required.\n\n${usage()}`);
  }

  let activationRequestBytes;
  if (values["activation-request"]) {
    activationRequestBytes = await readFile(values["activation-request"]);
  } else {
    const environmentVariable = values["activation-request-base64-env"];
    activationRequestBytes = decodeCanonicalBase64(
      process.env[environmentVariable],
      environmentVariable,
    );
  }
  const coordinates = productionReleaseCoordinates(activationRequestBytes, {
    expectedGitCommit: values["expected-git-commit"],
    expectNoActiveRelease: values["expect-no-active-release"],
  });
  await verifyOciTagVerificationFile(values["oci-evidence"], {
    reference: coordinates.containerTag,
    digest: coordinates.containerDigest,
  });
  const rendered = renderProductionReleaseConfig(
    await readFile(values.config, "utf8"),
    coordinates,
  );

  if (values["activation-request-output"]) {
    await mkdir(path.dirname(values["activation-request-output"]), { recursive: true });
    await writeFile(values["activation-request-output"], activationRequestBytes, { flag: "wx" });
  }
  await writeAtomic(values.config, rendered);
  process.stdout.write(`${JSON.stringify(coordinates)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
