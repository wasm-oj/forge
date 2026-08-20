# Java toolchain RFC

## Status

WASM-OJ now ships Java as an explicit downstream toolchain profile. It is not in
the default `LANGUAGES` list yet: promotion requires a published TeaVM source
revision and a browser conformance host that is part of the WASM-OJ application.
The implemented server path is contract-2 compatible and uses no host JVM.

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

## Current implementation

The Java profile uses a patched TeaVM 0.13.1 WASI compiler plus separate
compile-time and runtime OpenJDK class-library assets. The compiler is packaged
as a digest-pinned WebC command and invoked by the existing browser/server
WASI stages. Java source diagnostics, package-qualified `main` classes,
stdin/stdout, deterministic runner policy, and Java exception handling are
covered by the server conformance cases.

The profile deliberately supports only `wasip1`; WASIX is rejected. Java
`try/catch` is lowered by TeaVM software runtime handling, so the WASM-OJ runner
does not need a new exception mechanism.

## Rejected candidates

| Candidate | Current output | Contract result |
| --- | --- | --- |
| TeaVM upstream release | WebAssembly GC plus a JavaScript runtime | The upstream artifact is not the pinned standalone WASI compiler used here |
| GraalVM Web Image | JavaScript launcher plus `.js.wasm` | Depends on a JavaScript host and is experimental |
| Bytecoder | Browser-oriented WebAssembly module plus JavaScript imports | No WASI stdin/stdout runtime |
| OpenJDK/JVM bundle | JVM process or embedded JVM | Requires a host runtime and is not a WASI artifact |

These candidates may become useful for a browser-only extension, but they do
not replace the pinned WASI profile.

## Proposed landing sequence

1. Publish the patched TeaVM compiler source and freeze its public revision,
   license set, and asset digests.
2. Keep the independently versioned `@wasm-oj/toolchain-java` package and
   compiler stages explicit until the browser host exposes the same conformance
   harness.
3. Expand Java conformance to resource, filesystem, clock, and randomness
   cases.
4. Add `java` to the built-in language set only after both hosts run that
   matrix from the published package.

Until step 1 is complete, Java remains an opt-in downstream extension. It must
not use a fallback JVM command or be represented as a default WASM-OJ language.
