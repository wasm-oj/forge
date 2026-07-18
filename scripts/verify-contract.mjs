import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  FORGE_CONTRACT_ID,
  FORGE_CONTRACT_VERSION,
  FORGE_SCHEMAS,
  FORGE_STORAGE,
} from "../src/core/contract.ts";

const root = process.cwd();

await requireSource(
  "public/toolchain-cache-sw.js",
  `const CACHE_NAME = "${FORGE_STORAGE.toolchainCache}";`,
);
await requireSource(
  "crates/runtime-core/src/contract.rs",
  `pub const FORGE_CONTRACT_VERSION: u32 = ${FORGE_CONTRACT_VERSION};`,
  `pub const FORGE_COMPILE_BATCH_SCHEMA: &str = "${FORGE_SCHEMAS.compileBatch}";`,
  `pub const FORGE_INTERACTIVE_REQUEST_SCHEMA: &str = "${FORGE_SCHEMAS.interactiveRequest}";`,
  `pub const FORGE_RUN_REQUEST_SCHEMA: &str = "${FORGE_SCHEMAS.runRequest}";`,
);
await requireSource(
  "tools/package-yowasp-clang/src/main.rs",
  `"schema": "${FORGE_SCHEMAS.clangToolchain}"`,
);
await requireSource(
  "tools/package-rust-webc/src/main.rs",
  `"schema": "${FORGE_SCHEMAS.rustToolchain}"`,
);
await requireSource(
  "tools/package-go-webc/src/main.rs",
  `"schema": "${FORGE_SCHEMAS.goToolchain}"`,
);
await requireSource(
  "tools/package-python-webc/src/main.rs",
  `"schema": "${FORGE_SCHEMAS.pythonToolchain}"`,
);

const pins = await readJson("public/toolchains/clang-22.0.0-git20542-10.cc1-pins.json");
const manifest = await readJson("public/toolchains/clang-22.0.0-git20542-10.manifest.json");
const rustManifest = await readJson("public/toolchains/rust-1.91.1-dev.manifest.json");
const pythonManifest = await readJson("public/toolchains/python-3.14.6-wasip1.manifest.json");
const goManifest = await readJson("public/toolchains/go-1.26.5-wasip1.manifest.json");
if (pins.schema !== FORGE_SCHEMAS.clangPins) throw new Error("Clang pins use a different Forge contract.");
if (manifest.schema !== FORGE_SCHEMAS.clangToolchain) throw new Error("Clang manifest uses a different Forge contract.");
if (rustManifest.schema !== FORGE_SCHEMAS.rustToolchain) throw new Error("Rust manifest uses a different Forge contract.");
if (pythonManifest.schema !== FORGE_SCHEMAS.pythonToolchain) throw new Error("Python manifest uses a different Forge contract.");
if (goManifest.schema !== FORGE_SCHEMAS.goToolchain) throw new Error("Go manifest uses a different Forge contract.");
if (!pythonManifest.runtimeFiles?.cacheKey?.startsWith(`${FORGE_STORAGE.runtimeFilesCache}:`)) {
  throw new Error("Python runtime files use a different Forge cache contract.");
}

process.stdout.write(`Forge contract ${FORGE_CONTRACT_ID} drift checks passed.\n`);

async function requireSource(relative, ...needles) {
  const source = await readFile(path.join(root, relative), "utf8");
  for (const needle of needles) {
    const count = source.split(needle).length - 1;
    if (count !== 1) throw new Error(`Expected exactly one '${needle}' in '${relative}', received ${count}.`);
  }
}

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
}
