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

  it("restores digest-verified content-addressed state across compiler Worker generations", async () => {
    const first = new IncrementalBuildGraph(1_024);
    const inputs = [
      { kind: "source" as const, identity: "src/main.cpp", bytes: bytes("int main() {}") },
      { kind: "package" as const, identity: "cpp:clang", digest: "2".repeat(64) },
    ];
    await first.store("object", "main.cpp:-O2", inputs, bytes("cached-object"));
    const state = first.exportState();

    const restored = new IncrementalBuildGraph(1_024);
    await restored.restoreState(structuredClone(state));
    expect(new TextDecoder().decode(await restored.lookup(
      "main.cpp:-O2",
      new Map(inputs.map((input) => [input.identity, input])),
    ))).toBe("cached-object");

    const tampered = structuredClone(state);
    tampered.blobs[0]!.bytes[0] ^= 0xff;
    await expect(restored.restoreState(tampered)).rejects.toThrow("content-addressed blob");
    expect(new TextDecoder().decode(await restored.lookup(
      "main.cpp:-O2",
      new Map(inputs.map((input) => [input.identity, input])),
    ))).toBe("cached-object");
  });

  it("exports shared output content once and accounts for it once while restoring", async () => {
    const source = new IncrementalBuildGraph(1_024);
    const output = bytes("shared");
    await source.store("object", "first", [
      { kind: "source", identity: "first.cpp", bytes: bytes("first") },
    ], output);
    await source.store("object", "second", [
      { kind: "source", identity: "second.cpp", bytes: bytes("second") },
    ], output);

    const state = source.exportState();
    expect(state.manifest.entries).toHaveLength(2);
    expect(state.blobs).toHaveLength(1);

    const restored = new IncrementalBuildGraph(output.byteLength);
    await expect(restored.restoreState(state)).resolves.toBeUndefined();
    expect(restored.snapshot().storedBytes).toBe(output.byteLength);
  });

  it("advances its persistence generation only when graph content changes", async () => {
    const graph = new IncrementalBuildGraph(1_024);
    const inputs = [{ kind: "source" as const, identity: "main.c", bytes: bytes("int main() {}") }];
    expect(graph.exportState().manifest.generation).toBe(0);

    await graph.store("object", "main.c:-O2", inputs, bytes("object"));
    const changedGeneration = graph.exportState().manifest.generation;
    expect(changedGeneration).toBe(1);

    await graph.lookup("main.c:-O2", new Map(inputs.map((input) => [input.identity, input])));
    await graph.store("object", "main.c:-O2", inputs, bytes("object"));
    expect(graph.exportState().manifest.generation).toBe(changedGeneration);

    await graph.store("object", "main.c:-O2", inputs, bytes("new-object"));
    expect(graph.exportState().manifest.generation).toBe(changedGeneration + 1);
    expect(graph.snapshot().storedBytes).toBe(bytes("new-object").byteLength);
  });
});
