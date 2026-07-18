import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const markdownFiles = [
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "crates/runtime-core/README.md",
  "public/toolchains/README.md",
  ...await markdownBelow("docs"),
  ...(await markdownBelow("experiments")).filter((file) => file.endsWith("/SPEC.md")),
].sort(compareCodePoints);
const immutableCommandRecords = new Set([
  "experiments/forge-contract-1-cost-baseline/SPEC.md",
]);

for (const relative of markdownFiles) {
  const source = await readFile(path.join(root, relative), "utf8");
  if (!immutableCommandRecords.has(relative)) {
    const legacyCommand = source.match(/\bnpm\s+(?:ci|install|pack|run)\b/);
    if (legacyCommand) {
      throw new Error(`${relative} contains legacy repository command '${legacyCommand[0]}'.`);
    }
    const literalRunSeparator = source.match(/\bpnpm\b[^\r\n]*\brun\s+\S+[^\r\n]*\s--(?=\s|$)/);
    if (literalRunSeparator) {
      throw new Error(`${relative} passes a literal '--' through pnpm run; pnpm forwards script arguments directly.`);
    }
  }
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (!raw || raw.startsWith("#") || raw.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split("#", 1)[0]);
    if (!target) continue;
    const absolute = path.resolve(path.dirname(path.join(root, relative)), target);
    const escaped = path.relative(root, absolute);
    if (escaped.startsWith("..") || path.isAbsolute(escaped)) {
      throw new Error(`${relative} links outside the package boundary: '${raw}'.`);
    }
    try {
      await access(absolute);
    } catch {
      throw new Error(`${relative} contains a missing local link target '${raw}'.`);
    }
  }
}

const readme = await readFile(path.join(root, "README.md"), "utf8");
for (const required of [
  "docs/integration-guide.md",
  "docs/releasing.md",
  "createServerForge",
  "runtimeDriverPlugins",
  "prepareDependencies",
  "ForgeError",
  "pnpm install --frozen-lockfile",
]) {
  if (!readme.includes(required)) throw new Error(`README.md does not document '${required}'.`);
}

await access(path.join(root, "pnpm-lock.yaml"));
try {
  await access(path.join(root, "package-lock.json"));
  throw new Error("package-lock.json must not coexist with the pnpm lockfile.");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

process.stdout.write(`Verified ${markdownFiles.length} documentation files and pnpm-only commands.\n`);

async function markdownBelow(relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) output.push(...await markdownBelow(relative));
    else if (entry.isFile() && entry.name.endsWith(".md")) output.push(relative);
    else if (!entry.isFile()) throw new Error(`Documentation boundary contains unsupported entry '${relative}'.`);
  }
  return output;
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
