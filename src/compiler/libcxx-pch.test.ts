import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CLANG_LIBCXX_PCH,
  CLANG_LIBCXX_PCH_MANIFEST_ASSET_PATH,
} from "../core/toolchains.ts";
import {
  decodeLibcxxPchManifest,
  FORGE_LIBCXX_PCH_HEADER,
  isToolchainLibcxxPchHeader,
} from "./libcxx-pch.ts";

describe("toolchain-admitted libc++ PCH", () => {
  it("binds both deterministic PCH profiles to the pinned Clang package and canonical header", async () => {
    const manifestBytes = new Uint8Array(await readFile(asset(CLANG_LIBCXX_PCH_MANIFEST_ASSET_PATH)));
    const manifest = await decodeLibcxxPchManifest(manifestBytes);
    expect(isToolchainLibcxxPchHeader(FORGE_LIBCXX_PCH_HEADER)).toBe(true);
    expect(isToolchainLibcxxPchHeader(`${FORGE_LIBCXX_PCH_HEADER}\n`)).toBe(false);

    for (const profile of ["cpp-debug", "cpp-release"] as const) {
      const declared = CLANG_LIBCXX_PCH[profile];
      const entry = manifest.profiles[profile];
      expect(`/toolchains/${entry.path}`).toBe(declared.path);
      expect(entry.sha256).toBe(declared.sha256);
      expect(entry.compressedSha256).toBe(declared.compressedSha256);
      const compressed = await readFile(asset(declared.path));
      expect(sha256(compressed)).toBe(declared.compressedSha256);
      const pch = gunzipSync(compressed);
      expect(pch.byteLength).toBe(entry.byteLength);
      expect(sha256(pch)).toBe(entry.sha256);
    }
  });
});

function asset(assetPath: string): string {
  return path.resolve("public/toolchains", path.basename(assetPath));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
