import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const [tag, tarballArgument] = process.argv.slice(2);
if (!tag || process.argv.length > 4) {
  throw new Error("Usage: pnpm run release:verify <vMAJOR.MINOR.PATCH> [package.tgz]");
}
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const expectedTag = `v${packageJson.version}`;
if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag) || tag !== expectedTag) {
  throw new Error(`Release tag '${tag}' must exactly equal '${expectedTag}'.`);
}
for (const [label, actual, expected] of [
  ["package name", packageJson.name, "@wasm-oj/forge"],
  ["repository", packageJson.repository?.url, "git+https://github.com/wasm-oj/forge.git"],
  ["registry", packageJson.publishConfig?.registry, "https://registry.npmjs.org/"],
  ["access", packageJson.publishConfig?.access, "public"],
  ["package manager", packageJson.packageManager, "pnpm@10.21.0"],
]) {
  if (actual !== expected) throw new Error(`Release ${label} must be '${expected}', received '${String(actual)}'.`);
}

const head = git("rev-parse", "HEAD");
const taggedCommit = git("rev-parse", `refs/tags/${tag}^{commit}`);
if (head !== taggedCommit) throw new Error(`Release tag '${tag}' does not point at HEAD.`);
if (git("cat-file", "-t", `refs/tags/${tag}`) !== "tag") throw new Error(`Release tag '${tag}' must be annotated.`);
if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("Release worktree must be clean.");
try {
  execFileSync("git", ["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"], {
    cwd: root,
    stdio: "ignore",
  });
} catch {
  throw new Error(`Release commit ${head} is not reachable from origin/main.`);
}

if (tarballArgument) {
  const tarball = path.resolve(tarballArgument);
  const expectedName = `wasm-oj-forge-${packageJson.version}.tgz`;
  if (path.basename(tarball) !== expectedName) throw new Error(`Release tarball must be named '${expectedName}'.`);
  const metadata = await stat(tarball);
  const minimum = 100 * 1024 * 1024;
  const maximum = 250 * 1024 * 1024;
  if (!metadata.isFile() || metadata.size < minimum || metadata.size > maximum) {
    throw new Error(`Release tarball size ${metadata.size} is outside the admitted ${minimum}..${maximum} byte range.`);
  }
  const digest = createHash("sha256").update(await readFile(tarball)).digest("hex");
  await writeFile(`${tarball}.sha256`, `${digest}  ${path.basename(tarball)}\n`, { flag: "wx" });
  process.stdout.write(`Verified ${path.basename(tarball)} (${metadata.size} bytes, sha256 ${digest}).\n`);
} else {
  process.stdout.write(`Verified release identity ${packageJson.name}@${packageJson.version} at ${head}.\n`);
}

function git(...arguments_) {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
}
