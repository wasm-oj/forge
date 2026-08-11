import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(import.meta.resolve("@typescript/native/package.json"));

export async function resolveTypeScriptCli() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const relativeCli = typeof manifest.bin === "object" && manifest.bin !== null
    ? manifest.bin.tsc
    : undefined;

  if (
    typeof relativeCli !== "string"
    || relativeCli.length === 0
    || path.isAbsolute(relativeCli)
    || relativeCli.split(/[\\/]/).includes("..")
  ) {
    throw new Error("@typescript/native does not declare a safe relative 'tsc' binary.");
  }

  return path.resolve(path.dirname(manifestPath), relativeCli);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = spawnSync(await resolveTypeScriptCli(), process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`TypeScript CLI terminated by signal ${result.signal}.`);
  process.exitCode = result.status ?? 1;
}
