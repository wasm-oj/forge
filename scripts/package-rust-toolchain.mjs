import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { brotliDecompressSync } from "node:zlib";

const run = promisify(execFile);
const VERSION = "1.91.1-dev";
const SOURCE_REPOSITORY = "olimpiadi-informatica/wasm-compilers";
const SOURCE_REVISION = "ae62cab6adf0665377d19ffa39daeaf758290431";
const SOURCE_RUN = "26545267884";
const SOURCE_ARCHIVE_SHA256 = "ba0096d05275954d852a3fb3a9c4c9438dad501f8e428b867c0b88cfa7301c14";
const LINKER_VERSION = "22.0.0-git20542-10";
const LINKER_SOURCE_URL = `https://registry.npmjs.org/@yowasp/clang/-/clang-${LINKER_VERSION}.tgz`;
const LINKER_SOURCE_SHA256 = "6230ea1afa9691fa065935cf68c01642ff9b31c183fe8ac64cdfda025df06009";
const LINKER_CORE_SHA256 = "24fbed474c7b5b4968fd73fc4827440b93fb351c1b6264516130300eff3e7bf5";
const LINKER_RESOURCES_SHA256 = "79eef0c336fe55cf03ff8f5b42b784c8168f929a3603138b2c6301f4601e4c86";
const EXPECTED_OUTPUT_SHA256 = Object.freeze({
  [`rust-${VERSION}.webc`]: "765de8d68d03078e79f69f49dec0dcab1ff96fe3bbe5e9eafebb2ce61a39d3ee",
  [`rust-${VERSION}.webc.gz.bin`]: "cfbdadc67be1315e735aa55bdf8a5a0d00171982a023fefcf7ba586127753887",
  [`rust-${VERSION}.manifest.json`]: "14715bd4eeb7dfe9dc806e7f28f404a87f590728f4c622f5de5b71857ceacc21",
});
const PUBLISHED_OUTPUTS = [
  `rust-${VERSION}.webc.gz.bin`,
  `rust-${VERSION}.manifest.json`,
];

const archiveArgument = process.argv[2] || process.env.FORGE_RUST_TOOLCHAIN_ARCHIVE;
if (!archiveArgument) {
  throw new Error([
    "A verified rust.tar.br from the pinned upstream build is required.",
    `Download GitHub Actions run ${SOURCE_RUN} from ${SOURCE_REPOSITORY}, then run:`,
    "pnpm run toolchain:rust:prepare /absolute/path/to/rust.tar.br",
  ].join("\n"));
}

const archivePath = path.resolve(archiveArgument);
const outputDirectory = path.resolve("public/toolchains");
const temporary = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-forge-rust-"));
const extractedRoot = path.join(temporary, "rust");
const stagedDirectory = path.join(temporary, "published");

try {
  const sourceArchive = await readFile(archivePath);
  requireDigest("pinned Rust toolchain archive", sourceArchive, SOURCE_ARCHIVE_SHA256);
  const tarPath = path.join(temporary, "rust.tar");
  await writeFile(tarPath, brotliDecompressSync(sourceArchive), { flag: "wx" });
  await mkdir(extractedRoot);
  await run("tar", ["-xf", tarPath, "-C", extractedRoot], { maxBuffer: 4 * 1024 * 1024 });
  await mkdir(stagedDirectory);

  const linkerArchivePath = path.join(temporary, "clang.tgz");
  const linkerSource = new Uint8Array(await download(LINKER_SOURCE_URL));
  requireDigest("pinned YoWASP linker source archive", linkerSource, LINKER_SOURCE_SHA256);
  await writeFile(linkerArchivePath, linkerSource, { flag: "wx" });
  await run("tar", [
    "-xzf", linkerArchivePath, "-C", temporary,
    "package/gen/llvm.core.wasm",
    "package/gen/llvm-resources.tar",
  ], { maxBuffer: 4 * 1024 * 1024 });
  const linkerCorePath = path.join(temporary, "package/gen/llvm.core.wasm");
  const linkerResourcesPath = path.join(temporary, "package/gen/llvm-resources.tar");
  requireDigest("pinned YoWASP linker core", await readFile(linkerCorePath), LINKER_CORE_SHA256);
  requireDigest("pinned YoWASP linker resources", await readFile(linkerResourcesPath), LINKER_RESOURCES_SHA256);

  await run("cargo", [
    "run", "--locked", "--release",
    "--manifest-path", path.resolve("tools/package-rust-webc/Cargo.toml"),
    "--", extractedRoot, linkerCorePath, linkerResourcesPath, stagedDirectory, SOURCE_ARCHIVE_SHA256,
  ], { maxBuffer: 4 * 1024 * 1024 });

  for (const [filename, expected] of Object.entries(EXPECTED_OUTPUT_SHA256)) {
    requireDigest(filename, await readFile(path.join(stagedDirectory, filename)), expected);
  }
  const manifest = JSON.parse(await readFile(
    path.join(stagedDirectory, `rust-${VERSION}.manifest.json`),
    "utf8",
  ));
  if (
    manifest.version !== VERSION
    || manifest.target !== "wasm32-wasip1-threads"
    || manifest.source?.repository !== `https://github.com/${SOURCE_REPOSITORY}`
    || manifest.source?.revision !== SOURCE_REVISION
    || manifest.source?.archiveSha256 !== SOURCE_ARCHIVE_SHA256
    || manifest.compiler?.command !== "rustc"
    || JSON.stringify(manifest.compiler?.deterministicReplacements) !== JSON.stringify([
      "wasi_snapshot_preview1.random_get",
      "wasi_snapshot_preview1.clock_time_get",
    ])
    || manifest.linker?.version !== LINKER_VERSION
    || manifest.linker?.source !== `@yowasp/clang@${LINKER_VERSION}`
    || manifest.linker?.sourceSha256 !== LINKER_SOURCE_SHA256
    || manifest.linker?.coreSha256 !== LINKER_CORE_SHA256
    || manifest.linker?.resourcesSha256 !== LINKER_RESOURCES_SHA256
    || manifest.linker?.command !== "wasm-ld"
    || manifest.pipeline?.strategy !== "rustc-object-then-wasm-ld"
    || manifest.pipeline?.objectEmission !== "rustc --emit=obj -C save-temps=yes"
    || manifest.pipeline?.allocatorShim !== "rustc-generated LLVM bitcode"
    || manifest.pipeline?.linkArgsSource !== "rustc --print=link-args"
    || manifest.filesystemMounts?.rust !== "/rust"
    || manifest.filesystemMounts?.linker !== "/usr"
  ) {
    throw new Error("Generated Rust toolchain manifest does not identify the pinned compiler, linker, pipeline, and target.");
  }

  await mkdir(outputDirectory, { recursive: true });
  for (const filename of PUBLISHED_OUTPUTS) {
    await publishAtomically(
      path.join(stagedDirectory, filename),
      path.join(outputDirectory, filename),
    );
  }
  process.stdout.write(`${JSON.stringify({
    version: VERSION,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    sourceArchiveSha256: SOURCE_ARCHIVE_SHA256,
    linkerSource: LINKER_SOURCE_URL,
    linkerSourceSha256: LINKER_SOURCE_SHA256,
    outputs: PUBLISHED_OUTPUTS.map((filename) => path.join(outputDirectory, filename)),
  })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to download ${url}: ${response.status}.`);
  return response.arrayBuffer();
}

function requireDigest(label, value, expected) {
  const actual = createHash("sha256").update(value).digest("hex");
  if (actual !== expected) {
    throw new Error(`${label} digest mismatch: expected ${expected}, received ${actual}.`);
  }
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
