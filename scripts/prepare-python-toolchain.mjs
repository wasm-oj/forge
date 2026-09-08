import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WASM_OJ_SCHEMAS } from "../src/core/contract.ts";

const run = promisify(execFile);
const VERSION = "3.14.7";
const TARGET = "wasm32-wasip1";
const WASI_LINK_FLAGS = "-z stack-size=4194304 -Wl,--stack-first -Wl,--initial-memory=16777216";
const SOURCE_DATE_EPOCH = "1785925789";
const SOURCE_ARCHIVE_SHA256 = "3b48dac8fb59f62eaa67ac83c1eb12bda1b7a08406dd286e252c11a66be27f81";
const SPDX_SHA256 = "87f55ca6c59fe159fa8c47ba2d7d8bec39cc649b1d3f47c667f34025a2ca9a68";
const WASI_SDK_ARCHIVE_SHA256 = "aeae999396d5f5caa5ce419f52e83c35869d5fd21d40af80acba2c80f51b0b3a";
const EXPECTED_PYTHON_WASM_SHA256 = "69e9d87da6c8a628694ffd76c3d0f26e7aaa0bc91d952a28d9fc37c7144e354c";
const EXPECTED_RUNTIME_FILES = Object.freeze({
  archiveSha256: "c1acac884af1c86833db5b65f8cc0a2304fce74dea0a05d9b40bde0a4e3e7c0e",
  archiveBytes: 10_695_683,
  cacheKey: "wasm-oj-v2:runtime-files:cpython-3.14.7-wasip1-stdlib-stored-zip",
  format: "WOJFS002",
  guestPath: "/cpython/lib/python314.zip",
  zipBytes: 10_695_625,
});
const EXPECTED_OUTPUT_SHA256 = Object.freeze({
  [`python-${VERSION}-wasip1.webc`]: "a42c98f5f00582638c8e445440c506bbf94d5e55b3415d1f8d82d11c56cd4b56",
  [`python-${VERSION}-wasip1.webc.gz.bin`]: "10027f0e32c77dfa0ce1c413b6cb27307d6744fe5e18e6da8cea738bd020260c",
  [`python-${VERSION}-wasip1.manifest.json`]: "53a24b258363a8494af164121111a34b49c85fa0e054627fe131feba6f359cd5",
});
const PUBLISHED_OUTPUTS = [
  `python-${VERSION}-wasip1.webc.gz.bin`,
  `python-${VERSION}-wasip1.manifest.json`,
];

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The pinned WASI SDK 24.0 archive requires an arm64 macOS build host.");
}
if (process.argv.length !== 5) {
  throw new Error([
    "The official CPython source archive, its SPDX document, and WASI SDK archive are required.",
    "Usage: pnpm run toolchain:python:prepare \\",
    "  /absolute/path/to/Python-3.14.7.tar.xz \\",
    "  /absolute/path/to/Python-3.14.7.tar.xz.spdx.json \\",
    "  /absolute/path/to/wasi-sdk-24.0-arm64-macos.tar.gz",
  ].join("\n"));
}

const [sourceArchivePath, spdxPath, wasiSdkArchivePath] = process.argv.slice(2).map((value) => path.resolve(value));
const buildPython = process.env.WASM_OJ_BUILD_PYTHON || "python3";
const wasmer = process.env.WASM_OJ_WASMER || "wasmer";
const outputDirectory = path.resolve("public/toolchains");
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "wasm-oj-python-")));
const sourceExtractRoot = path.join(temporary, "source");
const wasiSdkExtractRoot = path.join(temporary, "wasi-sdk");
const stagedDirectory = path.join(temporary, "published");
const strippedPython = path.join(temporary, "python.wasm");

const environment = deterministicEnvironment(temporary, wasmer);
const hostEnvironment = Object.freeze({
  ...environment,
  py_cv_module__socket: "n/a",
});

