import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { FORGE_SCHEMAS } from "../src/core/contract.ts";
import {
  CLANG_CC1_PINS_ASSET_PATH,
  CLANG_VERSION,
  GO_PACKAGE_ASSET_PATH,
  GO_PACKAGE_MANIFEST_ASSET_PATH,
  GO_STANDARD_LIBRARY_ASSET_PATH,
  GO_VERSION,
  PINNED_TOOLCHAIN_ASSET_SHA256,
  QUICKJS_ASSET_PATH,
  PYTHON_COMPRESSED_PACKAGE_SHA256,
  PYTHON_PACKAGE_ASSET_PATH,
  PYTHON_PACKAGE_MANIFEST_ASSET_PATH,
  PYTHON_PACKAGE_SHA256,
  PYTHON_RUNTIME_FILES_ARCHIVE_SHA256,
  PYTHON_VERSION,
  RUST_COMPRESSED_PACKAGE_SHA256,
  RUST_PACKAGE_ASSET_PATH,
  RUST_PACKAGE_MANIFEST_ASSET_PATH,
  RUST_PACKAGE_SHA256,
  RUST_VERSION,
} from "../src/core/toolchains.ts";
import {
  RUST_DETERMINISTIC_REPLACEMENTS,
  RUST_TARGET_TRIPLE,
  decodeRustToolchainManifest,
} from "../src/compiler/rust-toolchain.ts";
import { PYTHON_TARGET_TRIPLE } from "../src/compiler/python-toolchain.ts";
import {
  decodeGoStandardLibrary,
  decodeGoToolchainManifest,
} from "../src/compiler/go-toolchain.ts";

const run = promisify(execFile);
const QUICKJS_WASM_SHA256 = "21fcf23a5fdf3e64b803344c9af86be01e95feabf4779d02aef325c852bc2c2e";
const QUICKJS_LLVM_PRODUCER = "18.1.2-wasi-sdk (https://github.com/llvm/llvm-project 26a1d6601d727a96f4301d0d8647b5a42760ae0c)";
const QUICKJS_IMPORTS = Object.freeze([
  "wasi_snapshot_preview1.args_get:function",
  "wasi_snapshot_preview1.args_sizes_get:function",
  "wasi_snapshot_preview1.environ_get:function",
  "wasi_snapshot_preview1.environ_sizes_get:function",
  "wasi_snapshot_preview1.clock_time_get:function",
  "wasi_snapshot_preview1.fd_close:function",
  "wasi_snapshot_preview1.fd_fdstat_get:function",
  "wasi_snapshot_preview1.fd_prestat_get:function",
  "wasi_snapshot_preview1.fd_prestat_dir_name:function",
  "wasi_snapshot_preview1.fd_read:function",
  "wasi_snapshot_preview1.fd_seek:function",
  "wasi_snapshot_preview1.fd_write:function",
  "wasi_snapshot_preview1.poll_oneoff:function",
  "wasi_snapshot_preview1.proc_exit:function",
]);
const QUICKJS_EXPORTS = Object.freeze(["memory:memory", "_start:function"]);
const DEBUG_CUSTOM_SECTIONS = Object.freeze([
  ".debug_loc",
  ".debug_abbrev",
  ".debug_info",
  ".debug_str",
  ".debug_line",
  ".debug_ranges",
  ".debug_pubnames",
  ".debug_pubtypes",
]);
const RUST_SOURCE = Object.freeze({
  repository: "https://github.com/olimpiadi-informatica/wasm-compilers",
  revision: "ae62cab6adf0665377d19ffa39daeaf758290431",
  archiveSha256: "ba0096d05275954d852a3fb3a9c4c9438dad501f8e428b867c0b88cfa7301c14",
});
const RUST_LINKER_SOURCE = Object.freeze({
  version: "22.0.0-git20542-10",
  package: "@yowasp/clang@22.0.0-git20542-10",
  sourceSha256: "6230ea1afa9691fa065935cf68c01642ff9b31c183fe8ac64cdfda025df06009",
  coreSha256: "24fbed474c7b5b4968fd73fc4827440b93fb351c1b6264516130300eff3e7bf5",
  resourcesSha256: "79eef0c336fe55cf03ff8f5b42b784c8168f929a3603138b2c6301f4601e4c86",
});
const PYTHON_SOURCE = Object.freeze({
  url: "https://www.python.org/ftp/python/3.14.6/Python-3.14.6.tar.xz",
  archiveSha256: "143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63",
  spdxSha256: "1f5d394856783fa77e1f1db280f84eabf693bffc1fb06a747f7116de9f99f3bd",
  compilerSha256: "f104b9da093f806451d7bba3f7eca41033842a5ec88ac256689e6e3cc1f1e2e1",
});
const PYTHON_WASI_SDK = Object.freeze({
  version: "24.0",
  revision: "d2bea01edcc46f731156a817f710cdd9fc9c1c19",
  llvmRevision: "26a1d6601d727a96f4301d0d8647b5a42760ae0c",
  wasiLibcRevision: "b9ef79d7dbd47c6c5bafdae760823467c2f60b70",
  archiveSha256: "aeae999396d5f5caa5ce419f52e83c35869d5fd21d40af80acba2c80f51b0b3a",
});
const PYTHON_LICENSE_SHA256 = Object.freeze([
  "b0e25a78cffb43f4d92de8b61ccfa1f1f98ecbc22330b54b5251e7b6ba010231",
  "31b15de82aa19a845156169a17a5488bf597e561b2c318d159ed583139b25e87",
  "328a079d376d3e1e966317c647906004d38d42b7624531456b90ae1b710ddc0c",
  "669512af7219f58be03a398766d7c9da11a3b3df9d3f05cb74c5ceca25c8da3b",
  "268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5",
  "1a8f1058753f1ba890de984e48f0242a3a5c29a6a8f2ed9fd813f36985387e8d",
  "673f577e363e80e0058bd78214683f045d1d0c63930969a87f01a1d87d7cf1d6",
  "a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2",
  "23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3",
  "c8b789cf5a746611e6300a0cc7750dbf92b61912a709d04e639245f7290656d0",
  "5f7892f12d4d3eef88c379564dd1580e99d918e1128cabe1ec2cc3057727b6a2",
  "b33ff4cd6bfb1eb7e600546b5b2c95f25145ef2fecd72d6976a5263996a5594f",
  "f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af",
].sort());
const GO_SOURCE = Object.freeze({
  url: "https://go.dev/dl/go1.26.5.src.tar.gz",
  sha256: "495be4bc87176ac567392e5b4116abd98466d33d7b49d41e764ccc6976b2dc42",
});

