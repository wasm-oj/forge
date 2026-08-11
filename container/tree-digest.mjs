import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, readdir, realpath } from "node:fs/promises";
import path from "node:path";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareNames(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function admittedName(name) {
  return name === name.normalize("NFC")
    && name !== "."
    && name !== ".."
    && !name.includes("/")
    && !name.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(name);
}

async function hashFile(file) {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Identity tree contains a non-regular file.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await lstat(file, { bigint: true });
  if (
    !after.isFile()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mode !== after.mode
    || before.mtimeNs !== after.mtimeNs
  ) throw new Error("Identity tree file changed while its digest was computed.");
  const bytes = Number(after.size);
  if (!Number.isSafeInteger(bytes)) throw new Error("Identity tree file size exceeds the identity format.");
  return { executable: (before.mode & 0o111n) !== 0n, bytes, sha256: hash.digest("hex") };
}

/**
 * Hash a toolchain tree as canonical JSON over sorted relative paths, byte
 * lengths, and per-file SHA-256 digests. Symlinks and special files fail closed.
 */
export async function computeFileTreeIdentity(root, options = {}) {
  const excluded = new Set(options.excludedRelativePaths ?? []);
  const allowInternalSymlinks = options.allowInternalSymlinks === true;
  for (const relative of excluded) {
    if (typeof relative !== "string" || relative.length < 1 || relative.includes("/") || !admittedName(relative)) {
      throw new Error("Identity tree exclusion must be one canonical top-level path.");
    }
  }
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("Identity tree root must be a real directory.");
  const absoluteRoot = path.resolve(root);
  const realRoot = await realpath(absoluteRoot);
  const relativeInside = (base, candidate) => {
    const relative = path.relative(base, candidate);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  const entries = [];
  async function visit(directory, prefix) {
    const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareNames(left.name, right.name));
    for (const child of children) {
      if (!admittedName(child.name)) throw new Error("Identity tree contains a non-canonical path.");
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      if (excluded.has(relative)) continue;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) {
        const metadata = await lstat(absolute);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Identity tree directory changed during traversal.");
        await visit(absolute, relative);
      } else if (child.isFile()) {
        const file = await hashFile(absolute);
        entries.push({ path: relative, executable: file.executable, bytes: file.bytes, sha256: file.sha256 });
      } else if (child.isSymbolicLink() && allowInternalSymlinks) {
        const target = await readlink(absolute, "utf8");
        if (target !== target.normalize("NFC") || target.includes("\0") || target.includes("\\") || path.isAbsolute(target)) {
          throw new Error("Identity tree symlink target is not canonical.");
        }
        const lexicalTarget = path.resolve(path.dirname(absolute), target);
        const realTarget = await realpath(absolute);
        if (!relativeInside(absoluteRoot, lexicalTarget) || !relativeInside(realRoot, realTarget)) throw new Error("Identity tree symlink escapes its root.");
        const normalizedTarget = path.relative(absoluteRoot, lexicalTarget).split(path.sep).join("/");
        const targetTopLevel = normalizedTarget.split("/", 1)[0];
        if (!normalizedTarget || normalizedTarget === ".." || normalizedTarget.startsWith("../") || excluded.has(targetTopLevel)) {
          throw new Error("Identity tree symlink targets an excluded path.");
        }
        entries.push({ path: relative, symlinkTarget: normalizedTarget });
      } else {
        throw new Error("Identity tree contains a symlink or special file.");
      }
    }
  }
  await visit(root, "");
  if (entries.length === 0) throw new Error("Identity tree is empty.");
  // This is the forge-file-tree-sha256-v1 algorithm used by qualification:
  // one JSON record per UTF-8-sorted file/internal-symlink and exactly one
  // trailing newline. Internal symlinks are opt-in for pnpm's deployed layout;
  // their normalized target and the target's physical tree are both bound.
  const inventoryBytes = Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return Object.freeze({ entries: entries.length, rootSha256: sha256(inventoryBytes) });
}
