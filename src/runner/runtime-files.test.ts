import { describe, expect, it } from "vitest";
import { sha256Hex } from "../core/hash";
import { decodeRuntimeFiles, verifyAndDecodeRuntimeFiles } from "./runtime-files";

const encoder = new TextEncoder();

function archive(entries: Array<[string, string]>): Uint8Array {
  const chunks: Uint8Array[] = [encoder.encode("FORGEFS1")];
  for (const [path, value] of entries) {
    const encodedPath = encoder.encode(path);
    const data = encoder.encode(value);
    const header = new Uint8Array(12);
    const view = new DataView(header.buffer);
    view.setUint32(0, encodedPath.byteLength, true);
    view.setBigUint64(4, BigInt(data.byteLength), true);
    chunks.push(header, encodedPath, data);
  }
  chunks.push(new Uint8Array(12));
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe("runtime file archives", () => {
  it("decodes absolute runtime files", () => {
    const files = decodeRuntimeFiles(archive([
      ["/cpython/lib/python3.14/encodings/__init__.py", "codec"],
      ["/cpython/lib/python3.14/os.py", "os"],
    ]));
    expect(new TextDecoder().decode(files["/cpython/lib/python3.14/os.py"])).toBe("os");
  });

  it("rejects traversal and duplicate entries", () => {
    expect(() => decodeRuntimeFiles(archive([["/cpython/../escape", "x"]]))).toThrow("unsafe path");
    expect(() => decodeRuntimeFiles(archive([["/same", "x"], ["/same", "y"]]))).toThrow("duplicate");
  });

  it("rejects the retired pre-Forge archive signature", () => {
    const retired = archive([["/same", "x"]]);
    retired.set(new Uint8Array([0x4c, 0x57, 0x46, 0x53, 0x31]));
    expect(() => decodeRuntimeFiles(retired)).toThrow("invalid signature");
  });

  it("binds archive contents to the expected SHA-256 before decoding", async () => {
    const canonical = archive([["/cpython/lib/python314.zip", "stdlib"]]);
    const expected = await sha256Hex(canonical);
    const files = await verifyAndDecodeRuntimeFiles(canonical, expected);
    expect(new TextDecoder().decode(files["/cpython/lib/python314.zip"])).toBe("stdlib");

    const corrupted = canonical.slice();
    corrupted[corrupted.byteLength - 13] ^= 1;
    await expect(verifyAndDecodeRuntimeFiles(corrupted, expected)).rejects.toThrow(
      `expected ${expected}`,
    );
  });
});
