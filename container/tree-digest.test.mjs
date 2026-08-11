import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { computeFileTreeIdentity } from "./tree-digest.mjs";

test("binds a root-contained pnpm-style symlink and its physical target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-tree-"));
  await mkdir(path.join(root, "node_modules", ".pnpm", "package", "node_modules", "package"), { recursive: true });
  await writeFile(path.join(root, "node_modules", ".pnpm", "package", "node_modules", "package", "index.js"), "export default 1;\n");
  await symlink(".pnpm/package/node_modules/package", path.join(root, "node_modules", "package"));
  const first = await computeFileTreeIdentity(root, { allowInternalSymlinks: true });
  await writeFile(path.join(root, "node_modules", ".pnpm", "package", "node_modules", "package", "index.js"), "export default 2;\n");
  const second = await computeFileTreeIdentity(root, { allowInternalSymlinks: true });
  assert.notEqual(first.rootSha256, second.rootSha256);
});

test("rejects external and absolute symlinks even when internal symlinks are enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-tree-"));
  await writeFile(path.join(root, "file"), "safe\n");
  await symlink("../outside", path.join(root, "escape"));
  await assert.rejects(computeFileTreeIdentity(root, { allowInternalSymlinks: true }), /escapes|ENOENT/);
  const absoluteRoot = await mkdtemp(path.join(os.tmpdir(), "forge-tree-"));
  await writeFile(path.join(absoluteRoot, "file"), "safe\n");
  await symlink("/tmp", path.join(absoluteRoot, "escape"));
  await assert.rejects(computeFileTreeIdentity(absoluteRoot, { allowInternalSymlinks: true }), /not canonical/);
});

test("retains the strict no-symlink default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-tree-"));
  await writeFile(path.join(root, "physical"), "safe\n");
  await symlink("physical", path.join(root, "link"));
  await assert.rejects(computeFileTreeIdentity(root), /symlink or special/);
});
