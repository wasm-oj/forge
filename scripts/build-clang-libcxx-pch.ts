import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { FORGE_SCHEMAS } from "../src/core/contract.ts";
import { FORGE_LIBCXX_PCH_HEADER } from "../src/compiler/libcxx-pch.ts";

const VERSION = "22.0.0-git20542-10";
const DIRECTORY = path.resolve(process.env.FORGE_CLANG_TOOLCHAIN_DIRECTORY ?? "public/toolchains");
const COMPILER = path.resolve("crates/runtime-core/target/release/forge-compiler");
const packageCompressed = await readFile(path.join(DIRECTORY, `clang-${VERSION}.webc.gz.bin`));
const packageBytes = gunzipSync(packageCompressed);
const pinsBytes = await readFile(path.join(DIRECTORY, `clang-${VERSION}.cc1-pins.json`));
const pins = JSON.parse(pinsBytes.toString("utf8")) as {
  placeholders: { input: string; output: string; mainFileName: string };
  configs: Record<string, { cc1: string[] }>;
};
const temporary = await mkdtemp(path.join(os.tmpdir(), "forge-libcxx-pch-"));

try {
  const packagePath = path.join(temporary, `clang-${VERSION}.webc`);
  await writeFile(packagePath, packageBytes, { flag: "wx" });
  const profiles = ["cpp-debug", "cpp-release"] as const;
  const headerPath = "/project/forge.libcxx.hpp";
  const responses = runBatch({
    schema: FORGE_SCHEMAS.compileBatch,
    packagePath,
    memoryLimitBytes: 4_294_967_296,
    requests: profiles.map((profile) => {
      const outputPath = `/project/${profile}.pch`;
      return {
        command: "clang",
        args: instantiatePch(pins.configs[profile]?.cc1, pins.placeholders, headerPath, outputPath),
        env: { PATH: "/bin", SOURCE_DATE_EPOCH: "946684800", TZ: "UTC", LC_ALL: "C" },
        stdinBase64: "",
        filesBase64: { [headerPath]: Buffer.from(FORGE_LIBCXX_PCH_HEADER).toString("base64") },
        cwd: "/project",
        outputPaths: [outputPath],
        outputLimitBytes: 16 * 1024 * 1024,
      };
    }),
  });
  const assets: Record<string, unknown> = {};
  await mkdir(DIRECTORY, { recursive: true });
  for (const [index, profile] of profiles.entries()) {
    const response = responses[index];
    const stderr = Buffer.from(response?.result?.stderrBase64 ?? "", "base64").toString("utf8");
    if (!response?.ok || response.result?.code !== 0) {
      throw new Error(`Pinned Clang failed to build '${profile}' libc++ PCH: ${response?.error?.message ?? stderr}`);
    }
    const outputPath = `/project/${profile}.pch`;
    const encoded = response.result.outputFilesBase64?.[outputPath];
    if (!encoded) throw new Error(`Pinned Clang omitted '${outputPath}'.`);
    const pch = Buffer.from(encoded, "base64");
    if (pch.byteLength < 1_024) throw new Error(`Pinned Clang emitted an implausibly small '${profile}' PCH.`);
    const compressed = gzipSync(pch, { level: 9 });
    const filename = `clang-${VERSION}.${profile}.pch.gz.bin`;
    await publishAtomically(compressed, path.join(DIRECTORY, filename));
    assets[profile] = {
      path: filename,
      byteLength: pch.byteLength,
      sha256: sha256(pch),
      compressedByteLength: compressed.byteLength,
      compressedSha256: sha256(compressed),
    };
  }
  const manifest = {
    schema: FORGE_SCHEMAS.clangLibcxxPch,
    version: VERSION,
    clangPackageSha256: sha256(packageBytes),
    clangPinsSha256: sha256(pinsBytes),
    header: FORGE_LIBCXX_PCH_HEADER,
    headerSha256: sha256(FORGE_LIBCXX_PCH_HEADER),
    profiles: assets,
  };
  const encodedManifest = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = path.join(DIRECTORY, `clang-${VERSION}.libcxx-pch.json`);
  await publishAtomically(encodedManifest, manifestPath);
  process.stdout.write(`${JSON.stringify({
    manifest: path.basename(manifestPath),
    manifestSha256: sha256(encodedManifest),
    profiles: assets,
  }, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function instantiatePch(
  template: string[] | undefined,
  placeholders: { input: string; output: string; mainFileName: string },
  inputPath: string,
  outputPath: string,
): string[] {
  if (!template) throw new Error("Pinned Clang manifest is missing a C++ PCH profile.");
  return template.map((token) => {
    if (token === "-emit-obj") return "-emit-pch";
    if (token === "c++") return "c++-header";
    if (token === placeholders.input) return inputPath;
    if (token === placeholders.output) return outputPath;
    if (token === placeholders.mainFileName) return "forge.libcxx.hpp";
    return token;
  });
}

function runBatch(request: unknown): Array<{
  ok: boolean;
  result?: { code: number; stderrBase64: string; outputFilesBase64: Record<string, string> };
  error?: { message: string };
}> {
  const result = spawnSync(COMPILER, [], {
    input: JSON.stringify(request),
    maxBuffer: 512 * 1024 * 1024,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (!result.stdout) throw new Error(`forge-compiler emitted no response: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { responses?: unknown };
  if (!Array.isArray(parsed.responses)) throw new Error("forge-compiler emitted a malformed response.");
  return parsed.responses as ReturnType<typeof runBatch>;
}

async function publishAtomically(bytes: Uint8Array, destination: string): Promise<void> {
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, bytes, { mode: 0o644, flag: "wx" });
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
