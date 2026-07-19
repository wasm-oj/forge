import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  parseRegistryMetadata,
  verifyRegistryArtifactFile,
  verifyReleaseArtifacts,
} from "./release-artifacts.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "forge-release-artifacts-test-"));
try {
  const payload = Buffer.from("deterministic Forge package tar payload\n", "utf8");
  const candidateBytes = gzipSync(payload, { level: 9 });
  const canonicalBytes = Buffer.from(candidateBytes);
  canonicalBytes[9] = canonicalBytes[9] === 3 ? 0 : 3;
  assert.notDeepEqual(candidateBytes, canonicalBytes, "fixture must vary gzip metadata");
  const candidate = path.join(directory, "candidate.tgz");
  const canonical = path.join(directory, "canonical.tgz");
  await writeFile(candidate, candidateBytes);
  await writeFile(canonical, canonicalBytes);

  const sha512 = createHash("sha512").update(canonicalBytes).digest("base64");
  const shasum = createHash("sha1").update(canonicalBytes).digest("hex");
  const metadata = parseRegistryMetadata(JSON.stringify({
    integrity: `sha512-${sha512}`,
    shasum,
    tarball: "https://registry.npmjs.org/@wasm-oj/forge/-/forge-0.1.0.tgz",
  }));
  await verifyRegistryArtifactFile(canonical, metadata);
  const verified = await verifyReleaseArtifacts({ candidate, canonical });
  assert.equal(verified.payloadSha256, createHash("sha256").update(payload).digest("hex"));
  assert.match(await readFile(`${canonical}.sha256`, "utf8"), /^[0-9a-f]{64}  canonical\.tgz\n$/);

  const different = path.join(directory, "different.tgz");
  await writeFile(different, gzipSync(Buffer.from("different payload\n")));
  await assert.rejects(
    verifyReleaseArtifacts({ candidate, canonical: different }),
    /payload differs/,
  );
  await assert.rejects(
    verifyRegistryArtifactFile(canonical, { ...metadata, shasum: "0".repeat(40) }),
    /SHA-1 mismatch/,
  );
  assert.throws(
    () => parseRegistryMetadata(JSON.stringify({
      integrity: `sha512-${sha512}`,
      shasum,
      tarball: "https://example.com/forge.tgz",
    })),
    /Registry tarball URL/,
  );
} finally {
  await rm(directory, { force: true, recursive: true });
}

process.stdout.write("Verified registry integrity and gzip-metadata-independent release equivalence.\n");
