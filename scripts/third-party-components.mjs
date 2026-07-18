import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readPnpmLock, requireLockedPackage } from "./pnpm-lock.mjs";

export const COMPONENT_MANIFEST_PATH = "licenses/components.json";
export const COMPONENT_MANIFEST_SCHEMA = "wasm-oj-forge-v1/third-party-components";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SRI_PATTERN = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`Invalid third-party component manifest: ${message}`);
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(record, expected, label) {
  const actual = Object.keys(record).sort(compareCodePoints);
  const canonical = [...expected].sort(compareCodePoints);
  if (JSON.stringify(actual) !== JSON.stringify(canonical)) {
    fail(`${label} keys must be exactly ${canonical.join(", ")}; received ${actual.join(", ")}.`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`${label} must be a non-empty, trimmed string.`);
  }
  return value;
}

function requireRelativePath(value, label) {
  const relative = requireString(value, label);
  if (
    relative.includes("\\")
    || path.posix.isAbsolute(relative)
    || path.posix.normalize(relative) !== relative
    || relative.startsWith("../")
  ) {
    fail(`${label} must be a normalized workspace-relative POSIX path.`);
  }
  return relative;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function distributionIdentity(distribution) {
  if (distribution.kind === "file") return `file:${distribution.path}`;
  if (distribution.kind === "embedded") return `embedded:${distribution.container}`;
  return `npm:${distribution.package}`;
}

function validateDistribution(value, label) {
  const distribution = requireRecord(value, label);
  const kind = requireString(distribution.kind, `${label}.kind`);
  if (kind === "file") {
    requireExactKeys(distribution, ["kind", "path", "sha256"], label);
    requireRelativePath(distribution.path, `${label}.path`);
    requireSha256(distribution.sha256, `${label}.sha256`);
  } else if (kind === "embedded") {
    requireExactKeys(distribution, ["kind", "container", "sha256"], label);
    requireRelativePath(distribution.container, `${label}.container`);
    requireSha256(distribution.sha256, `${label}.sha256`);
  } else if (kind === "npm") {
    requireExactKeys(distribution, ["kind", "package", "integrity"], label);
    requireString(distribution.package, `${label}.package`);
    if (typeof distribution.integrity !== "string" || !SRI_PATTERN.test(distribution.integrity)) {
      fail(`${label}.integrity must be a SHA-256, SHA-384, or SHA-512 SRI value.`);
    }
  } else {
    fail(`${label}.kind must be 'file', 'embedded', or 'npm'.`);
  }
  return distribution;
}

function validateLicenseFile(value, label) {
  const license = requireRecord(value, label);
  requireExactKeys(license, ["path", "sha256"], label);
  const relative = requireRelativePath(license.path, `${label}.path`);
  if (!relative.startsWith("licenses/") || relative === COMPONENT_MANIFEST_PATH) {
    fail(`${label}.path must name license material other than '${COMPONENT_MANIFEST_PATH}'.`);
  }
  requireSha256(license.sha256, `${label}.sha256`);
  return license;
}

function validateComponent(value, index) {
  const label = `components[${index}]`;
  const component = requireRecord(value, label);
  requireExactKeys(component, ["id", "name", "version", "source", "distributions", "licenseFiles"], label);
  const id = requireString(component.id, `${label}.id`);
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) {
    fail(`${label}.id '${id}' is not a canonical component identifier.`);
  }
  requireString(component.name, `${label}.name`);
  requireString(component.version, `${label}.version`);

  const source = requireRecord(component.source, `${label}.source`);
  requireExactKeys(source, ["url", "revision"], `${label}.source`);
  const sourceUrl = requireString(source.url, `${label}.source.url`);
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== "https:") fail(`${label}.source.url must use HTTPS.`);
  } catch {
    fail(`${label}.source.url must be an absolute HTTPS URL.`);
  }
  requireString(source.revision, `${label}.source.revision`);

  if (!Array.isArray(component.distributions) || component.distributions.length === 0) {
    fail(`${label}.distributions must be a non-empty array.`);
  }
  const distributions = component.distributions.map((item, itemIndex) => (
    validateDistribution(item, `${label}.distributions[${itemIndex}]`)
  ));
  const distributionIds = distributions.map(distributionIdentity);
  if (new Set(distributionIds).size !== distributionIds.length) {
    fail(`${label}.distributions contains a duplicate distribution.`);
  }
  const sortedDistributionIds = [...distributionIds].sort(compareCodePoints);
  if (JSON.stringify(distributionIds) !== JSON.stringify(sortedDistributionIds)) {
    fail(`${label}.distributions must be sorted by kind and path/package.`);
  }

  if (!Array.isArray(component.licenseFiles) || component.licenseFiles.length === 0) {
    fail(`${label}.licenseFiles must be a non-empty array.`);
  }
  const licenseFiles = component.licenseFiles.map((item, itemIndex) => (
    validateLicenseFile(item, `${label}.licenseFiles[${itemIndex}]`)
  ));
  const licensePaths = licenseFiles.map((license) => license.path);
  if (new Set(licensePaths).size !== licensePaths.length) {
    fail(`${label}.licenseFiles contains a duplicate path.`);
  }
  const sortedLicensePaths = [...licensePaths].sort(compareCodePoints);
  if (JSON.stringify(licensePaths) !== JSON.stringify(sortedLicensePaths)) {
    fail(`${label}.licenseFiles must be sorted by path.`);
  }
  return component;
}

