import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { publishEvidenceFiles } from "./evidence-publication.mjs";

export async function publishCargoLicenseInventory(options) {
  const {
    rawPath,
    stagedReportPath,
    reportPath,
    inventoryPath,
    schema,
    graph,
    reportRelativePath,
  } = options;
  const [rawBytes, reportBytes] = await Promise.all([
    readFile(path.resolve(rawPath)),
    readFile(path.resolve(stagedReportPath)),
  ]);
  const raw = JSON.parse(rawBytes.toString("utf8"));
  if (!Array.isArray(raw.crates) || !Array.isArray(raw.licenses)) {
    throw new Error("cargo-about returned an unsupported JSON document.");
  }

  const selectedLicenses = new Map();
  for (const license of raw.licenses) {
    if (typeof license.id !== "string" || !Array.isArray(license.used_by)) {
      throw new Error("cargo-about returned an invalid license record.");
    }
    for (const use of license.used_by) {
      const id = use?.crate?.id;
      if (typeof id !== "string") throw new Error("cargo-about returned an invalid crate reference.");
      const ids = selectedLicenses.get(id) ?? new Set();
      ids.add(license.id);
      selectedLicenses.set(id, ids);
    }
  }

  const packages = raw.crates.map((entry) => {
    const value = entry?.package;
    if (
      typeof value?.id !== "string"
      || typeof value.name !== "string"
      || typeof value.version !== "string"
    ) {
      throw new Error("cargo-about returned an invalid package record.");
    }
    const licenses = [...(selectedLicenses.get(value.id) ?? [])].sort();
    if (licenses.length === 0) {
      throw new Error(`cargo-about selected no distributable license for '${value.name} ${value.version}'.`);
    }
    return {
      name: value.name,
      version: value.version,
      repository: typeof value.repository === "string" ? value.repository : null,
      declaredLicense: value.license ?? entry.license ?? null,
      selectedLicenses: licenses,
    };
  }).sort((left, right) => compareCodePoints(
    `${left.name}\0${left.version}`,
    `${right.name}\0${right.version}`,
  ));

  const identities = packages.map(({ name, version }) => `${name}@${version}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error("The dependency graph contains duplicate name/version package identities.");
  }

  const inventory = {
    schema,
    generator: { name: "cargo-about", version: "0.9.1" },
    graph,
    report: {
      path: reportRelativePath,
      sha256: createHash("sha256").update(reportBytes).digest("hex"),
    },
    packages,
  };
  await publishEvidenceFiles([
    { path: path.resolve(reportPath), bytes: reportBytes },
    { path: path.resolve(inventoryPath), bytes: `${JSON.stringify(inventory, null, 2)}\n` },
  ]);
}

function compareCodePoints(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
