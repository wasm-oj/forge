import { readFile } from "node:fs/promises";
import path from "node:path";
import { CODE_PACKAGES, packagesRoot } from "./library-packages.mjs";

const [command, version] = process.argv.slice(2);
if (command !== "verify-code-version" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? "")) {
  throw new Error("Usage: node scripts/release-library.mjs verify-code-version <semver>");
}

for (const definition of CODE_PACKAGES) {
  const manifest = JSON.parse(await readFile(path.join(packagesRoot, definition.directory, "package.json"), "utf8"));
  if (manifest.version !== version) {
    throw new Error(`${definition.name} is version ${manifest.version}; release tag requires ${version}.`);
  }
}

process.stdout.write(`Verified ${CODE_PACKAGES.length} synchronized code packages at ${version}.\n`);
