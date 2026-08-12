import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  WASM_OJ_CONTRACT_ID,
  WASM_OJ_CONTRACT_VERSION,
  WASM_OJ_SCHEMAS,
  WASM_OJ_STORAGE,
} from "../src/core/contract.ts";

const root = process.cwd();

await requireSource(
  "public/toolchain-cache-sw.js",
  `const CACHE_NAME = "${WASM_OJ_STORAGE.toolchainCache}";`,
);
await requireSource(
  "crates/runtime-core/src/contract.rs",
  `pub const WASM_OJ_CONTRACT_VERSION: u32 = ${WASM_OJ_CONTRACT_VERSION};`,
  `pub const WASM_OJ_COMPILE_BATCH_SCHEMA: &str = "${WASM_OJ_SCHEMAS.compileBatch}";`,
  `pub const WASM_OJ_INTERACTIVE_REQUEST_SCHEMA: &str = "${WASM_OJ_SCHEMAS.interactiveRequest}";`,
  `pub const WASM_OJ_RUN_REQUEST_SCHEMA: &str = "${WASM_OJ_SCHEMAS.runRequest}";`,
);
await requireSource(
  "tools/package-yowasp-clang/src/main.rs",
  `"schema": "${WASM_OJ_SCHEMAS.clangToolchain}"`,
);
await requireSource(
  "tools/package-rust-webc/src/main.rs",
  `"schema": "${WASM_OJ_SCHEMAS.rustToolchain}"`,
);
await requireSource(
  "tools/package-go-webc/src/main.rs",
  `"schema": "${WASM_OJ_SCHEMAS.goToolchain}"`,
);
await requireSource(
  "tools/package-python-webc/src/main.rs",
  `"schema": "${WASM_OJ_SCHEMAS.pythonToolchain}"`,
);

const crossOriginPolicyFiles = [
  "README.md",
  "docs/architecture.md",
  "docs/integration-guide.md",
  "docs/library-contract.md",
  "public/_headers",
  "scripts/start-production.mjs",
  "vite.config.ts",
  "worker/security-headers.ts",
];
for (const relative of crossOriginPolicyFiles) {
  await rejectSource(relative, "credentialless");
}
await requireSource(
  "vite.config.ts",
  `"Cross-Origin-Embedder-Policy": "require-corp"`,
  `"Cross-Origin-Opener-Policy": "same-origin"`,
);
await requireSource(
  "worker/security-headers.ts",
  `headers.set("Cross-Origin-Embedder-Policy", "require-corp")`,
  `headers.set("Cross-Origin-Opener-Policy", "same-origin")`,
  `headers.set("Cross-Origin-Resource-Policy", "same-origin")`,
);
await requireSource(
  "scripts/start-production.mjs",
  `response.setHeader("Cross-Origin-Embedder-Policy", "require-corp")`,
  `response.setHeader("Cross-Origin-Opener-Policy", "same-origin")`,
  `response.setHeader("Cross-Origin-Resource-Policy", "same-origin")`,
);
await requireSource(
  "public/_headers",
  "Cross-Origin-Embedder-Policy: require-corp",
  "Cross-Origin-Opener-Policy: same-origin",
  "Cross-Origin-Resource-Policy: same-origin",
);

const pins = await readJson("public/toolchains/clang-22.0.0-git20542-10.cc1-pins.json");
const manifest = await readJson("public/toolchains/clang-22.0.0-git20542-10.manifest.json");
const rustManifest = await readJson("public/toolchains/rust-1.91.1-dev.manifest.json");
const pythonManifest = await readJson("public/toolchains/python-3.14.6-wasip1.manifest.json");
const goManifest = await readJson("public/toolchains/go-1.26.5-wasip1.manifest.json");
if (pins.schema !== WASM_OJ_SCHEMAS.clangPins) throw new Error("Clang pins use a different WASM-OJ contract.");
if (manifest.schema !== WASM_OJ_SCHEMAS.clangToolchain) throw new Error("Clang manifest uses a different WASM-OJ contract.");
if (rustManifest.schema !== WASM_OJ_SCHEMAS.rustToolchain) throw new Error("Rust manifest uses a different WASM-OJ contract.");
if (pythonManifest.schema !== WASM_OJ_SCHEMAS.pythonToolchain) throw new Error("Python manifest uses a different WASM-OJ contract.");
if (goManifest.schema !== WASM_OJ_SCHEMAS.goToolchain) throw new Error("Go manifest uses a different WASM-OJ contract.");
if (!pythonManifest.runtimeFiles?.cacheKey?.startsWith(`${WASM_OJ_STORAGE.runtimeFilesCache}:`)) {
  throw new Error("Python runtime files use a different WASM-OJ cache contract.");
}

process.stdout.write(`WASM-OJ contract ${WASM_OJ_CONTRACT_ID} drift checks passed.\n`);

async function requireSource(relative, ...needles) {
  const source = await readFile(path.join(root, relative), "utf8");
  for (const needle of needles) {
    const count = source.split(needle).length - 1;
    if (count !== 1) throw new Error(`Expected exactly one '${needle}' in '${relative}', received ${count}.`);
  }
}

async function rejectSource(relative, needle) {
  const source = await readFile(path.join(root, relative), "utf8");
  if (source.includes(needle)) throw new Error(`Unexpected '${needle}' in '${relative}'.`);
}

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
}
