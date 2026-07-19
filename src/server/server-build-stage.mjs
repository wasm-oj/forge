import { writeFileSync } from "node:fs";
import { deserialize, serialize } from "node:v8";
import { buildServerProjectInProcess } from "./server-compiler.ts";
import { readBoundedRegularFile } from "./bounded-transport.ts";
import { withProcessKeepalive } from "./process-keepalive.mjs";

const SERVER_BUILD_REQUEST_LIMIT_BYTES = 768 * 1024 * 1024;

try {
  const responsePath = requiredResponsePath();
  const encoded = deserialize(await readBoundedRegularFile(
    requiredRequestPath(),
    SERVER_BUILD_REQUEST_LIMIT_BYTES,
  ));
  const result = await withProcessKeepalive(buildServerProjectInProcess(
    {
      compilerExecutable: encoded.compilerExecutable,
      toolchainDirectory: encoded.toolchainDirectory,
    },
    encoded.project,
    encoded.cacheKey,
    (progress) => writeFileSync(3, `${JSON.stringify(progress)}\n`),
  ));
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

function requiredRequestPath() {
  const value = process.env.FORGE_BUILD_REQUEST;
  if (!value) throw new Error("FORGE_BUILD_REQUEST is required.");
  return value;
}
