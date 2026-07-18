import { describe, expect, it } from "vitest";
import { encodeGoCompilerFiles } from "./go-toolchain";

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
});
