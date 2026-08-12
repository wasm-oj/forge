import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveOciTag,
  verifyOciTagVerificationFile,
} from "./oci-release-image.mjs";
import { parseRegistryCredentials } from "./verify-oci-release-image.mjs";

const registry = "registry.cloudflare.com/example/release";
const tag = "018f0f2e-7b3c-7f51-8b36-df6ec12f8d31";
const reference = `${registry}:${tag}`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function response(bytes, mediaType) {
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": mediaType,
      "docker-content-digest": `sha256:${sha256(bytes)}`,
    },
  });
}

function imageDocuments() {
  const config = Buffer.from('{"architecture":"amd64","os":"linux"}\n');
  const manifest = Buffer.from(`${JSON.stringify({
    config: {
      digest: `sha256:${sha256(config)}`,
      mediaType: "application/vnd.oci.image.config.v1+json",
      size: config.byteLength,
    },
    layers: [],
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  })}\n`);
  return { config, manifest };
}

test("resolves a tag, hashes exact OCI bytes, and re-verifies saved evidence", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-oci-test-"));
  const output = path.join(parent, "evidence");
  const { config, manifest } = imageDocuments();
  const expectedDigest = `sha256:${sha256(manifest)}`;
  const fetchImpl = async (url, options) => {
    assert.match(options.headers.Authorization, /^Basic /u);
    if (url.includes("/blobs/")) return response(config, "application/vnd.oci.image.config.v1+json");
    return response(manifest, "application/vnd.oci.image.manifest.v1+json");
  };
  try {
    const evidence = await resolveOciTag({
      reference,
      expectedDigest,
      credentials: { username: "v1", password: "secret" },
      outputDirectory: output,
      fetchImpl,
    });
    assert.equal(evidence.digest, expectedDigest);
    assert.equal(evidence.platformDigest, expectedDigest);
    assert.equal(
      (await verifyOciTagVerificationFile(path.join(output, "evidence.json"), { reference, digest: expectedDigest })).digest,
      expectedDigest,
    );
    await writeFile(path.join(output, "config.json"), "tampered\n");
    await assert.rejects(
      verifyOciTagVerificationFile(path.join(output, "evidence.json")),
      /config.*do not match/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("selects exactly one linux/amd64 child from an OCI index", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-oci-index-test-"));
  const output = path.join(parent, "evidence");
  const { config, manifest } = imageDocuments();
  const manifestDigest = `sha256:${sha256(manifest)}`;
  const index = Buffer.from(`${JSON.stringify({
    manifests: [{
      digest: manifestDigest,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      platform: { architecture: "amd64", os: "linux" },
      size: manifest.byteLength,
    }],
    mediaType: "application/vnd.oci.image.index.v1+json",
    schemaVersion: 2,
  })}\n`);
  const expectedDigest = `sha256:${sha256(index)}`;
  const fetchImpl = async (url) => {
    if (url.includes("/blobs/")) return response(config, "application/vnd.oci.image.config.v1+json");
    if (url.includes(encodeURIComponent(manifestDigest))) return response(manifest, "application/vnd.oci.image.manifest.v1+json");
    return response(index, "application/vnd.oci.image.index.v1+json");
  };
  try {
    const evidence = await resolveOciTag({
      reference,
      expectedDigest,
      credentials: { username: "v1", password: "secret" },
      outputDirectory: output,
      fetchImpl,
    });
    assert.equal(evidence.digest, expectedDigest);
    assert.equal(evidence.platformDigest, manifestDigest);
    assert.deepEqual(await readFile(path.join(output, "platform-manifest.json")), manifest);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects a stale expected digest and malformed Wrangler credentials", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-oci-mismatch-test-"));
  const { manifest } = imageDocuments();
  try {
    await assert.rejects(resolveOciTag({
      reference,
      expectedDigest: `sha256:${"0".repeat(64)}`,
      credentials: { username: "v1", password: "secret" },
      outputDirectory: path.join(parent, "evidence"),
      fetchImpl: async () => response(manifest, "application/vnd.oci.image.manifest.v1+json"),
    }), /resolved to .* expected/u);
    assert.deepEqual(parseRegistryCredentials('{"password":"p","username":"v1"}\n'), { password: "p", username: "v1" });
    assert.throws(() => parseRegistryCredentials('{"password":"p"}'), /incomplete/u);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