const directory = path.resolve("public/toolchains");
const declared = Object.entries(PINNED_TOOLCHAIN_ASSET_SHA256)
  .map(([assetPath, sha256]) => ({ filename: path.basename(assetPath), sha256 }))
  .sort((left, right) => left.filename.localeCompare(right.filename));
const actualFiles = (await readdir(directory))
  .filter((filename) => filename !== "README.md")
  .sort();
const expectedFiles = declared.map(({ filename }) => filename);
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(
    `Toolchain directory differs from the canonical asset set.\nExpected: ${expectedFiles.join(", ")}\nReceived: ${actualFiles.join(", ")}`,
  );
}

for (const { filename, sha256: expected } of declared) {
  const file = path.join(directory, filename);
  const metadata = await stat(file);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o644) {
    throw new Error(`Toolchain asset '${filename}' must be a regular file with mode 0644.`);
  }
  const bytes = await readFile(file);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Toolchain digest mismatch for '${filename}': expected ${expected}, received ${actual}.`);
  }
  process.stdout.write(`${actual}  ${filename}\n`);
}

const quickJsCompressed = await readFile(path.join(directory, path.basename(QUICKJS_ASSET_PATH)));
const quickJsWasm = gunzipSync(quickJsCompressed);
const quickJsWasmSha256 = createHash("sha256").update(quickJsWasm).digest("hex");
if (quickJsWasmSha256 !== QUICKJS_WASM_SHA256) {
  throw new Error(`Expanded QuickJS digest mismatch: expected ${QUICKJS_WASM_SHA256}, received ${quickJsWasmSha256}.`);
}
const quickJsModule = new WebAssembly.Module(quickJsWasm);
const quickJsImports = WebAssembly.Module.imports(quickJsModule)
  .map(({ module, name, kind }) => `${module}.${name}:${kind}`);
const quickJsExports = WebAssembly.Module.exports(quickJsModule)
  .map(({ name, kind }) => `${name}:${kind}`);
if (JSON.stringify(quickJsImports) !== JSON.stringify(QUICKJS_IMPORTS)) {
  throw new Error(`QuickJS has an unexpected import contract: ${quickJsImports.join(", ")}.`);
}
if (JSON.stringify(quickJsExports) !== JSON.stringify(QUICKJS_EXPORTS)) {
  throw new Error(`QuickJS has an unexpected export contract: ${quickJsExports.join(", ")}.`);
}
const retainedDebugSections = DEBUG_CUSTOM_SECTIONS.filter(
  (name) => WebAssembly.Module.customSections(quickJsModule, name).length !== 0,
);
if (retainedDebugSections.length !== 0) {
  throw new Error(`Stripped QuickJS retains debug sections: ${retainedDebugSections.join(", ")}.`);
}
const quickJsProducers = WebAssembly.Module.customSections(quickJsModule, "producers");
if (
  quickJsProducers.length !== 1
  || !new TextDecoder().decode(quickJsProducers[0]).includes(QUICKJS_LLVM_PRODUCER)
) {
  throw new Error("QuickJS does not identify the pinned WASI SDK 24 LLVM producer.");
}
for (const forbidden of ["/Users/", "/private/tmp/", "Homebrew clang"]) {
  if (quickJsWasm.includes(Buffer.from(forbidden))) {
    throw new Error(`QuickJS contains a non-reproducible build-host marker '${forbidden}'.`);
  }
}
process.stdout.write("verified QuickJS expanded digest, WASI import/export contract, stripping, and producer\n");

const pins = JSON.parse(await readFile(
  path.join(directory, path.basename(CLANG_CC1_PINS_ASSET_PATH)),
  "utf8",
));
if (pins.schema !== FORGE_SCHEMAS.clangPins) {
  throw new Error(`Unexpected Clang pins schema '${String(pins.schema)}'.`);
}
if (pins.version !== CLANG_VERSION || pins.source !== `clang-${CLANG_VERSION}.webc`) {
  throw new Error("Clang pins do not identify the canonical package.");
}
const expectedPlaceholders = {
  input: "__FORGE_INPUT__",
  output: "__FORGE_OUTPUT__",
  mainFileName: "__FORGE_MAIN_FILE_NAME__",
  objects: "__FORGE_OBJECTS__",
};
if (JSON.stringify(pins.placeholders) !== JSON.stringify(expectedPlaceholders)) {
  throw new Error("Clang pins contain non-canonical placeholders.");
}

const rustManifestBytes = await readFile(
  path.join(directory, path.basename(RUST_PACKAGE_MANIFEST_ASSET_PATH)),
);
const rustManifest = JSON.parse(rustManifestBytes.toString("utf8"));
decodeRustToolchainManifest(new Uint8Array(rustManifestBytes));
if (
  rustManifest.schema !== FORGE_SCHEMAS.rustToolchain
  || rustManifest.version !== RUST_VERSION
  || rustManifest.target !== RUST_TARGET_TRIPLE
  || rustManifest.compiler?.command !== "rustc"
  || JSON.stringify(rustManifest.compiler?.deterministicReplacements) !== JSON.stringify(RUST_DETERMINISTIC_REPLACEMENTS)
  || rustManifest.source?.repository !== RUST_SOURCE.repository
  || rustManifest.source?.revision !== RUST_SOURCE.revision
  || rustManifest.source?.archiveSha256 !== RUST_SOURCE.archiveSha256
  || rustManifest.linker?.version !== RUST_LINKER_SOURCE.version
  || rustManifest.linker?.source !== RUST_LINKER_SOURCE.package
  || rustManifest.linker?.sourceSha256 !== RUST_LINKER_SOURCE.sourceSha256
  || rustManifest.linker?.coreSha256 !== RUST_LINKER_SOURCE.coreSha256
  || rustManifest.linker?.resourcesSha256 !== RUST_LINKER_SOURCE.resourcesSha256
  || rustManifest.linker?.command !== "wasm-ld"
  || rustManifest.pipeline?.strategy !== "rustc-object-then-wasm-ld"
  || rustManifest.pipeline?.objectEmission !== "rustc --emit=obj -C save-temps=yes"
  || rustManifest.pipeline?.allocatorShim !== "rustc-generated LLVM bitcode"
  || rustManifest.pipeline?.linkArgsSource !== "rustc --print=link-args"
  || rustManifest.filesystemMounts?.rust !== "/rust"
  || rustManifest.filesystemMounts?.linker !== "/usr"
  || rustManifest.output?.sha256 !== RUST_PACKAGE_SHA256
  || rustManifest.output?.compressedSha256 !== RUST_COMPRESSED_PACKAGE_SHA256
) {
  throw new Error("Rust manifest does not identify the canonical package, source, and target.");
}

const rustPackageFilename = path.basename(rustManifest.output?.path ?? "");
const expectedRustPackageFilename = path.basename(RUST_PACKAGE_ASSET_PATH);
if (rustPackageFilename !== expectedRustPackageFilename) {
  throw new Error(`Rust manifest names unexpected package '${rustPackageFilename}'.`);
}

const pythonManifest = JSON.parse(await readFile(
  path.join(directory, path.basename(PYTHON_PACKAGE_MANIFEST_ASSET_PATH)),
  "utf8",
));
const pythonLicenseDigests = (pythonManifest.licenses ?? [])
  .map((license) => license?.sha256)
  .sort();
if (
  pythonManifest.schema !== FORGE_SCHEMAS.pythonToolchain
  || pythonManifest.version !== PYTHON_VERSION
  || pythonManifest.target !== PYTHON_TARGET_TRIPLE
  || pythonManifest.source?.url !== PYTHON_SOURCE.url
  || pythonManifest.source?.archiveSha256 !== PYTHON_SOURCE.archiveSha256
  || pythonManifest.source?.spdx?.sha256 !== PYTHON_SOURCE.spdxSha256
  || pythonManifest.compiler?.sha256 !== PYTHON_SOURCE.compilerSha256
  || pythonManifest.compiler?.command !== "python"
  || !pythonManifest.compiler?.imports?.includes("wasi_snapshot_preview1.clock_time_get")
  || !pythonManifest.compiler?.imports?.includes("wasi_snapshot_preview1.random_get")
  || pythonManifest.compiler?.imports?.some((name) => !name.startsWith("wasi_snapshot_preview1.") || name.includes("sock_"))
  || pythonManifest.wasiSdk?.version !== PYTHON_WASI_SDK.version
  || pythonManifest.wasiSdk?.revision !== PYTHON_WASI_SDK.revision
  || pythonManifest.wasiSdk?.llvmRevision !== PYTHON_WASI_SDK.llvmRevision
  || pythonManifest.wasiSdk?.wasiLibcRevision !== PYTHON_WASI_SDK.wasiLibcRevision
  || pythonManifest.wasiSdk?.archiveSha256 !== PYTHON_WASI_SDK.archiveSha256
  || JSON.stringify(pythonManifest.build?.disabledModules) !== '["_socket"]'
  || pythonManifest.runtimeFiles?.archiveSha256 !== PYTHON_RUNTIME_FILES_ARCHIVE_SHA256
  || pythonManifest.runtimeFiles?.archiveBytes !== 10_652_546
  || pythonManifest.runtimeFiles?.cacheKey !== "wasm-oj-forge-v1:runtime-files:cpython-3.14.6-wasip1-stdlib-stored-zip"
  || pythonManifest.runtimeFiles?.format !== "FORGEFS1"
  || pythonManifest.runtimeFiles?.guestPath !== "/cpython/lib/python314.zip"
  || pythonManifest.filesystemMount !== "/usr/local"
  || JSON.stringify(pythonLicenseDigests) !== JSON.stringify(PYTHON_LICENSE_SHA256)
  || pythonManifest.output?.sha256 !== PYTHON_PACKAGE_SHA256
  || pythonManifest.output?.compressedSha256 !== PYTHON_COMPRESSED_PACKAGE_SHA256
) {
  throw new Error("Python manifest does not identify the canonical source, build, licenses, target, and package.");
}

const pythonPackageFilename = path.basename(pythonManifest.output?.path ?? "");
const expectedPythonPackageFilename = path.basename(PYTHON_PACKAGE_ASSET_PATH);
if (pythonPackageFilename !== expectedPythonPackageFilename) {
  throw new Error(`Python manifest names unexpected package '${pythonPackageFilename}'.`);
}

const goManifestBytes = await readFile(
  path.join(directory, path.basename(GO_PACKAGE_MANIFEST_ASSET_PATH)),
);
const goManifest = JSON.parse(goManifestBytes.toString("utf8"));
const goContract = decodeGoToolchainManifest(new Uint8Array(goManifestBytes));
if (
  goManifest.version !== GO_VERSION
  || goManifest.source?.distributionUrl !== GO_SOURCE.url
  || goManifest.source?.distributionSha256 !== GO_SOURCE.sha256
  || goManifest.output?.path !== path.basename(GO_PACKAGE_ASSET_PATH)
  || goManifest.standardLibrary?.path !== path.basename(GO_STANDARD_LIBRARY_ASSET_PATH)
) {
  throw new Error("Go manifest does not identify the canonical source, package, and standard library.");
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-forge-verify-webc-"));
try {
  const compressed = await readFile(path.join(directory, rustPackageFilename));
  const webcPath = path.join(temporary, `rust-${RUST_VERSION}.webc`);
  await writeFile(webcPath, gunzipSync(compressed), { flag: "wx" });
  await run("cargo", [
    "run", "--locked", "--release", "--quiet",
    "--manifest-path", path.resolve("tools/package-rust-webc/Cargo.toml"),
    "--", "--verify", webcPath,
  ], { maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write("verified Rust WebC entrypoint, command ownership, atom set, and filesystem mapping\n");

  const pythonCompressed = await readFile(path.join(directory, pythonPackageFilename));
  const pythonWebcPath = path.join(temporary, `python-${PYTHON_VERSION}-wasip1.webc`);
  await writeFile(pythonWebcPath, gunzipSync(pythonCompressed), { flag: "wx" });
  await run("cargo", [
    "run", "--locked", "--release", "--quiet",
    "--manifest-path", path.resolve("tools/package-python-webc/Cargo.toml"),
    "--", "--verify", pythonWebcPath,
  ], { maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write("verified Python WebC entrypoint, command ownership, atom/import set, filesystem mapping, and packaged sysconfig\n");

  const goCompressed = await readFile(path.join(directory, path.basename(GO_PACKAGE_ASSET_PATH)));
  const goWebcPath = path.join(temporary, `go-${GO_VERSION}-wasip1.webc`);
  await writeFile(goWebcPath, gunzipSync(goCompressed), { flag: "wx" });
  await run("cargo", [
    "run", "--locked", "--release", "--quiet",
    "--manifest-path", path.resolve("tools/package-go-webc/Cargo.toml"),
    "--", "--verify", goWebcPath,
  ], { maxBuffer: 4 * 1024 * 1024 });
  const goStandardLibrary = gunzipSync(await readFile(
    path.join(directory, path.basename(GO_STANDARD_LIBRARY_ASSET_PATH)),
  ));
  const goFiles = decodeGoStandardLibrary(new Uint8Array(goStandardLibrary), goContract.packages);
  if (Object.keys(goFiles).length !== goContract.packages.length + 1) {
    throw new Error("Go standard-library archive does not match its canonical package index.");
  }
  process.stdout.write("verified Go WebC commands and deterministic standard-library archive\n");

  const inspection = await run(process.execPath, [
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    path.resolve("scripts/inspect-python-runtime-files.mjs"),
    path.join(directory, pythonPackageFilename),
  ], { maxBuffer: 16 * 1024 * 1024 });
  const prefix = "FORGE_PYTHON_INSPECTION:";
  const line = inspection.stdout.split("\n").findLast((entry) => entry.startsWith(prefix));
  if (!line) throw new Error(`Python runtime inspection emitted no result:\n${inspection.stdout}`);
  const result = JSON.parse(line.slice(prefix.length));
  if (
    result.archiveSha256 !== PYTHON_RUNTIME_FILES_ARCHIVE_SHA256
    || result.archiveBytes !== 10_652_546
    || JSON.stringify(result.files) !== JSON.stringify({ "/cpython/lib/python314.zip": 10_652_488 })
  ) {
    throw new Error(`Python runtime-files archive differs from the manifest: ${JSON.stringify(result)}.`);
  }
  process.stdout.write("verified Python 3.14.6 runtime smoke and deterministic runtime-files archive\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
