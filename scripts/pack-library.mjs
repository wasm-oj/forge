import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  PUBLIC_PACKAGE_BY_NAME,
  PUBLIC_PACKAGES,
  packagesRoot,
  repositoryRoot,
} from "./library-packages.mjs";

const run = promisify(execFile);
const { selected, destination } = parseArguments(process.argv.slice(2));
await mkdir(destination, { recursive: true });

for (const definition of selected) {
  const packageRoot = path.join(packagesRoot, definition.directory);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (typeof manifest.version !== "string" || !/^[0-9A-Za-z.+-]+$/u.test(manifest.version)) {
    throw new Error(`${definition.name} has an unsafe package version.`);
  }
  const expectedFilename = `${definition.name.slice(1).replace("/", "-")}-${manifest.version}.tgz`;
  const expectedTarball = path.join(destination, expectedFilename);
  try {
    await access(expectedTarball);
    throw new Error(`Release tarball already exists: '${expectedTarball}'.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const { stdout } = await run("pnpm", [
    "--config.ignore-scripts=true",
    "pack",
    "--json",
    "--pack-destination",
    destination,
  ], {
    cwd: packageRoot,
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  if (path.resolve(result.filename) !== expectedTarball) {
    throw new Error(`${definition.name} produced unexpected tarball '${result.filename}'.`);
  }
  process.stdout.write(`${definition.name} -> ${path.relative(repositoryRoot, expectedTarball)}\n`);
}

function parseArguments(arguments_) {
  if (arguments_.length !== 4 || arguments_[2] !== "--destination" || !arguments_[3]) {
    throw new Error("Usage: node scripts/pack-library.mjs (--group code|toolchain | --package @wasm-oj/<name>) --destination <directory>");
  }
  let selected;
  if (arguments_[0] === "--group" && (arguments_[1] === "code" || arguments_[1] === "toolchain")) {
    selected = PUBLIC_PACKAGES.filter((definition) => definition.kind === arguments_[1]);
  } else if (arguments_[0] === "--package") {
    const definition = PUBLIC_PACKAGE_BY_NAME.get(arguments_[1]);
    if (!definition) throw new Error(`Unknown public package '${arguments_[1]}'.`);
    selected = [definition];
  } else {
    throw new Error("Usage: node scripts/pack-library.mjs (--group code|toolchain | --package @wasm-oj/<name>) --destination <directory>");
  }
  const destination = path.resolve(repositoryRoot, arguments_[3]);
  const relative = path.relative(repositoryRoot, destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Release tarball destination must be a repository-relative subdirectory.");
  }
  return { selected, destination };
}
