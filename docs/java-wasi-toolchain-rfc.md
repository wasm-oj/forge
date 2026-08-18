# Java toolchain RFC

## Status

Java is not a built-in WASM-OJ language yet. This is intentional: adding
`java` to the language list without a compatible compiler and runtime would
make browser preview and Official Submit disagree.

## Contract that Java must satisfy

A Java toolchain can be added only when it produces the same contract-2
artifact shape as the existing languages:

- one deterministic WASI Preview 1 WebAssembly module;
- stdin, stdout, stderr, exit codes, filesystem mounts, and command-line
  arguments provided through the existing runner;
- deterministic time and randomness under the existing resource policy;
- identical artifact and termination semantics in browser and server hosts;
- compiler diagnostics for source errors and runtime diagnostics for guest
  failures; and
- pinned, redistributable compiler/runtime assets with license and digest
  provenance.

The implementation must not invoke a host JVM or host `javac` for contestant
source. That would bypass the compiler isolation, artifact identity, and
browser/server parity guarantees of the WASM-OJ contract.

## Current candidates

| Candidate | Current output | Contract result |
| --- | --- | --- |
| TeaVM | WebAssembly GC plus a JavaScript runtime | Not a standalone WASI module |
| GraalVM Web Image | JavaScript launcher plus `.js.wasm` | Depends on a JavaScript host and is experimental |
| Bytecoder | Browser-oriented WebAssembly module plus JavaScript imports | No WASI stdin/stdout runtime |
| OpenJDK/JVM bundle | JVM process or embedded JVM | Requires a host runtime and is not a WASI artifact |

These candidates may become useful for a browser-only extension, but none is a
valid built-in judge toolchain under the current contract.

## Proposed landing sequence

1. Select a compiler/runtime pair that emits a standalone WASI module and
   freeze its exact source revision, license set, and asset digests.
2. Add an independently versioned `@wasm-oj/toolchain-java` package and a
   compiler stage that emits contract-2 artifacts.
3. Add Java conformance cases covering compilation diagnostics, line- and
   token-oriented input, output, non-zero exit, timeout, memory, filesystem,
   deterministic time, and deterministic randomness.
4. Run the same cases through browser and server hosts before adding `java`
   to the built-in language set.

Until step 1 is possible, Java should remain a downstream extension or use a
separate non-WASM-OJ judge path. It must not be represented as a WASM-OJ built-in
language with a fallback JVM command.
