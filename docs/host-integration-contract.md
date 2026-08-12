# WASM-OJ host integration contract

This document records the host-facing abstractions for contract 2.

## First principles

1. A submission is the smallest independently observable and cancellable unit. Cancellation may
   affect only that submission; queued submissions remain untouched.
2. Observation is structured data. Human-readable messages are presentation, not an API contract.
3. Host extensions execute with host authority. Browser runtime plug-ins are therefore explicit,
   same-origin, content-pinned modules loaded inside the runner Worker; they are not guest sandbox
   extensions.
4. Browser and server startup require explicit `BrowserToolchainSource[]` or
   `ServerToolchainSource[]`. Hosts never discover, download, or choose a fallback toolchain.
5. Server startup verifies and composes an explicitly provisioned runtime distribution. It never
   builds missing executables while serving a request.
6. A dependency changes compilation. Its canonical lock and verified mounted tree participate in
   project validation, build identity, compiler input, artifact provenance, offline replay, and
   conformance.
7. Browser and server hosts expose the same operation, error, observation, artifact, judge, and
   dependency semantics. Host-only timing and transport details remain observational.

## Public abstractions

- `Operation<T>` owns one operation ID, state machine, abort signal, result promise, and scoped
  observation stream.
- `WasmOjError` is the stable infrastructure-error envelope. Compile diagnostics, runtime
  terminations, and judge verdicts remain normal result data.
- `Engine` composes a `Compiler`, `Runner`, optional `ArtifactStore`, judge registry, and dependency
  manager without importing a host implementation.
- `BrowserRuntimeDriverPlugin` identifies one same-origin SHA-256-pinned self-contained ESM module
  that constructs exactly one `RuntimeDriver` inside the runner Worker.
- `createBrowserEngine()` verifies explicit browser sources and constructs Workers plus browser
  storage.
- `createServerEngine()` verifies explicit native executables and package-owned server sources,
  then constructs filesystem storage, compiler, runner, and engine.
- `DependencyBuildBundle` is the compiler-facing archive-independent representation of a canonical
  lock and verified package file trees.

## Explicit non-goals

- The library submission API is not an HTTP service, authentication system, hidden-test store, or
  distributed queue.
- Browser plug-ins do not load arbitrary registry code or unpinned transitive modules.
- Host packages do not install compiler assets.
- Server startup does not provision native binaries.
- Dependency integration does not pretend unsupported scripts, native extensions, proc macros, or
  target-specific packages are portable; these inputs fail closed.
- Organizer does not compile, run, score, benchmark, or judge reference solutions.
