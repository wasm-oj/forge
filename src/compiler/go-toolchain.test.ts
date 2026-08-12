import { describe, expect, it } from "vitest";
import {
  decodeGoStandardLibrary,
  encodeGoCompilerFiles,
  validateGoStandardLibrary,
} from "./go-toolchain";

describe("Go compiler filesystem contract", () => {
  it("normalizes every text file to UTF-8 bytes without copying binary archives", () => {
    const archive = new Uint8Array([0, 97, 115, 109]);
    const files = encodeGoCompilerFiles({
      "/go/VERSION": "go1.26.5\n",
      "/go/pkg/fmt.a": archive,
    });

    expect(files["/go/VERSION"]).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(files["/go/VERSION"])).toBe("go1.26.5\n");
    expect(files["/go/pkg/fmt.a"]).toBe(archive);
    expect(Object.values(files).every((value) => value instanceof Uint8Array)).toBe(true);
  });

  it("keeps standard-library package files as views over one verified archive", () => {
    const packages = [{
      importPath: "fmt",
      archivePath: "/go/pkg/fmt.a",
      sha256: "a".repeat(64),
    }];
    const payload = new TextEncoder().encode("!<arch>\n!");
    const index = new TextEncoder().encode(JSON.stringify([{
      ...packages[0],
      offset: 0,
      length: payload.byteLength,
    }]));
    const archive = new Uint8Array(12 + index.byteLength + payload.byteLength);
    archive.set(new TextEncoder().encode("WOJGO002"));
    new DataView(archive.buffer).setUint32(8, index.byteLength, true);
    archive.set(index, 12);
    archive.set(payload, 12 + index.byteLength);

    expect(() => validateGoStandardLibrary(archive, packages)).not.toThrow();
    const files = decodeGoStandardLibrary(archive, packages);
    expect(files["/go/pkg/fmt.a"].buffer).toBe(archive.buffer);
    expect(files["/go/pkg/fmt.a"]).toEqual(payload);
  });
});
