import { writeFileSync } from "node:fs";
import { serialize } from "node:v8";
import { buildServerProjectInProcess } from "./server-compiler.ts";

try {
  const responsePath = requiredResponsePath();
  const encoded = JSON.parse(await readStdin());
  const result = await buildServerProjectInProcess(
    {
      compilerExecutable: encoded.compilerExecutable,
      toolchainDirectory: encoded.toolchainDirectory,
    },
    encoded.project,
    encoded.cacheKey,
    (progress) => writeFileSync(3, `${JSON.stringify(progress)}\n`),
  );
  writeFileSync(responsePath, serialize({ ok: true, result }), { flag: "wx" });
  setTimeout(() => process.exit(0), 10);
} catch (error) {
  writeFileSync(requiredResponsePath(), serialize({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }), { flag: "wx" });
  setTimeout(() => process.exit(1), 10);
}

function requiredResponsePath() {
  const value = process.env.FORGE_BUILD_RESPONSE;
  if (!value) throw new Error("FORGE_BUILD_RESPONSE is required.");
  return value;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