try {
  const [sourceArchive, spdxDocument, wasiSdkArchive] = await Promise.all([
    readFile(sourceArchivePath),
    readFile(spdxPath),
    readFile(wasiSdkArchivePath),
  ]);
  requireDigest("CPython source archive", sourceArchive, SOURCE_ARCHIVE_SHA256);
  requireDigest("CPython SPDX document", spdxDocument, SPDX_SHA256);
  requireDigest("WASI SDK archive", wasiSdkArchive, WASI_SDK_ARCHIVE_SHA256);

  await requireBuildPrograms(buildPython, wasmer, environment);
  await Promise.all([
    mkdir(sourceExtractRoot),
    mkdir(wasiSdkExtractRoot),
    mkdir(stagedDirectory),
  ]);
  await runStep("extract CPython", "tar", ["-xf", sourceArchivePath, "-C", sourceExtractRoot], environment);
  await runStep("extract WASI SDK", "tar", ["-xf", wasiSdkArchivePath, "-C", wasiSdkExtractRoot], environment);

  const sourceRoot = path.join(sourceExtractRoot, `Python-${VERSION}`);
  const wasiSdkRoot = path.join(wasiSdkExtractRoot, "wasi-sdk-24.0-arm64-macos");
  const wasiBuildTool = path.join(sourceRoot, "Tools/wasm/wasi");
  const hostRunner = path.join(temporary, "wasmer-host-runner.sh");
  await writeFile(hostRunner, hostRunnerScript(), { encoding: "utf8", mode: 0o755, flag: "wx" });
  const hostRunnerTemplate = [
    shellQuote(hostRunner),
    shellQuote("{HOST_DIR}"),
    shellQuote("{ENV_VAR_NAME}"),
    shellQuote("{ENV_VAR_VALUE}"),
  ].join(" ");

  await runStep("configure native build Python", buildPython, [
    wasiBuildTool,
    "configure-build-python",
    "--clean",
  ], environment, sourceRoot);
  await runStep("build native build Python", buildPython, [
    wasiBuildTool,
    "make-build-python",
  ], environment, sourceRoot);
  await runStep("configure CPython for wasm32-wasip1", buildPython, [
    wasiBuildTool,
    "configure-host",
    "--clean",
    "--wasi-sdk",
    wasiSdkRoot,
    "--host-runner",
    hostRunnerTemplate,
    "--",
    "--without-ensurepip",
    "--disable-test-modules",
  ], hostEnvironment, sourceRoot);
  await runStep("build CPython for wasm32-wasip1", buildPython, [
    wasiBuildTool,
    "make-host",
  ], { ...hostEnvironment, LDFLAGS_NODIST: WASI_LINK_FLAGS }, sourceRoot);

  const hostBuildRoot = path.join(sourceRoot, "cross-build", TARGET);
  await copyFile(path.join(hostBuildRoot, "python.wasm"), strippedPython);
  await runStep("strip reproducible CPython debug sections", path.join(wasiSdkRoot, "bin/llvm-strip"), [
    "--strip-debug",
    strippedPython,
  ], environment);
  requireDigest("stripped CPython wasm32-wasip1 executable", await readFile(strippedPython), EXPECTED_PYTHON_WASM_SHA256);

  await runStep("package canonical Python WebC", "cargo", [
    "run",
    "--locked",
    "--release",
    "--manifest-path",
    path.resolve("tools/package-python-webc/Cargo.toml"),
    "--",
    sourceRoot,
    hostBuildRoot,
    strippedPython,
    spdxPath,
    path.resolve("licenses"),
    stagedDirectory,
    SOURCE_ARCHIVE_SHA256,
    WASI_SDK_ARCHIVE_SHA256,
  ], environment);

  const manifestPath = path.join(stagedDirectory, `python-${VERSION}-wasip1.manifest.json`);
  await validateManifest(manifestPath);
  const runtimeInspectionOutput = await runStep(
    "inspect packaged Python runtime files",
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      path.resolve("scripts/inspect-python-runtime-files.mjs"),
      path.join(stagedDirectory, `python-${VERSION}-wasip1.webc.gz.bin`),
    ],
    environment,
  );
  const inspectionPrefix = "WASM_OJ_PYTHON_INSPECTION:";
  const inspectionLine = runtimeInspectionOutput.stdout
    .split("\n")
    .findLast((line) => line.startsWith(inspectionPrefix));
  if (!inspectionLine) {
    throw new Error(`Python runtime-files inspection emitted no result:\n${runtimeInspectionOutput.stdout}`);
  }
  const runtimeInspection = JSON.parse(inspectionLine.slice(inspectionPrefix.length));
  if (
    runtimeInspection.archiveSha256 !== EXPECTED_RUNTIME_FILES.archiveSha256
    || runtimeInspection.archiveBytes !== EXPECTED_RUNTIME_FILES.archiveBytes
    || JSON.stringify(runtimeInspection.files) !== JSON.stringify({
      [EXPECTED_RUNTIME_FILES.guestPath]: EXPECTED_RUNTIME_FILES.zipBytes,
    })
  ) {
    throw new Error(`Packaged Python runtime-files smoke mismatch: ${JSON.stringify(runtimeInspection)}.`);
  }

  const outputMismatches = [];
  for (const [filename, expected] of Object.entries(EXPECTED_OUTPUT_SHA256)) {
    const actual = sha256(await readFile(path.join(stagedDirectory, filename)));
    if (actual !== expected) outputMismatches.push(`${filename}: expected ${expected}, received ${actual}`);
  }
  if (outputMismatches.length > 0) {
    throw new Error(`Generated Python toolchain digests do not match:\n${outputMismatches.join("\n")}`);
  }

  await mkdir(outputDirectory, { recursive: true });
  for (const filename of PUBLISHED_OUTPUTS) {
    await publishAtomically(path.join(stagedDirectory, filename), path.join(outputDirectory, filename));
  }
  process.stdout.write(`${JSON.stringify({
    version: VERSION,
    target: TARGET,
    sourceArchiveSha256: SOURCE_ARCHIVE_SHA256,
    spdxSha256: SPDX_SHA256,
    wasiSdkArchiveSha256: WASI_SDK_ARCHIVE_SHA256,
    compilerSha256: EXPECTED_PYTHON_WASM_SHA256,
    runtimeFilesSha256: EXPECTED_RUNTIME_FILES.archiveSha256,
    outputs: PUBLISHED_OUTPUTS.map((filename) => path.join(outputDirectory, filename)),
  })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function deterministicEnvironment(tmpdir, wasmerPath) {
  const env = {
    ...process.env,
    WASM_OJ_WASMER: wasmerPath,
    LANG: "C",
    LC_ALL: "C",
    PYTHONHASHSEED: "0",
    SOURCE_DATE_EPOCH,
    TMPDIR: tmpdir,
    TZ: "UTC",
  };
  for (const name of [
    "CC",
    "CFLAGS",
    "CONFIG_SITE",
    "CPPFLAGS",
    "HOSTRUNNER",
    "LDFLAGS",
    "LDFLAGS_NODIST",
    "MAKEFLAGS",
    "ARFLAGS",
    "PYTHONHOME",
    "PYTHONPATH",
    "WASI_SDK_PATH",
    "ZERO_AR_DATE",
    "py_cv_module__socket",
  ]) delete env[name];
  return env;
}

async function requireBuildPrograms(python, wasmerPath, env) {
  const pythonVersion = await runStep("inspect build Python", python, [
    "-c",
    "import json, sys; print(json.dumps(list(sys.version_info[:3])))",
  ], env);
  const version = JSON.parse(pythonVersion.stdout.trim());
  if (!Array.isArray(version) || version[0] !== 3 || version[1] < 11) {
    throw new Error(`CPython's WASI build controller requires Python 3.11 or newer; received ${version.join(".")}.`);
  }
  const wasmerVersion = await runStep("inspect Wasmer host runner", wasmerPath, ["--version"], env);
  if (wasmerVersion.stdout.trim() !== "wasmer 3.3.0") {
    throw new Error(`The reproducible build requires Wasmer CLI 3.3.0; received '${wasmerVersion.stdout.trim()}'.`);
  }
}

