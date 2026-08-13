import { lstat } from "node:fs/promises";
import path from "node:path";
import { canonicalizeSystemTemporaryPrefix } from "../path-safety";
import { CliError } from "./errors";

/**
 * Checks every declared write target before the first write. Force may replace
 * regular files, but never follows symlinks or writes through non-directories.
 */
export async function assertSafeFileDestinations(
  root: string,
  relativeFiles: readonly string[],
  force: boolean,
): Promise<void> {
  const absoluteRoot = path.resolve(root);
  const anchoredRoot = await canonicalizeSystemTemporaryPrefix(absoluteRoot);
  const filesystemRoot = path.parse(anchoredRoot).root;
  const targets = relativeFiles.map((relative) => path.join(absoluteRoot, ...relative.split("/")));
  const existing: string[] = [];

  let anchored = filesystemRoot;
  for (const segment of path.relative(filesystemRoot, anchoredRoot).split(path.sep).filter(Boolean)) {
    anchored = path.join(anchored, segment);
    try {
      const metadata = await lstat(anchored);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new CliError(`Destination root component '${anchored}' must be a real directory.`, { exitCode: 5, code: "destination-symlink" });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }

  for (const target of targets) {
    const segments = path.relative(absoluteRoot, target).split(path.sep).filter(Boolean);
    let current = absoluteRoot;
    for (let index = -1; index < segments.length; index += 1) {
      if (index >= 0) current = path.join(current, segments[index]!);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) {
          throw new CliError(`Refusing symlink destination '${current}'.`, { exitCode: 5, code: "destination-symlink" });
        }
        const isTarget = index === segments.length - 1;
        if (isTarget) {
          if (!metadata.isFile()) throw new CliError(`Destination '${current}' is not a regular file.`, { exitCode: 5, code: "destination-invalid" });
          if (!force) existing.push(path.relative(absoluteRoot, current));
        } else if (!metadata.isDirectory()) {
          throw new CliError(`Destination ancestor '${current}' is not a directory.`, { exitCode: 5, code: "destination-invalid" });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
  }

  if (existing.length > 0) {
    throw new CliError(`Refusing to overwrite existing files: ${[...new Set(existing)].sort().join(", ")}. Use --force to replace them.`, {
      exitCode: 5,
      code: "destination-exists",
    });
  }
}
