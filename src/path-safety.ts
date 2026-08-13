import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Resolve only the operating system's own temporary-directory alias. */
export async function canonicalizeSystemTemporaryPrefix(value: string): Promise<string> {
  const absolute = path.resolve(value);
  const temporary = path.resolve(os.tmpdir());
  if (absolute !== temporary && !absolute.startsWith(`${temporary}${path.sep}`)) return absolute;
  const canonicalTemporary = await realpath(temporary);
  return path.join(canonicalTemporary, path.relative(temporary, absolute));
}

/** True only when the absolute path's existing components do not traverse links. */
export async function anchoredPathHasNoSymlink(value: string): Promise<boolean> {
  const absolute = path.resolve(value);
  const anchored = await canonicalizeSystemTemporaryPrefix(absolute);
  const root = path.parse(anchored).root;
  let current = root;
  for (const segment of path.relative(root, anchored).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }
  return true;
}
