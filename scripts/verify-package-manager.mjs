import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PNPM_VERSION = "10.21.0";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

if (packageJson.packageManager !== `pnpm@${PNPM_VERSION}`) {
  throw new Error(`packageManager must pin pnpm@${PNPM_VERSION}.`);
}
await access(path.join(root, "pnpm-lock.yaml"));
try {
  await access(path.join(root, "package-lock.json"));
  throw new Error("package-lock.json must not coexist with pnpm-lock.yaml.");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
  verifyCommandText(`package.json script '${name}'`, command);
}

const scriptFiles = (await filesBelow("scripts"))
  .filter((relative) => /\.(?:mjs|ts|sh)$/.test(relative));
scriptFiles.push(...(await filesBelow(".github/workflows"))
  .filter((relative) => /\.ya?ml$/.test(relative)));
for (const relative of scriptFiles) {
  const source = await readFile(path.join(root, relative), "utf8");
  verifyCommandText(relative, source);
  if (/(?:spawn|execFile|execFileSync)\s*\(\s*["']npm(?:\.cmd)?["']/.test(source)) {
    throw new Error(`${relative} executes npm directly instead of the pinned pnpm CLI.`);
  }
}

process.stdout.write(`Verified pnpm@${PNPM_VERSION} as the sole active repository package manager.\n`);

function verifyCommandText(label, source) {
  if (typeof source !== "string") throw new TypeError(`${label} must be text.`);
  const legacy = source.match(/\bnpm\s+(?:ci|install|pack|run)\b/);
  if (legacy) throw new Error(`${label} contains legacy command '${legacy[0]}'.`);
  if (/\bpnpm\b[^\r\n]*\brun\s+\S+[^\r\n]*\s--(?=\s|$)/.test(source)) {
    throw new Error(`${label} passes a literal '--' through pnpm run.`);
  }
}

async function filesBelow(relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Package-manager verification encountered unsupported entry '${relative}'.`);
  }
  return files;
}
