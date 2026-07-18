import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function filesBelow(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await filesBelow(path.join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`Packed package contains unsupported filesystem entry '${relative}'.`);
    }
  }
  return files;
}

function checkedManifestPath(value) {
  if (
    typeof value !== "string"
    || !value
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`pnpm pack returned an unsafe package path '${String(value)}'.`);
  }
  return value;
}

/** Creates and extracts the exact publish tarball without running package lifecycle scripts. */
export async function unpackPublishPackage(repositoryRoot, temporaryPrefix) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), temporaryPrefix));
  try {
    const packDestination = path.join(temporary, "tarball");
    const packageRoot = path.join(temporary, "package");
    await Promise.all([
      mkdir(packDestination, { recursive: true }),
      mkdir(packageRoot, { recursive: true }),
    ]);

    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const { stdout } = await run(
      pnpm,
      ["--config.ignore-scripts=true", "pack", "--json", "--pack-destination", packDestination],
      { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout);
    if (
      result === null
      || typeof result !== "object"
      || Array.isArray(result)
      || typeof result.filename !== "string"
      || !Array.isArray(result.files)
    ) {
      throw new Error("pnpm pack returned an unexpected manifest.");
    }

    const tarball = path.resolve(result.filename);
    if (path.dirname(tarball) !== path.resolve(packDestination)) {
      throw new Error(`pnpm pack returned a tarball outside its destination: '${result.filename}'.`);
    }
    await access(tarball);
    await run("tar", [
      "--extract",
      "--gzip",
      "--file", tarball,
      "--directory", packageRoot,
      "--strip-components=1",
    ], { maxBuffer: 4 * 1024 * 1024 });

    const manifestFiles = new Set(result.files.map(({ path: packedPath }) => checkedManifestPath(packedPath)));
    const extractedFiles = new Set(await filesBelow(packageRoot));
    const missing = [...manifestFiles].filter((file) => !extractedFiles.has(file));
    const unexpected = [...extractedFiles].filter((file) => !manifestFiles.has(file));
    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        "Extracted publish tarball differs from its manifest."
        + `${missing.length > 0 ? ` Missing: ${missing.sort().join(", ")}.` : ""}`
        + `${unexpected.length > 0 ? ` Unexpected: ${unexpected.sort().join(", ")}.` : ""}`,
      );
    }

    return {
      packageRoot,
      packedFiles: manifestFiles,
      packResult: result,
      cleanup: () => rm(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
