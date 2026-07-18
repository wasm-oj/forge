import { gzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../core/hash";
import { createDependencyLock } from "./lock";
import type { LockedDependencyPackage } from "./types";
import {
  createDependencyBuildBundle,
  verifyDependencyBuildBundle,
} from "./build";

const encoder = new TextEncoder();

describe("dependency build adapters", () => {
  it("materializes and binds a verified npm tarball to its canonical file tree", async () => {
    const payload = gzipSync(tar({
      "package/package.json": JSON.stringify({ name: "answer", version: "1.0.0", main: "index.js" }),
      "package/index.js": "module.exports = 42;\n",
    }));
    const record = await packageRecord("npm", "answer", "1.0.0", payload);
    const lock = createDependencyLock("0".repeat(64), [record.id], [record]);
    const bundle = await createDependencyBuildBundle(lock, new Map([[record.id, payload]]));

    expect(new TextDecoder().decode(bundle.packages[0]?.files["index.js"])).toBe("module.exports = 42;\n");
    expect(bundle.lockSha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyDependencyBuildBundle(bundle)).resolves.toBeUndefined();

    bundle.packages[0]!.files["index.js"]![0] = 0;
    await expect(verifyDependencyBuildBundle(bundle)).rejects.toThrow("file-tree digest mismatch");
  });

  it("rejects npm install scripts and accepts canonical Go module ZIP roots", async () => {
    const npmPayload = gzipSync(tar({
      "package/package.json": JSON.stringify({
        name: "native",
        version: "1.0.0",
        scripts: { install: "node-gyp rebuild" },
      }),
      "package/index.js": "module.exports = 1;",
    }));
    const npm = await packageRecord("npm", "native", "1.0.0", npmPayload);
    const npmLock = createDependencyLock("1".repeat(64), [npm.id], [npm]);
    await expect(createDependencyBuildBundle(npmLock, new Map([[npm.id, npmPayload]])))
      .rejects.toThrow("install' lifecycle scripts");

    const goPayload = zipSync({
      "example.com/answer@v1.0.0/go.mod": encoder.encode("module example.com/answer\n"),
      "example.com/answer@v1.0.0/answer.go": encoder.encode("package answer\nconst Value = 42\n"),
    });
    const go = await packageRecord("go", "example.com/answer", "v1.0.0", goPayload);
    const goLock = createDependencyLock("2".repeat(64), [go.id], [go]);
    const bundle = await createDependencyBuildBundle(goLock, new Map([[go.id, goPayload]]));
    expect(Object.keys(bundle.packages[0]!.files)).toEqual(["answer.go", "go.mod"]);
  });
});

async function packageRecord(
  ecosystem: LockedDependencyPackage["ecosystem"],
  name: string,
  version: string,
  payload: Uint8Array,
): Promise<LockedDependencyPackage> {
  return {
    id: `${ecosystem}:${name}@${version}`,
    ecosystem,
    name,
    version,
    source: ecosystem === "go"
      ? `https://proxy.golang.org/${name}/@v/${version}.zip`
      : `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integritySha256: await sha256Hex(payload),
    dependencies: [],
  };
}

function tar(files: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [path, contents] of Object.entries(files)) {
    const bytes = encoder.encode(contents);
    const header = new Uint8Array(512);
    writeAscii(header, 0, 100, path);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, bytes.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeAscii(header, 257, 6, "ustar");
    writeAscii(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeOctal(header, 148, 8, checksum);
    blocks.push(header, bytes, new Uint8Array((512 - bytes.byteLength % 512) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const result = new Uint8Array(blocks.reduce((sum, block) => sum + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.byteLength;
  }
  return result;
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) throw new Error("Test tar field is too long.");
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  writeAscii(target, offset, length, `${text}\0`);
}
