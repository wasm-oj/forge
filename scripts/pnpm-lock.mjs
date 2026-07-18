import { readFile } from "node:fs/promises";
import path from "node:path";
import { load } from "js-yaml";

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

export async function readPnpmLock(root) {
  const lock = requireRecord(
    load(await readFile(path.join(root, "pnpm-lock.yaml"), "utf8")),
    "pnpm-lock.yaml",
  );
  if (String(lock.lockfileVersion) !== "9.0") {
    throw new Error(`pnpm-lock.yaml must use lockfileVersion 9.0; received '${String(lock.lockfileVersion)}'.`);
  }
  requireRecord(lock.importers, "pnpm-lock.yaml importers");
  requireRecord(lock.packages, "pnpm-lock.yaml packages");
  return lock;
}

export function requireLockedPackage(lock, name, version) {
  const rootImporter = requireRecord(lock.importers["."], "pnpm-lock.yaml root importer");
  const dependencies = {
    ...requireRecord(rootImporter.dependencies ?? {}, "pnpm-lock.yaml root dependencies"),
    ...requireRecord(rootImporter.devDependencies ?? {}, "pnpm-lock.yaml root devDependencies"),
  };
  const direct = requireRecord(dependencies[name], `pnpm-lock.yaml importer entry '${name}'`);
  if (direct.specifier !== version || direct.version !== version) {
    throw new Error(`pnpm-lock.yaml does not bind direct package '${name}@${version}'.`);
  }
  const resolved = requireRecord(lock.packages[`${name}@${version}`], `pnpm-lock.yaml package '${name}@${version}'`);
  const resolution = requireRecord(resolved.resolution, `pnpm-lock.yaml resolution '${name}@${version}'`);
  if (typeof resolution.integrity !== "string" || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(resolution.integrity)) {
    throw new Error(`pnpm-lock.yaml package '${name}@${version}' has no valid SRI integrity.`);
  }
  return Object.freeze({ name, version, integrity: resolution.integrity });
}
