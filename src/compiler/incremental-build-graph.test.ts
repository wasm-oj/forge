import { describe, expect, it } from "vitest";
import { IncrementalBuildGraph } from "./incremental-build-graph.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("IncrementalBuildGraph", () => {
  it("reuses objects and link results only when every transitive input matches", async () => {
    const graph = new IncrementalBuildGraph(1_024);
    const inputs = [
      { kind: "source" as const, identity: "src/main.cpp", bytes: bytes("#include <answer.hpp>") },
      { kind: "header" as const, identity: "include/answer.hpp", bytes: bytes("#define ANSWER 42") },
      { kind: "package" as const, identity: "cpp:wasi-libc", digest: "1".repeat(64) },
    ];
    expect(await graph.store("object", "main.cpp:-O2", inputs, bytes("object"))).toBe(true);
    expect(new TextDecoder().decode(await graph.lookup(
      "main.cpp:-O2",
      new Map(inputs.map((input) => [input.identity, input])),
    ))).toBe("object");
    expect(await graph.lookup(
      "main.cpp:-O2",
      new Map(inputs.map((input) => [input.identity, input.identity.endsWith(".hpp")
        ? { ...input, bytes: bytes("#define ANSWER 43"), digest: undefined }
        : input])),
    )).toBeUndefined();

    expect(await graph.store("link-result", "wasm-ld:-O2", [
      { kind: "object", identity: "main.o", bytes: bytes("object") },
    ], bytes("wasm"))).toBe(true);
    expect(new TextDecoder().decode(await graph.lookupExact("link-result", "wasm-ld:-O2", [
      { kind: "object", identity: "main.o", bytes: bytes("object") },
    ]))).toBe("wasm");
    expect(graph.snapshot().nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(["source", "header", "package", "object", "link-result"]));
  });

  it("restores a digest-verified archive across compiler Worker generations", async () => {
    const first = new IncrementalBuildGraph(1_024);
    const inputs = [
      { kind: "source" as const, identity: "src/main.cpp", bytes: bytes("int main() {}") },
      { kind: "package" as const, identity: "cpp:clang", digest: "2".repeat(64) },
    ];
    await first.store("object", "main.cpp:-O2", inputs, bytes("cached-object"));
    const archive = first.exportArchive();

    const restored = new IncrementalBuildGraph(1_024);
    await restored.restoreArchive(structuredClone(archive));
    expect(new TextDecoder().decode(await restored.lookup(
      "main.cpp:-O2",
      new Map(inputs.map((input) => [input.identity, input])),
    ))).toBe("cached-object");

    const tampered = structuredClone(archive);
    tampered.entries[0]!.output[0] ^= 0xff;
    await expect(restored.restoreArchive(tampered)).rejects.toThrow("integrity verification");
    expect(new TextDecoder().decode(await restored.lookup(
      "main.cpp:-O2",
      new Map(inputs.map((input) => [input.identity, input])),
    ))).toBe("cached-object");
  });

  it("accounts for content-addressed output blobs once while restoring", async () => {
    const source = new IncrementalBuildGraph(1_024);
    const output = bytes("shared");
    await source.store("object", "first", [
      { kind: "source", identity: "first.cpp", bytes: bytes("first") },
    ], output);
    await source.store("object", "second", [
      { kind: "source", identity: "second.cpp", bytes: bytes("second") },
    ], output);

    const restored = new IncrementalBuildGraph(output.byteLength);
    await expect(restored.restoreArchive(source.exportArchive())).resolves.toBeUndefined();
    expect(restored.snapshot().storedBytes).toBe(output.byteLength);
  });
});
