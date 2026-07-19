import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const admittedRegistryOrigin = "https://registry.npmjs.org";

export function parseRegistryMetadata(source) {
  let metadata;
  try {
    metadata = JSON.parse(source);
  } catch (error) {
    throw new Error("Registry metadata must be valid JSON.", { cause: error });
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Registry metadata must be one object.");
  }
  const tarball = new URL(requiredString(metadata.tarball, "dist.tarball"));
  if (
    tarball.origin !== admittedRegistryOrigin
    || tarball.username
    || tarball.password
    || tarball.search
    || tarball.hash
  ) {
    throw new Error(`Registry tarball URL must be an uncredentialed ${admittedRegistryOrigin} URL.`);
  }
  const integrity = requiredString(metadata.integrity, "dist.integrity");
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) throw new Error("Registry integrity must contain exactly one sha512 SRI digest.");
  const sha512 = Buffer.from(match[1], "base64");
  if (sha512.length !== 64 || `sha512-${sha512.toString("base64")}` !== integrity) {
    throw new Error("Registry sha512 integrity is not canonical base64.");
  }
  const shasum = requiredString(metadata.shasum, "dist.shasum").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(shasum)) throw new Error("Registry shasum must be one SHA-1 hex digest.");
  return Object.freeze({ integrity, sha512, shasum, tarball });
}

export async function downloadRegistryArtifact({ destination, metadata }) {
  const partial = `${destination}.partial`;
  await rm(partial, { force: true });
  try {
    const response = await fetch(metadata.tarball, {
      headers: { accept: "application/octet-stream" },
      redirect: "error",
    });
    if (!response.ok || !response.body) {
      throw new Error(`Registry tarball request failed with HTTP ${response.status}.`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: "wx" }));
    await verifyRegistryArtifactFile(partial, metadata);
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

export async function verifyRegistryArtifactFile(file, metadata) {
  const hashes = await hashFile(file, ["sha1", "sha512"]);
  if (hashes.sha1.hex !== metadata.shasum) {
    throw new Error(`Registry tarball SHA-1 mismatch: expected ${metadata.shasum}, received ${hashes.sha1.hex}.`);
  }
  const expected = metadata.sha512;
  const actual = hashes.sha512.bytes;
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Registry tarball SHA-512 integrity mismatch.");
  }
  return hashes;
}

export async function verifyReleaseArtifacts({ candidate, canonical }) {
  const [candidatePayload, canonicalPayload, canonicalCompressed] = await Promise.all([
    hashGzipPayload(candidate),
    hashGzipPayload(canonical),
    hashFile(canonical, ["sha256"]),
  ]);
  if (
    candidatePayload.size !== canonicalPayload.size
    || candidatePayload.sha256 !== canonicalPayload.sha256
  ) {
    throw new Error(
      `Registry package payload differs from the verified candidate: `
      + `${candidatePayload.sha256}/${candidatePayload.size} != `
      + `${canonicalPayload.sha256}/${canonicalPayload.size}.`,
    );
  }
  const digest = canonicalCompressed.sha256.hex;
  const name = canonical.split(/[\\/]/).at(-1);
  await writeFile(`${canonical}.sha256`, `${digest}  ${name}\n`, { flag: "wx" });
  return Object.freeze({
    canonicalSha256: digest,
    compressedBytes: canonicalCompressed.sha256.size,
    payloadBytes: canonicalPayload.size,
    payloadSha256: canonicalPayload.sha256,
  });
}

async function hashGzipPayload(file) {
  const hash = createHash("sha256");
  let size = 0;
  const gunzip = createReadStream(file).pipe(createGunzip());
  for await (const chunk of gunzip) {
    hash.update(chunk);
    size += chunk.length;
  }
  if (size === 0) throw new Error(`${file} contains an empty gzip payload.`);
  return Object.freeze({ sha256: hash.digest("hex"), size });
}

async function hashFile(file, algorithms) {
  const hashes = Object.fromEntries(algorithms.map((algorithm) => [algorithm, createHash(algorithm)]));
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    for (const hash of Object.values(hashes)) hash.update(chunk);
    size += chunk.length;
  }
  return Object.freeze(Object.fromEntries(Object.entries(hashes).map(([algorithm, hash]) => {
    const bytes = hash.digest();
    return [algorithm, Object.freeze({ bytes, hex: bytes.toString("hex"), size })];
  })));
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string.`);
  return value;
}
