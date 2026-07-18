import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const VERSION = "1.26.5";
const SOURCE_DISTRIBUTION_URL = `https://go.dev/dl/go${VERSION}.src.tar.gz`;
const SOURCE_DISTRIBUTION_SHA256 = "495be4bc87176ac567392e5b4116abd98466d33d7b49d41e764ccc6976b2dc42";
const DISTRIBUTIONS = Object.freeze({
  "darwin-arm64": "efb87ff28af9a188d0536ef5d42e63dd52ba8263cd7344a993cc48dd11dedb6a",
  "darwin-x64": "6231d8d3b8f5552ec6cbf6d685bdd5482e1e703214b120e89b3bf0d7bf1ef725",
  "linux-arm64": "fe4789e92b1f33358680864bbe8704289e7bb5fc207d80623c308935bd696d49",
  "linux-x64": "5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053",
});
const platform = `${process.platform}-${process.arch}`;
const distributionSha256 = DISTRIBUTIONS[platform];
if (!distributionSha256) throw new Error(`Go toolchain packaging is unsupported on '${platform}'.`);
const goPlatform = `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
const filename = `go${VERSION}.${goPlatform}.tar.gz`;
const distributionUrl = `https://go.dev/dl/${filename}`;
const outputDirectory = path.resolve("public/toolchains");
const temporary = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-forge-go-"));

try {
  const archive = new Uint8Array(await download(distributionUrl));
  requireDigest(filename, archive, distributionSha256);
  const archivePath = path.join(temporary, filename);
  await writeFile(archivePath, archive, { flag: "wx" });
  await run("tar", ["-xzf", archivePath, "-C", temporary], { maxBuffer: 4 * 1024 * 1024 });
  const goRoot = path.join(temporary, "go");
  const goBinary = path.join(goRoot, "bin", "go");
  const version = (await run(goBinary, ["version"], { env: goEnvironment(goRoot) })).stdout.trim();
  if (!version.startsWith(`go version go${VERSION} `)) {
    throw new Error(`Official Go distribution reported unexpected version '${version}'.`);
  }

  const compileWasm = path.join(temporary, "compile.wasm");
  const linkWasm = path.join(temporary, "link.wasm");
  await run(goBinary, [
    "build", "-trimpath", "-ldflags=-s -w -buildid=", "-o", compileWasm,
    path.join(goRoot, "src", "cmd", "compile"),
  ], { env: goEnvironment(goRoot), maxBuffer: 16 * 1024 * 1024 });
  await run(goBinary, [
    "build", "-trimpath", "-ldflags=-s -w -buildid=", "-o", linkWasm,
    path.join(goRoot, "src", "cmd", "link"),
  ], { env: goEnvironment(goRoot), maxBuffer: 16 * 1024 * 1024 });

  const listed = await run(goBinary, [
    "list", "-deps", "-export", "-json=ImportPath,Export", "-trimpath", "std",
  ], { env: goEnvironment(goRoot), maxBuffer: 32 * 1024 * 1024 });
  const packages = parseJsonStream(listed.stdout)
    .filter((entry) => typeof entry.ImportPath === "string" && typeof entry.Export === "string")
    .sort((left, right) => left.ImportPath.localeCompare(right.ImportPath));
  if (packages.length < 200) {
    throw new Error(`Go standard-library export set is unexpectedly small (${packages.length}).`);
  }
  const volume = path.join(temporary, "volume");
  const goVolume = path.join(volume, "go");
  const packageEntries = [];
  for (const item of packages) {
    const archivePath = `go/pkg/${item.ImportPath}.a`;
    const destination = path.join(volume, archivePath);
    await mkdir(path.dirname(destination), { recursive: true });
    const bytes = await readFile(item.Export);
    await writeFile(destination, bytes, { flag: "wx" });
    packageEntries.push({
      importPath: item.ImportPath,
      archivePath,
      sha256: digest(bytes),
    });
  }
  await mkdir(goVolume, { recursive: true });
  await writeFile(path.join(goVolume, "VERSION"), `go${VERSION}\n`, { flag: "wx" });
  const packagesPath = path.join(temporary, "packages.json");
  await writeFile(packagesPath, `${JSON.stringify(packageEntries, null, 2)}\n`, { flag: "wx" });

  const staged = path.join(temporary, "published");
  await mkdir(staged);
  await run("cargo", [
    "run", "--locked", "--release",
    "--manifest-path", path.resolve("tools/package-go-webc/Cargo.toml"),
    "--", volume, compileWasm, linkWasm, packagesPath, staged,
    SOURCE_DISTRIBUTION_URL, SOURCE_DISTRIBUTION_SHA256,
  ], { maxBuffer: 16 * 1024 * 1024 });
  await run("cargo", [
    "run", "--locked", "--release",
    "--manifest-path", path.resolve("tools/package-go-webc/Cargo.toml"),
    "--", "--verify", path.join(staged, `go-${VERSION}-wasip1.webc`),
  ], { maxBuffer: 16 * 1024 * 1024 });

  const published = [
    `go-${VERSION}-wasip1.webc.gz.bin`,
    `go-${VERSION}-wasip1.stdlib.gz.bin`,
    `go-${VERSION}-wasip1.manifest.json`,
  ];
  await mkdir(outputDirectory, { recursive: true });
  for (const name of published) {
    await publishAtomically(path.join(staged, name), path.join(outputDirectory, name));
  }
  process.stdout.write(`${JSON.stringify({
    version: VERSION,
    sourceDistributionUrl: SOURCE_DISTRIBUTION_URL,
    sourceDistributionSha256: SOURCE_DISTRIBUTION_SHA256,
    distributionUrl,
    distributionSha256,
    packageCount: packageEntries.length,
    outputs: await Promise.all(published.map(async (name) => ({
      path: path.join(outputDirectory, name),
      sha256: digest(await readFile(path.join(outputDirectory, name))),
    }))),
  })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function goEnvironment(goRoot) {
  return {
    ...process.env,
    GOROOT: goRoot,
    GOCACHE: path.join(temporary, "cache"),
    GOENV: "off",
    GOTOOLCHAIN: "local",
    GOFLAGS: "-buildvcs=false",
    GOOS: "wasip1",
    GOARCH: "wasm",
    CGO_ENABLED: "0",
    SOURCE_DATE_EPOCH: "946684800",
    TZ: "UTC",
    LC_ALL: "C",
  };
}

function parseJsonStream(source) {
  const values = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth < 0) throw new Error("Go package list contains unmatched JSON braces.");
      if (depth === 0 && start >= 0) {
        values.push(JSON.parse(source.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  if (quoted || depth !== 0 || start !== -1) throw new Error("Go package list contains incomplete JSON.");
  return values;
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to download ${url}: ${response.status}.`);
  return response.arrayBuffer();
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireDigest(label, bytes, expected) {
  const actual = digest(bytes);
  if (actual !== expected) throw new Error(`${label} digest mismatch: expected ${expected}, received ${actual}.`);
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
