import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const generatedPaths = new Set([
  ".DS_Store",
  ".next",
  ".playwright-cli",
  ".vinext",
  ".wrangler",
  "coverage",
  "crates/compiler-service",
  "dist",
  "lib",
  "output",
  "tools/slim-clang-webc",
  "tsconfig.tsbuildinfo",
]);
for (const parent of ["crates", "tools", "vendor"]) {
  for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
    if (entry.isDirectory()) generatedPaths.add(`${parent}/${entry.name}/target`);
  }
}
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith(".forge-library-build-")) {
    generatedPaths.add(entry.name);
  }
}

for (const relative of [...generatedPaths].sort()) {
  const absolute = path.resolve(root, relative);
  if (path.dirname(absolute) === absolute || !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to clean unsafe path '${relative}'.`);
  }
  await rm(absolute, { recursive: true, force: true });
}

process.stdout.write(`Removed ${generatedPaths.size} generated workspace paths.\n`);
