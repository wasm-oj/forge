import { describe, expect, it } from "vitest";
import { artifactPayloadSha256, canonicalArtifactPayloadBytes } from "./artifact-payload.ts";
import { sha256Hex } from "./hash.ts";
import type { BuildArtifact, RuntimeBundleArtifact, WasmArtifact } from "./types.ts";

function runtimeBundle(files: RuntimeBundleArtifact["files"]): RuntimeBundleArtifact {
  return { kind: "runtime-bundle", files } as RuntimeBundleArtifact;
}

describe("canonical artifact payload", () => {
  it("hashes standalone Wasm as its direct bytes", async () => {
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const artifact = { kind: "wasm", bytes } as WasmArtifact;

    expect(canonicalArtifactPayloadBytes(artifact)).toBe(bytes);
    await expect(artifactPayloadSha256(artifact)).resolves.toBe(await sha256Hex(bytes));
  });

  it("sorts runtime files before framing them", async () => {
    const left = runtimeBundle({
      "src/z.js": "last",
      "src/a.js": new Uint8Array([1, 2, 3]),
    });
    const right = runtimeBundle({
      "src/a.js": new Uint8Array([1, 2, 3]),
      "src/z.js": "last",
    });

    expect(canonicalArtifactPayloadBytes(left)).toEqual(canonicalArtifactPayloadBytes(right));
    await expect(artifactPayloadSha256(left)).resolves.toBe(await artifactPayloadSha256(right));
  });

  it("frames path and content lengths without concatenation ambiguity", async () => {
    const splitAfterPath = runtimeBundle({ a: "bc" });
    const splitBeforePath = runtimeBundle({ ab: "c" });

    expect(canonicalArtifactPayloadBytes(splitAfterPath)).not.toEqual(canonicalArtifactPayloadBytes(splitBeforePath));
    await expect(artifactPayloadSha256(splitAfterPath)).resolves.not.toBe(
      await artifactPayloadSha256(splitBeforePath),
    );
  });

  it("frames text and binary contents as distinct types", async () => {
    const text = runtimeBundle({ entry: "x" });
    const binary = runtimeBundle({ entry: new Uint8Array([120]) });

    expect(canonicalArtifactPayloadBytes(text)).not.toEqual(canonicalArtifactPayloadBytes(binary));
    await expect(artifactPayloadSha256(text)).resolves.not.toBe(await artifactPayloadSha256(binary));
  });

  it("rejects unsupported payload kinds instead of inventing an implicit encoding", () => {
    const unsupported = { kind: "archive", bytes: new Uint8Array() } as unknown as BuildArtifact;
    expect(() => canonicalArtifactPayloadBytes(unsupported)).toThrow("Unsupported artifact payload kind 'archive'");
  });
});
