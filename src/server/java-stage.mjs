import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  JAVA_COMPILER_ASSET_PATH,
  JAVA_COMPILER_SHA256,
  JAVA_COMPILE_CLASSLIB_ASSET_PATH,
  JAVA_COMPILE_CLASSLIB_SHA256,
  JAVA_RUNTIME_CLASSLIB_ASSET_PATH,
  JAVA_RUNTIME_CLASSLIB_SHA256,
} from "../core/toolchains.ts";
import { compileJavaGc, loadJavaGcEngine } from "../compiler/java-gc.ts";

let exitCode = 0;
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const encoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const [compiler, sdk, runtime] = await Promise.all([
    loadAsset(encoded, JAVA_COMPILER_ASSET_PATH, JAVA_COMPILER_SHA256),
    loadAsset(encoded, JAVA_COMPILE_CLASSLIB_ASSET_PATH, JAVA_COMPILE_CLASSLIB_SHA256),
    loadAsset(encoded, JAVA_RUNTIME_CLASSLIB_ASSET_PATH, JAVA_RUNTIME_CLASSLIB_SHA256),
  ]);
  const engine = await loadJavaGcEngine(compiler);
  const { wasm, ...result } = await compileJavaGc(engine, encoded.request, { sdk, runtime });
  writeResult({ ...result, wasmBase64: wasm ? Buffer.from(wasm).toString("base64") : undefined });
} catch (error) {
  writeResult(undefined, error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  setTimeout(() => process.exit(exitCode), 10);
}

async function loadAsset(encoded, assetPath, expected) {
  const file = encoded?.toolchainAssets?.[assetPath];
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    throw new Error(`The Java compiler stage did not receive absolute asset '${assetPath}'.`);
  }
  const bytes = new Uint8Array(await readFile(file));
  if (encoded.verifiedToolchain !== true) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error(`Pinned Java asset '${assetPath}' has digest ${actual}; expected ${expected}.`);
  }
  return bytes;
}

function writeResult(result, error) {
  writeFileSync(3, JSON.stringify(result ? { ok: true, result } : { ok: false, error }));
}