async function sha256File(root, relative) {
  const bytes = await readFile(path.join(root, relative));
  if (bytes.byteLength === 0) fail(`'${relative}' is empty.`);
  return createHash("sha256").update(bytes).digest("hex");
}

function parseNpmSpecifier(specifier) {
  const separator = specifier.lastIndexOf("@");
  if (separator <= 0 || separator === specifier.length - 1) {
    fail(`npm distribution '${specifier}' must include an exact version.`);
  }
  return { name: specifier.slice(0, separator), version: specifier.slice(separator + 1) };
}

async function verifyNpmDistribution(root, distribution) {
  const { name, version } = parseNpmSpecifier(distribution.package);
  const locked = requireLockedPackage(await readPnpmLock(root), name, version);
  if (locked.integrity !== distribution.integrity) {
    fail(`npm distribution '${distribution.package}' does not match pnpm-lock.yaml.`);
  }
}

export async function readThirdPartyComponents(root, options = {}) {
  const manifestBytes = await readFile(path.join(root, COMPONENT_MANIFEST_PATH));
  if (manifestBytes.byteLength === 0) fail(`'${COMPONENT_MANIFEST_PATH}' is empty.`);
  const text = manifestBytes.toString("utf8");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    fail(`'${COMPONENT_MANIFEST_PATH}' is not valid JSON: ${error.message}`);
  }
  requireRecord(manifest, "root");
  requireExactKeys(manifest, ["schema", "components"], "root");
  if (manifest.schema !== COMPONENT_MANIFEST_SCHEMA) {
    fail(`schema must be '${COMPONENT_MANIFEST_SCHEMA}'.`);
  }
  if (!Array.isArray(manifest.components) || manifest.components.length === 0) {
    fail("components must be a non-empty array.");
  }
  const components = manifest.components.map(validateComponent);
  const componentIds = components.map((component) => component.id);
  if (new Set(componentIds).size !== componentIds.length) fail("component ids must be unique.");
  const sortedIds = [...componentIds].sort(compareCodePoints);
  if (JSON.stringify(componentIds) !== JSON.stringify(sortedIds)) {
    fail("components must be sorted by id.");
  }
  const canonical = `${JSON.stringify(manifest, null, 2)}\n`;
  if (text !== canonical) fail(`'${COMPONENT_MANIFEST_PATH}' must use canonical two-space JSON formatting.`);

  const referencedLicenses = new Set();
  const referencedToolchainAssets = new Set();
  for (const component of components) {
    for (const license of component.licenseFiles) {
      referencedLicenses.add(license.path);
      const actual = await sha256File(root, license.path);
      if (actual !== license.sha256) {
        fail(`license '${license.path}' has digest ${actual}; expected ${license.sha256}.`);
      }
    }
    for (const distribution of component.distributions) {
      if (distribution.kind === "npm") {
        await verifyNpmDistribution(root, distribution);
        continue;
      }
      const relative = distribution.kind === "file" ? distribution.path : distribution.container;
      if (relative.startsWith("public/toolchains/") && relative !== "public/toolchains/README.md") {
        referencedToolchainAssets.add(relative);
      }
      const actual = await sha256File(root, relative);
      if (actual !== distribution.sha256) {
        fail(`${distribution.kind} distribution '${relative}' has digest ${actual}; expected ${distribution.sha256}.`);
      }
    }
  }

  if (options.verifyExactToolchainDirectory !== false) {
    const actualToolchainAssets = new Set(
      (await readdir(path.join(root, "public/toolchains"), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name !== "README.md")
        .map((entry) => `public/toolchains/${entry.name}`),
    );
    const missing = [...actualToolchainAssets]
      .filter((relative) => !referencedToolchainAssets.has(relative))
      .sort(compareCodePoints);
    const extra = [...referencedToolchainAssets]
      .filter((relative) => !actualToolchainAssets.has(relative))
      .sort(compareCodePoints);
    if (missing.length > 0 || extra.length > 0) {
      fail(
        "distributed toolchain assets differ from component distributions."
        + (missing.length > 0 ? ` Missing references: ${missing.join(", ")}.` : "")
        + (extra.length > 0 ? ` Missing files: ${extra.join(", ")}.` : ""),
      );
    }
  }

  const expectedLicenseFiles = new Set([COMPONENT_MANIFEST_PATH, ...referencedLicenses]);
  if (options.verifyExactLicenseDirectory !== false) {
    const actualLicenseFiles = new Set(
      (await readdir(path.join(root, "licenses"), { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => `licenses/${entry.name}`),
    );
    const missing = [...expectedLicenseFiles].filter((relative) => !actualLicenseFiles.has(relative)).sort(compareCodePoints);
    const extra = [...actualLicenseFiles].filter((relative) => !expectedLicenseFiles.has(relative)).sort(compareCodePoints);
    if (missing.length > 0 || extra.length > 0) {
      fail(
        "licenses directory differs from the manifest."
        + (missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "")
        + (extra.length > 0 ? ` Unexpected: ${extra.join(", ")}.` : ""),
      );
    }
  }

  return Object.freeze({
    manifest,
    manifestBytes,
    expectedLicenseFiles,
    referencedLicenses,
    referencedToolchainAssets,
  });
}
