# Forge host integration contract

This document locks the host-facing abstractions required before the first
public Forge release. It is intentionally derived from execution invariants
rather than from the current browser or server implementation.

## First principles

1. A submission is the smallest independently observable and cancellable unit.
   Cancellation may affect only that submission; queued submissions must remain
   untouched.
2. Observation is structured data. Human-readable messages are presentation,
   not an API contract.
3. Host extensions execute with host authority. Browser runtime plug-ins must
   therefore be explicit, same-origin, content-pinned modules loaded inside the
   runner Worker; they are not guest sandbox extensions.
4. Server startup verifies and composes a provisioned Forge distribution. It
   never downloads a toolchain, compiles a binary, or chooses an unverified
   fallback at runtime.
5. A dependency changes compilation. Its canonical lock and verified mounted
   file tree must participate in project validation, build identity, compiler
   input, artifact provenance, offline replay, and conformance.
6. Browser and server hosts expose the same operation, error, observation,
   artifact, judge, and dependency semantics. Host-only timing and transport
   details remain observational.

## Public abstractions

- `ForgeOperation<T>` owns one operation ID, state machine, abort signal,
  result promise, and scoped observation stream.
- `ForgeError` is the stable infrastructure-error envelope. Compile
  diagnostics, runtime terminations, and judge verdicts remain normal result
  data rather than exceptions.
- `BrowserRuntimeDriverPlugin` identifies one same-origin, SHA-256-pinned,
  self-contained ESM module that constructs exactly one `RuntimeDriver` inside
  the runner Worker.
- `createServerForge()` resolves package-relative toolchains and provisioned
  native binaries, verifies the complete distribution, constructs storage,
  compiler, runner, and engine, and returns a ready `ForgeEngine`.
- `DependencyBuildBundle` is the compiler-facing, archive-independent
  representation of a canonical dependency lock and verified package file
  trees.

## Explicit non-goals

- The submission API is not an HTTP service, authentication system, hidden-test
  store, or distributed queue.
- Browser plug-ins do not load arbitrary registry code or unpinned transitive
  modules.
- Server startup does not provision missing native binaries.
- Dependency integration does not pretend unsupported build scripts, native
  extensions, proc macros, or target-specific packages are portable. Such
  packages fail with a structured unsupported-dependency error.
