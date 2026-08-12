import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJsonBytes } from "../src/core/canonical-json.ts";
import { computeFileTreeIdentity } from "../container/tree-digest.mjs";
import { generateProductionReleaseInputs } from "./generate-production-release-inputs.mjs";
import { prepareProductionRelease } from "./prepare-production-release.mjs";

export const TEST_RELEASE_ID = "018f0f2e-7b3c-7f51-8b36-df6ec12f8d31";
export const TEST_GIT_COMMIT = "a".repeat(40);
export const TEST_REGISTRY = "registry.cloudflare.com/example/wasm-oj-judge-production";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function file(root, relative, bytes = `${relative}\n`) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}

export async function writeOciEvidenceFixture(root, reference = `${TEST_REGISTRY}:${TEST_RELEASE_ID}`) {
  await mkdir(root, { recursive: true });
  const configBytes = Buffer.from('{"architecture":"amd64","os":"linux"}\n');
  const configDigest = `sha256:${sha256(configBytes)}`;
  const manifestBytes = Buffer.from(`${JSON.stringify({
    config: {
      digest: configDigest,
      mediaType: "application/vnd.oci.image.config.v1+json",
      size: configBytes.byteLength,
    },
    layers: [],
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  })}\n`);
  const digest = `sha256:${sha256(manifestBytes)}`;
  const descriptor = (pathname, bytes, mediaType) => ({
    bytes: bytes.byteLength,
    mediaType,
    path: pathname,
    sha256: sha256(bytes),
  });
  await Promise.all([
    writeFile(path.join(root, "config.json"), configBytes),
    writeFile(path.join(root, "tag-manifest.json"), manifestBytes),
    writeFile(path.join(root, "evidence.json"), canonicalJsonBytes({
      schema: "wasm-oj-v2/oci-tag-verification",
      digest,
      platform: "linux/amd64",
      platformDigest: digest,
      reference,
      documents: {
        config: descriptor("config.json", configBytes, "application/vnd.oci.image.config.v1+json"),
        platformManifest: descriptor("tag-manifest.json", manifestBytes, "application/vnd.oci.image.manifest.v1+json"),
        tagManifest: descriptor("tag-manifest.json", manifestBytes, "application/vnd.oci.image.manifest.v1+json"),
      },
    })),
  ]);
  return { digest, evidencePath: path.join(root, "evidence.json") };
}

export async function createProductionReleaseFixture(expectedCurrentReleaseId = null) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-release-input-fixture-"));
  const sources = path.join(temporary, "sources");
  await mkdir(sources);
  const [licenses, migrations, staticAssets, toolchains, workerBundle] = await Promise.all([
    file(sources, "licenses/LICENSE", "license\n").then(() => path.join(sources, "licenses")),
    file(sources, "migrations/001.sql", "SELECT 1;\n").then(() => path.join(sources, "migrations")),
    file(sources, "static/index.html", "<!doctype html>\n").then(() => path.join(sources, "static")),
    file(sources, "toolchains/compiler.wasm", "toolchain\n").then(() => path.join(sources, "toolchains")),
    file(sources, "worker/index.js", "export default {};\n").then(() => path.join(sources, "worker")),
  ]);
  const toolchainIdentity = await computeFileTreeIdentity(toolchains);
  const dockerfile = await file(sources, "Dockerfile", [
    `FROM node:24.18.0-bookworm@sha256:${"1".repeat(64)} AS build`,
    `FROM rust:1.97.1-bookworm@sha256:${"2".repeat(64)} AS runtime-build`,
    `FROM node:24.18.0-bookworm-slim@sha256:${"3".repeat(64)} AS judge`,
    "",
  ].join("\n"));
  const identityBytes = canonicalJsonBytes({
    compilerSha256: "4".repeat(64),
    contract: 2,
    executionRootSha256: "5".repeat(64),
    gitCommit: TEST_GIT_COMMIT,
    protocol: "wasm-oj-container-v2",
    releaseId: TEST_RELEASE_ID,
    runnerSha256: "6".repeat(64),
    runtimeRootSha256: "7".repeat(64),
    schema: "wasm-oj-platform/container-identity/v2",
    toolchainRootSha256: toolchainIdentity.rootSha256,
  });
  const oci = await writeOciEvidenceFixture(path.join(sources, "oci"));
  const bundle = path.join(temporary, "release-inputs");
  const generated = await generateProductionReleaseInputs({
    outputDirectory: bundle,
    release: {
      createdAt: "2026-08-12T00:00:00.000Z",
      expectedCurrentReleaseId,
      releaseId: TEST_RELEASE_ID,
      version: "0.2.0-production.2",
    },
    source: {
      commit: TEST_GIT_COMMIT,
      repository: "https://github.com/wasm-oj/forge",
      sourceTreeSha256: "8".repeat(64),
    },
    build: {
      nodeVersion: "24.18.0",
      pnpmVersion: "10.34.5",
      rustVersion: "1.97.1",
      wasmerVersion: "7.2.1",
    },
    containerRegistry: TEST_REGISTRY,
    provenance: { issuer: "release-test", subject: "wasm-oj-production" },
    paths: {
      audit: await file(sources, "audit.json", '{"status":"pass"}\n'),
      containerIdentity: await file(sources, "container-identity.json", identityBytes),
      dockerfile,
      licenses,
      lock: await file(sources, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n"),
      migrations,
      npmPackage: await file(sources, "package.tgz", "package bytes"),
      ociEvidence: oci.evidencePath,
      runtimeCore: await file(sources, "runtime-core.wasm", "runtime core"),
      sbom: await file(sources, "sbom.json", '{"bomFormat":"CycloneDX"}\n'),
      staticAssets,
      tests: await file(sources, "tests.json", '{"status":"pass"}\n'),
      toolchains,
      wasmer: await file(sources, "wasmer.wasm", "wasmer"),
      workerBundle,
    },
  });
  const prepared = await prepareProductionRelease(generated.inputPath);
  return {
    ...generated,
    bundle,
    cleanup: () => rm(temporary, { recursive: true, force: true }),
    oci,
    prepared,
    temporary,
  };
}
