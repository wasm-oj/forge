import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SOURCE_VERSION = "22.0.0-git20542-10";
const VERSION = SOURCE_VERSION;
const SOURCE_URL = `https://registry.npmjs.org/@yowasp/clang/-/clang-${SOURCE_VERSION}.tgz`;
const SOURCE_SHA256 = "6230ea1afa9691fa065935cf68c01642ff9b31c183fe8ac64cdfda025df06009";
const CORE_SHA256 = "24fbed474c7b5b4968fd73fc4827440b93fb351c1b6264516130300eff3e7bf5";
const RESOURCES_SHA256 = "79eef0c336fe55cf03ff8f5b42b784c8168f929a3603138b2c6301f4601e4c86";
const OUTPUT_SHA256 = Object.freeze({
  [`clang-${VERSION}.webc.gz.bin`]: "7f10d90b8e52b270f04874641a1d0bf9e94e85b4f6c7573a774cebbc6d32552a",
  [`clang-${VERSION}.manifest.json`]: "6382dcdfb6a2da49032a0e08da3b1fb490eb24432be85c3c12e3e871a5065273",
  [`clang-${VERSION}.cc1-pins.json`]: "895eee17c63b1112c84adcc4ddbcb38e0c18e53bff15f50a8689b9b82d87b1ff",
  [`clang-${VERSION}.libcxx-pch.json`]: "9bbe41d77c786f1c36169369c909268530b05726e1581683f6edd9a2983eebd0",
  [`clang-${VERSION}.cpp-debug.pch.gz.bin`]: "a3811351bae3289caf096f2d4bb6d2ee5db84b97e05514e87190d36b65c500cf",
  [`clang-${VERSION}.cpp-release.pch.gz.bin`]: "ef004fc05ec50af697a37f7c9c814bf62e9676d0de162d6ac35305533939f93f",
});
const OUTPUT_DIRECTORY = path.resolve("public/toolchains");
const temporary = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-clang-"));
const stagedDirectory = path.join(temporary, "published");

try {
  await mkdir(stagedDirectory, { recursive: true });
  const archivePath = path.join(temporary, "clang.tgz");
  const source = new Uint8Array(await download(SOURCE_URL));
  requireDigest("YoWASP Clang source archive", source, SOURCE_SHA256);
  await writeFile(archivePath, source);
  await run("tar", [
    "-xzf", archivePath, "-C", temporary,
    "package/gen/llvm.core.wasm",
    "package/gen/llvm-resources.tar",
  ]);

  const corePath = path.join(temporary, "package/gen/llvm.core.wasm");
  const resourcesPath = path.join(temporary, "package/gen/llvm-resources.tar");
  requireDigest("YoWASP Clang core", await readFile(corePath), CORE_SHA256);
  requireDigest("YoWASP Clang resources", await readFile(resourcesPath), RESOURCES_SHA256);

  await run("cargo", [
    "run", "--locked", "--release", "--manifest-path", path.resolve("tools/package-yowasp-clang/Cargo.toml"),
    "--", corePath, resourcesPath, stagedDirectory, SOURCE_SHA256,
  ]);
  await run("node", [
    "--experimental-strip-types", "--disable-warning=ExperimentalWarning",
    path.resolve("scripts/pin-clang-cc1-argv.mjs"),
  ], { WASM_OJ_CLANG_TOOLCHAIN_DIRECTORY: stagedDirectory });
  await run("node", [
    "--experimental-strip-types", "--disable-warning=ExperimentalWarning",
    path.resolve("scripts/build-clang-libcxx-pch.ts"),
  ], { WASM_OJ_CLANG_TOOLCHAIN_DIRECTORY: stagedDirectory });

  for (const [filename, expected] of Object.entries(OUTPUT_SHA256)) {
    requireDigest(filename, await readFile(path.join(stagedDirectory, filename)), expected);
  }
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  for (const filename of Object.keys(OUTPUT_SHA256)) {
    await publishAtomically(
      path.join(stagedDirectory, filename),
      path.join(OUTPUT_DIRECTORY, filename),
    );
  }
  console.log(JSON.stringify({
    version: VERSION,
    source: SOURCE_URL,
    sourceSha256: SOURCE_SHA256,
    outputs: Object.keys(OUTPUT_SHA256).map((name) => path.join(OUTPUT_DIRECTORY, name)),
  }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to download ${url}: ${response.status}.`);
  return response.arrayBuffer();
}

function requireDigest(label, value, expected) {
  const actual = sha256(value);
  if (actual !== expected) {
    throw new Error(`${label} digest mismatch: expected ${expected}, received ${actual}.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function publishAtomically(source, destination) {
  const adjacent = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, adjacent, undefined);
    await rename(adjacent, destination);
  } finally {
    await rm(adjacent, { force: true });
  }
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with code ${code}.`)));
  });
}