async function validateManifest(filename) {
  const manifest = JSON.parse(await readFile(filename, "utf8"));
  if (
    manifest.schema !== WASM_OJ_SCHEMAS.pythonToolchain
    || manifest.version !== VERSION
    || manifest.target !== TARGET
    || manifest.source?.archiveSha256 !== SOURCE_ARCHIVE_SHA256
    || manifest.source?.spdx?.sha256 !== SPDX_SHA256
    || manifest.wasiSdk?.archiveSha256 !== WASI_SDK_ARCHIVE_SHA256
    || manifest.compiler?.sha256 !== EXPECTED_PYTHON_WASM_SHA256
    || manifest.compiler?.command !== "python"
    || manifest.runtimeFiles?.archiveSha256 !== EXPECTED_RUNTIME_FILES.archiveSha256
    || manifest.runtimeFiles?.archiveBytes !== EXPECTED_RUNTIME_FILES.archiveBytes
    || manifest.runtimeFiles?.cacheKey !== EXPECTED_RUNTIME_FILES.cacheKey
    || manifest.runtimeFiles?.format !== EXPECTED_RUNTIME_FILES.format
    || manifest.runtimeFiles?.guestPath !== EXPECTED_RUNTIME_FILES.guestPath
    || manifest.filesystemMount !== "/usr/local"
    || manifest.output?.sha256 !== EXPECTED_OUTPUT_SHA256[`python-${VERSION}-wasip1.webc`]
    || manifest.output?.compressedSha256 !== EXPECTED_OUTPUT_SHA256[`python-${VERSION}-wasip1.webc.gz.bin`]
    || manifest.build?.makeEnvironment?.LDFLAGS_NODIST !== WASI_LINK_FLAGS
    || JSON.stringify(manifest.build?.disabledModules) !== '["_socket"]'
  ) {
    throw new Error("Generated Python manifest does not identify the canonical source, build, target, and package.");
  }
}

async function runStep(label, executable, args, env, cwd) {
  try {
    return await run(executable, args, { cwd, env, maxBuffer: 128 * 1024 * 1024 });
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const transcript = `${stdout}${stderr}`;
    throw new Error(`${label} failed.\n${transcript.slice(-24_000)}`, { cause: error });
  }
}

function hostRunnerScript() {
  return String.raw`#!/bin/sh
set -eu
host_dir=$1
env_name=$2
env_value=$3
source=$4
shift 4
exec "$WASM_OJ_WASMER" run --mapdir "/:$host_dir" --env "$env_name=$env_value" "$source" -- "$@"
`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
    await copyFile(source, adjacent);
    await rename(adjacent, destination);
  } finally {
    await rm(adjacent, { force: true });
  }
}
