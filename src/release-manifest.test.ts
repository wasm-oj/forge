import { describe, expect, it } from "vitest";
import { FORGE_CONTRACT_VERSION } from "./core/contract";
import { FORGE_RUNTIME_IDENTITY_SHA256 } from "./core/runtime-identity";
import {
  forgeReleaseManifestBytes,
  forgeReleaseManifestSha256,
  FORGE_CONTAINER_PROTOCOL_VERSION,
  FORGE_RELEASE_MANIFEST_SCHEMA,
  parseForgeReleaseManifest,
  verifyForgeReleaseManifestBytes,
  type ForgeReleaseManifest,
} from "./release-manifest";

const digest = (character: string) => character.repeat(64);

function fixture(): ForgeReleaseManifest {
  return {
    schema: FORGE_RELEASE_MANIFEST_SCHEMA,
    releaseId: "018f0f2e-7b3c-7f51-8b36-df6ec12f8d31",
    version: "1.2.3-rc.1",
    forgeContract: FORGE_CONTRACT_VERSION,
    createdAt: "2026-08-09T00:00:00.000Z",
    source: {
      repository: "https://github.com/wasm-oj/forge",
      commit: "a".repeat(40),
      sourceTreeSha256: digest("1"),
      tag: "v1.2.3-rc.1",
    },
    build: {
      nodeVersion: "24.18.0",
      pnpmVersion: "10.34.5",
      rustVersion: "1.97.1",
      lockSha256: digest("2"),
      sbomSha256: digest("3"),
      licensesSha256: digest("4"),
      auditSha256: digest("5"),
    },
    artifacts: {
      npmPackage: { bytes: 1, sha256: digest("6") },
      workerBundle: { bytes: 2, sha256: digest("7") },
      staticAssets: { bytes: 3, sha256: digest("8") },
      containerImage: {
        registry: "registry.cloudflare.com/wasm-oj/forge",
        digest: `sha256:${digest("9")}`,
        identitySha256: digest("9"),
        platform: "linux/amd64",
        dockerfileSha256: digest("a"),
        baseImages: [
          { stage: "node-build", image: "node:24.18.0-bookworm", digest: `sha256:${digest("a")}` },
          { stage: "rust-build", image: "rust:1.97.1-bookworm", digest: `sha256:${digest("b")}` },
          { stage: "judge", image: "node:24.18.0-bookworm-slim", digest: `sha256:${digest("c")}` },
        ],
      },
    },
    runtime: {
      protocolVersion: FORGE_CONTAINER_PROTOCOL_VERSION,
      executionRootSha256: digest("9"),
      rootSha256: digest("a"),
      runtimeIdentitySha256: FORGE_RUNTIME_IDENTITY_SHA256,
      runtimeCoreSha256: digest("b"),
      wasmerVersion: "7.2.1",
      wasmerSha256: digest("c"),
      compilerSha256: digest("d"),
      runnerSha256: digest("e"),
    },
    toolchains: { rootSha256: digest("f"), manifestSha256: digest("0") },
    cost: { model: "weighted", profileRootSha256: digest("1"), baselineSha256: digest("2") },
    evidence: { conformanceSha256: digest("3"), testsSha256: digest("4"), costCalibrationSha256: digest("5") },
    migrations: { coreSha256: digest("6"), submissionsSha256: digest("7") },
    provenance: { issuer: "https://token.actions.githubusercontent.com", subject: "repo:wasm-oj/forge" },
  };
}

describe("Forge release manifest", () => {
  it("produces one stable canonical byte sequence", async () => {
    const value = fixture();
    const reversed = Object.fromEntries(Object.entries(value).reverse());
    expect(forgeReleaseManifestBytes(parseForgeReleaseManifest(reversed))).toEqual(forgeReleaseManifestBytes(value));
    const bytes = forgeReleaseManifestBytes(value);
    expect(await verifyForgeReleaseManifestBytes(bytes, await forgeReleaseManifestSha256(value))).toEqual(value);
    await expect(verifyForgeReleaseManifestBytes(new TextEncoder().encode("not-json"), digest("0"))).rejects.toThrow("expected digest");
  });

  it("rejects non-canonical bytes and unknown fields", async () => {
    const value = fixture();
    await expect(verifyForgeReleaseManifestBytes(new TextEncoder().encode(JSON.stringify(value)))).rejects.toThrow("canonical JSON");
    expect(() => parseForgeReleaseManifest({ ...value, fallbackRelease: "old" })).toThrow("invalid shape");
  });

  it("binds release and cost evidence to the exact runtime", () => {
    expect(() => parseForgeReleaseManifest({
      ...fixture(),
      runtime: { ...fixture().runtime, runtimeIdentitySha256: digest("f") },
    })).toThrow("runtime identity");
  });
});
