# WASM OJ Forge

WASM OJ Forge is a local-first compiler, deterministic runner, and online-judge library. It is the experimental successor to WASM-OJ's `compilet` and `wark`. In the browser deployment, source compilation, linking, execution, diagnostics, and all 20 original problems stay on the device. Compiler and language-runtime packages execute under the Wasmer JavaScript SDK; submitted programs execute under a portable Rust/Wasmer runtime core compiled for both WebAssembly and native server hosts.

All production compatibility is governed by one `wasm-oj-forge-v1` contract. It
jointly versions compilation, execution, determinism, metering, artifacts,
judge specifications, caches, and conformance schemas; there are no separate
compiler/determinism/resource/judge counters. See [versioning policy](docs/versioning.md).

## Judge experience

- Browse and filter 20 progressively harder Traditional Chinese problems.
- Work in C, C++, Rust, Go, Python, JavaScript, or TypeScript with Monaco and multi-file projects.
- Build once, run the sample, then execute each judge case locally through Wasmer.
- Compare normalized stdout, surface compile/runtime/time-limit/wrong-answer verdicts, and retain solved progress in browser storage.
- Stop a running build or submission by terminating and recreating its isolated Worker.

Because the judge is completely local, its test data can be inspected by a determined user. This is an explicit privacy and learning tradeoff: the product is for practice and self-verification, not cheat-resistant competition.

## The 20-problem track

| # | Problem | Topic | Difficulty |
| --- | --- | --- | --- |
| 01 | 兩數的本機握手 | Basic I/O | Easy |
| 02 | 三站溫差 | Conditions | Easy |
| 03 | 秒數時鐘 | Arithmetic | Easy |
| 04 | 閏年守門員 | Conditions | Easy |
| 05 | 一到 N 的捷徑 | Mathematics | Easy |
| 06 | 階乘尾端的零 | Number theory | Easy |
| 07 | 歐幾里得的節拍 | GCD | Easy |
| 08 | 最早的共同週期 | LCM | Easy |
| 09 | 質數守門員 | Primality | Medium |
| 10 | 數字鏡像 | Digit processing | Medium |
| 11 | 數位能量 | Digit processing | Medium |
| 12 | Collatz 計步器 | Simulation | Medium |
| 13 | 十億階 Fibonacci | Fast doubling | Hard |
| 14 | 模數引擎 | Binary exponentiation | Medium |
| 15 | 串流最高點 | Streaming | Medium |
| 16 | 能量帳本 | Prefix sums | Medium |
| 17 | 最長上升航段 | Linear scan | Medium |
| 18 | 一次交易 | Greedy | Medium |
| 19 | 多數訊號 | Boyer–Moore | Hard |
| 20 | 最大連續能量 | Dynamic programming | Hard |

## Language support

| Language | Build path | Output |
| --- | --- | --- |
| C | Pinned Clang 22 WebC; direct cc1 plus LLD with frozen WASI P1 arguments | Standalone WASI P1 `.wasm`; `wasix` changes Forge profile identity |
| C++ | The same Clang 22 module in C++20 mode plus the same LLD | Standalone WASI P1 `.wasm`; `wasix` changes Forge profile identity |
| Rust | Pinned `rustc` 1.91.1-dev WebC with its matching standard library under Wasmer | Standalone WASI P1 `.wasm` |
| Go | Pinned standard Go 1.26.5 compiler, linker, and `GOOS=wasip1 GOARCH=wasm` standard library under Wasmer | Standalone WASI P1 `.wasm` |
| Python | Source-built CPython 3.14.6/WASI P1 byte-compilation | Runtime bundle containing bytecode, project modules, and the pinned WASI P1 runtime contract |
| JavaScript | TypeScript 7.0.2/WASI checking and emit | CommonJS runtime bundle executed by QuickJS-ng 0.15.1 plus the pinned Forge adapter |
| TypeScript | Native TypeScript 7.0.2 compiler built for WASI | CommonJS runtime bundle executed by QuickJS-ng 0.15.1 plus the pinned Forge adapter |

For C and C++, `target: "wasip1"` and `target: "wasix"` do not select different compiler ABIs. Both use the same `wasm32-unknown-wasip1` cc1 configurations and LLD command from one verified manifest. Given the same language, optimization, and sources, the emitted module bytes are the same; `wasix` changes the artifact, cache, cost-calibration, and runtime-profile identity. The current Forge runner uses the same runtime implementation for both labels and validates the module's actual imports.

The Rust path uses a source-traceable browser-runnable `rustc` 1.91.1-dev build, its matching `wasm32-wasip1-threads` standard library, and a digest-pinned `wasm-ld` 22 stage. Forge restricts rustc to one codegen thread, emits the crate object plus rustc's allocator-shim bitcode, then links them in a fresh Wasmer command instance. In the browser, builds are serialized through one persistent Rust stage per compiler Worker generation. That stage keeps its verified Runtime, WebC package, `rustc`/`wasm-ld` command handles, and Wasmer SDK thread pool warm while giving every build a fresh project `Directory` and fresh command instances. The server still uses a fresh isolated child per build; no host compiler or linker participates on either host. The resulting shared-memory module is admitted as Forge `wasip1`; submitted programs do not receive thread-spawn capability. Collections, traits, structs, enums, macros, iterators, and normal `std` I/O compile normally.

The Go path runs the standard Go 1.26.5 `compile` and `link` commands as verified WebC commands under Wasmer. Its deterministic archive contains all 349 packages from the matching `GOOS=wasip1 GOARCH=wasm` standard library. The published package is reproducibly traced to the official Go source tarball and contains no host compiler binary. Go currently supports `wasip1`; Forge does not relabel it as WASIX.

C++ projects may opt into a real precompiled header by adding exactly one file named `forge.pch.hpp`. If its contents exactly equal the exported `FORGE_LIBCXX_PCH_HEADER`, Forge loads the matching debug/release PCH generated by the pinned Clang WebC, cc1 arguments, and WASI sysroot; both compressed and expanded bytes are manifest-pinned. Other header contents keep the custom local-PCH path. Forge records compiler dependencies and keys source, header, package, PCH, object, and link-result nodes by content. The browser persists a digest-verified graph archive in IndexedDB, so Worker recycling does not discard clean objects and link results. Units that emitted diagnostics are deliberately rebuilt because a cache hit could not faithfully reconstruct those diagnostics.

Python, JavaScript, and TypeScript use a runtime-bundle artifact because these languages require their language runtime. The executable WebAssembly runtime is pinned in the bundle manifest and is always launched by Wasmer. C, C++, Rust, and Go produce raw standalone modules.

The default conformance suite contains every declared language/target profile,
deterministic filesystem metadata, multi-file I/O, and write-time VFS quota probes,
plus one C/WASIX denied-capability probe. Browser and server compile
measurements use this Forge contract suite rather than a parallel benchmark
protocol. See the [conformance specification](experiments/forge-contract-1-conformance/SPEC.md)
and the latest recorded [conformance report](docs/conformance-report.md).

## Enforced execution policy

Every submitted module passes through the same `wasm-oj-forge-runtime-core` before Wasmer instantiates it:

| Control | Enforcement |
| --- | --- |
| Weighted metering | The opcode weights are adapted from [Binaryen's optimizer cost model](https://github.com/WebAssembly/binaryen/blob/7f8e4cbf6273c9b13b3a1a42f5e2833ea0d0f686/src/ir/cost.h). Forge preserves WARK 0.3 compatibility, including its verified 1000-point penalty rule, and injects the meter into every function and the start section; judging uses a versioned empty-program-normalized net score. |
| Linear memory | Every defined or imported memory receives a hard maximum; the native engine also applies limiting Wasmer tunables. |
| Captured output | stdout, stderr, and explicitly collected output files share one byte budget. The result reports each stream's retained byte count. |
| Writable VFS | File growth and inode creation are reserved transactionally against separate live-occupancy limits. Mounted inputs form the baseline; truncation and deletion release headroom. |
| Logical time | Clock reads advance by a configured deterministic step. WASI clock polls and WASIX sleep fast-forward the same virtual clock without waiting for the host; `logicalTimeLimitMs` terminates as `logical-time-limit`. |
| Emergency wall deadline | Browser Workers and native child processes are forcibly replaced or killed if the engine itself stops making progress. |
| Determinism | WASI/WASIX clock and random imports, language-level time/random APIs, locale, timezone, and Python hash seed are controlled by an explicit run contract. |

`RunResult` reports `termination`, baseline-normalized `cost`, unadjusted `rawCost`, `baselineCost`, `logicalTimeNs`, profile provenance, meter model, peak linear-memory/VFS occupancy, and output byte counts. The requested 10,000,000,000-point instruction budget is a net budget: the runner enforces `raw budget = calibrated empty-program baseline + net budget`, then reports `cost = max(0, rawCost - baselineCost)`. The profile covers the Forge contract, language, target, optimization, exact compiler/runtime content identity, and meter model; mismatched or uncalibrated artifacts are rejected. This removes fixed CPython/QuickJS/CRT startup without making it free to parse input, import modules, initialize APIs, I/O, allocation, or execute user code. Logical time, memory, captured output, writable VFS occupancy, and the 60-second emergency wall boundary remain hard limits. Contract 1 calibration evidence and exact values are recorded in [the calibration experiment](experiments/forge-contract-1-cost-baseline/).

## Library API

The package root, `@wasm-oj/forge`, is the supported environment-neutral
boundary. `@wasm-oj/forge/browser` adds the Worker-based browser host and
`@wasm-oj/forge/server` adds the Node/Wasmer host. `ForgeEngine` composes a
`ForgeCompiler`, `ForgeRunner`, and optional `ForgeArtifactStore` into compile,
run, judge, and execute operations.

A downstream language implements `ForgeCompiler`, including a stable
`cacheIdentity(project)` bound to every compiler and toolchain input that can
change output, then registers its language with `ForgeCompilerRegistry`. The
registry routes both cache identity and builds, owns shared compiler lifecycle
once, and seals registration on first use. Standalone modules use the existing
runtime path; a new runtime-bundle format also needs a `RuntimeDriver`. The
browser `Forge` convenience class contains only built-in compilers, so custom
compiler composition uses `ForgeEngine`. Browser runtime-driver injection has
an additional Worker boundary described in the
[library contract](docs/library-contract.md#extension-rules).

`Forge` is the browser host. It computes content-addressed build keys and optionally persists artifacts in IndexedDB. Both C/C++ target labels use the same compiler-stage-bounded WASI P1 Worker pipeline: immutable toolchain state and verified translation-unit objects remain warm until the next build could exceed the eight-stage Clang 22 safety budget. Rust uses a persistent serialized stage; Forge conservatively charges two output-ready stages per Rust build (`rustc` plus `wasm-ld`), caps a Worker generation at eight, and recycles the complete Worker tree before the fifth build. Go uses a separate persistent serialized stage that retains its verified toolchain and standard-library bytes while runtime-core creates and drops each two-step compile/link pipeline. A graceful boundary asks every active language stage to release its resources, waits for its shutdown acknowledgement, then waits for the outer compiler Worker to acknowledge quiescence before starting the next generation. Python's compiler stage is disposable, and the outer Wasmer Runtime is initialized lazily only for C, C++, JavaScript, or TypeScript. Cancellation, restart, timeout, cache clearing, disposal, and infrastructure failure remain hard-termination boundaries. `precompile()` provides safe compile-ahead for edit–test loops: a matching foreground compile joins the exact in-flight request or loads its content-addressed artifact, while `supersedePrecompile()` cancels stale speculative work without cancelling a foreground build.

```ts
import { Forge } from "@wasm-oj/forge/browser";

const forge = await Forge.create({
  assetBaseUrl: "/toolchains/",
  artifactCache: true,
});

try {
  const input = {
    language: "typescript" as const,
    entry: "src/main.ts",
    files: {
      "src/main.ts": 'import * as std from "std";\nstd.out.puts("42\\n");\n',
    },
  };
  // Optional: call after an editor idle debounce.
  void forge.precompile(input);

  const build = await forge.compile(input);

  if (!build.success || !build.artifact) {
    console.table(build.diagnostics);
    throw new Error("Compilation failed.");
  }

  const result = await forge.run(build.artifact, {
    stdin: "7 35\n",
    determinism: {
      randomSeed: 42,
      realtimeEpochMs: Date.UTC(2000, 0, 1),
      clockStepNs: 1_000_000,
    },
  });

  console.log(result.stdout);
} finally {
  forge.dispose();
}
```

`execute()` is available for one-shot use. `onProgress()` and `onStream()` expose build phases and process output; `precompile()`, `supersedePrecompile()`, `cancel()`, `restart()`, `clearCache()`, and `dispose()` manage scheduling and lifecycle. A production browser host must provide `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless`, and `Cross-Origin-Resource-Policy: same-origin`. Forge uses same-origin `blob:` bootstraps for its module Workers, so a Content Security Policy must include `worker-src 'self' blob:`. The packed compiler, runner, Python-stage, Rust-stage, and Wasmer secondary-worker assets must all remain deployed at their emitted reachable URLs. Toolchains may use another base URL only when that host provides CORS and Cross-Origin-Resource-Policy headers compatible with the page's COEP policy.

The package exposes a strict public export map for npm, workspace, and packed-
tarball consumers. `npm run library:build` emits the three entries,
declarations, browser Worker assets, and isolated server stages;
`npm run library:verify` validates the official Wasmer SDK integrity, package
boundary, licenses, packed contents, and NodeNext consumer types. A browser
host must serve the files in `public/toolchains/` at its configured
`assetBaseUrl` (the default is `/toolchains/`). The package also exports
`@wasm-oj/forge/toolchain-cache-sw.js`; copy that file unchanged to a
same-origin public URL whose service-worker scope covers `assetBaseUrl`, then
register that exact URL through the browser entrypoint:

```ts
import { registerToolchainCache } from "@wasm-oj/forge/browser";

await registerToolchainCache({
  scriptUrl: "/toolchain-cache-sw.js",
  scope: "/",
});
```

The default options match a host that places the exported file at
`/toolchain-cache-sw.js`. The registration helper waits for that registration's
own worker to activate; it does not wait on an unrelated global scope.
Size-limited static deployments may additionally pass
`chunkManifestUrl: "/toolchains/forge-sites-chunks.json"` after generating that
canonical manifest and its content-addressed parts. This mode is explicit: npm
consumers serving the canonical monolithic assets do not probe for, or silently
fall back through, a second transport. Every configured chunk and the
reconstructed asset are SHA-256 verified before use.
`prepack` performs both build and verification, including real registration of
the service-worker asset from the packed tarball.

`judgeProject()` compiles once and evaluates a versioned, data-oriented `JudgeSpec`. Named input providers and matchers are registries, so downstream applications can add remote-data adapters, digest-verified fixtures, token/float/property checkers, or domain-specific verdict logic without changing the engine. Custom matcher configuration must remain serialization-safe when a host persists or transfers the specification. See [Library contract](docs/library-contract.md).

Batch cases may mount multiple input files and collect explicit output paths. Built-in matchers cover text, SHA-256, tokens, floating-point tolerance, sets/multisets, and exact output-file sets. `wasmCheckerMatcher()` executes a compiled standalone Wasm checker through the same `ForgeRunner` sandbox. Interactive cases run contestant and interactor concurrently with full-duplex pipes, independent resource budgets, deterministic clocks/randomness, and secret files mounted only on the interactor side.

`createDefaultDependencyManager()` installs real native-lockfile adapters for Cargo crates, npm packages, PyPI distributions, Go modules, and C/C++ libraries. They consume Cargo.lock v3/v4 checksums, package-lock v2/v3 SRI, exact hash-locked requirements, go.mod plus Go's official `h1` ZIP hash, or an explicit Forge C/C++ lock. Forge does not pretend to be a second semver solver: roots must be exact and unsupported sources fail closed. The manager emits one canonical graph lock bound to the complete manifest SHA-256, stores every package by payload digest, exposes `materialize()`, and supports integrity-checked browser IndexedDB, server filesystem, and offline bundle transport. In offline mode it never calls a resolver: it requires a matching previous lock and verifies every cached payload.

`ForgeReplayBundle` is the portable replay boundary. `createForgeReplayBundle()` normalizes ephemeral project/artifact timestamps, embeds source, artifact, optional offline dependencies, the exact run or self-contained judge contract, and its deterministic transcript. `encodeForgeReplayBundle()` emits a canonical `FORGRPL1` binary envelope with sorted, deduplicated SHA-256 blobs; decode rejects corruption, non-canonical JSON, missing or unused blobs, trailing bytes, and contract drift. `forge.replay()` recompiles by default, compares the stable artifact digest, reruns or re-judges, and reports field-level deterministic mismatches. Provider-backed judge inputs must be materialized inline; built-in matchers, Wasm checkers, and interactors remain portable because their artifacts are embedded.

The server host injects the same compiler engine and runtime core into the same high-level API:

```ts
import { createForgeEngine } from "@wasm-oj/forge";
import { ServerForgeCompiler, ServerForgeRunner } from "@wasm-oj/forge/server";

const compiler = new ServerForgeCompiler({
  compilerExecutable: "/srv/wasm-oj-forge-runtime/release/forge-compiler",
  toolchainDirectory: "./public/toolchains",
});
const runner = new ServerForgeRunner({
  runtimeExecutable: "/srv/wasm-oj-forge-runtime/release/forge-runner",
  toolchainDirectory: "./public/toolchains",
  cacheDirectory: "./.cache/forge-runtime",
});
const forge = await createForgeEngine({ compiler, runner });

const { build, run } = await forge.execute({
  language: "typescript",
  entry: "src/main.ts",
  files: { "src/main.ts": 'import * as std from "std";\nstd.out.puts("42\\n");' },
});
```

`ServerForgeCompiler` starts a fresh isolated Node/Wasmer child for each
uncached build, so independent library instances do not share scheduler state
and cancellation can kill the compiler. Server runtime-package preparation is
also a one-shot Node/Wasmer child; the parent keeps only verified bytes and can
kill a stalled preparation at its 120-second control deadline. After
preparation, `ServerForgeRunner` starts a fresh native runtime-core process for
each run, which supplies the separate guest wall boundary. Call
`cancelAndWait()` before manually clearing runtime storage; `ForgeEngine`
already enforces that ordering.

Forge intentionally does not ship an opaque platform binary and does not run a
compiler during package installation. The npm tarball instead contains the
exact `runtime-core` Rust source, `Cargo.lock`, the pinned `rust-toolchain.toml`,
and the two audited local Cargo patches needed by that lockfile. Provision one
native runner explicitly before starting a server:

```bash
# Forge source checkout; output is crates/runtime-core/target/release/forge-runner.
npm run runtime:build-native

# Installed npm package; keep generated artifacts outside node_modules.
npm explore @wasm-oj/forge -- npm run runtime:build-native -- \
  --target-dir /srv/wasm-oj-forge-runtime
```

The second command produces
`/srv/wasm-oj-forge-runtime/release/forge-runner`, the path used in the example
above. Both commands use the package-root toolchain pin and `cargo build
--locked`; registry dependencies are fetched only during this explicit server
provisioning step. The packed-package verifier builds this source contract and
then runs a TypeScript program through the packed `ServerForgeCompiler` and
`ServerForgeRunner`, so a missing source, patch, stage, or executable boundary
fails publication.

## Deterministic execution contract

Every run requires a validated random seed, realtime epoch, and virtual-clock step. Defaults are seed `0x5eed1234`, `2000-01-01T00:00:00Z`, and one millisecond per observation. Given the same artifact, stdin, args, environment, and determinism configuration, the supported single-threaded language surface produces the same exit code, stdout, and stderr.

- The runtime core replaces WASI and WASIX `random_get`, `clock_time_get`, `clock_res_get`, and `poll_oneoff` imports before instantiation, and virtualizes WASIX `thread_sleep`. C and C++ link only an entropy adapter; their wasi-libc clock and sleep calls, plus the unchanged Rust and Go standard-library calls, reach this shared host clock directly.
- Python starts through a bundled bootstrap that controls `random`, `Random()`, `os.urandom`, `secrets`, UUID entropy, timezone, and locale. CPython's native `time`, `datetime`, and sleep implementations reach the shared host clock; interpreter hash randomization is fixed independently.
- JavaScript and TypeScript install deterministic `Math.random`, `performance`, `crypto.getRandomValues`, and `crypto.randomUUID` before loading user modules. Native QuickJS `Date` reaches the shared host clock, and `performance.now()` derives from it relative to the configured epoch.
- Each run receives a fresh Wasmer instance and seekable ephemeral filesystem. Supported socket, network, process-spawn, and thread-spawn imports are replaced with signature-preserving traps before instantiation; unknown import namespaces or functions are rejected. Deterministic WASIX helpers such as thread identity, reported parallelism, and logical sleep remain available but cannot create guest concurrency.

`durationMs`, build duration, artifact IDs, and creation timestamps are host observations and are outside the deterministic transcript. The clock is logical: every supported clock observation advances it by `clockStepNs`; language sleep and relative or absolute clock polling advance it by the requested virtual duration without waiting. `logicalTimeLimitMs` bounds this deterministic elapsed time independently of the emergency wall deadline.

## Run locally

Requirements: Node.js 22.13 or newer and a modern browser with
`SharedArrayBuffer` support. Building the optional native server runner also
requires rustup/Cargo; the package pins Rust 1.97.1.

```bash
npm install
npm run dev
```

Open the printed local URL. The development and production servers send COOP, COEP, and CORP headers because the Wasmer SDK uses `SharedArrayBuffer` and host-side Workers. Forge supplies the SDK's official `workerUrl` protocol with a custom secondary worker: it validates the SDK initialization envelope, disables registry access, calls `initSync` with a page-aligned 1 MiB secondary stack, then installs the validated `sdkUrl` in the same order as the official SDK worker. The packed browser build emits the SDK facade and Wasm modules as external content-hashed assets rather than data URLs. These secondary workers belong to the host compiler/runtime implementation and do not expose guest thread-spawn capability. The production launcher serves emitted `.wasm` assets as `application/wasm`, preserving streaming WebAssembly compilation.

Useful checks:

```bash
npm run typecheck
npm test
npm run contract:verify
npm run library:build
npm run library:verify
npm run runtime:test
npm run runtime:check-web
npm run cost-baseline:transform -- <primary-raw-record.json>
npm run build
```

## Local-first storage and network policy

- Per-problem language drafts and build artifacts are stored in IndexedDB. `ForgeStorageCoordinator` applies one cross-tab Web Locks admission policy across artifacts, dependency payloads, the incremental build graph, runtime files, and toolchains. It enforces logical and browser-quota headroom, then evicts by retention class and LRU; toolchains have the highest retention priority.
- Solved-problem progress is stored in localStorage.
- Browser compiler packages, runtime modules, and standard libraries are fetched as digest-pinned static files from the configured `assetBaseUrl` (same-origin `/toolchains/` by default). Each same-origin request carries the expected SHA-256 as its cache key; the bundled service worker verifies both cache hits and network responses, removes stale same-path content, and treats persistence failure as an optimization failure rather than a failed verified fetch. A cross-origin asset host controls its own HTTP caching. Generated runtime filesystem archives use a caller-selected cache directory on the server.
- The versioned TypeScript and QuickJS-ng WASI assets are built reproducibly from pinned upstream revisions. Their `.wasm.gz.bin` suffix keeps artifact compression distinct from HTTP `Content-Encoding`.
- Rust verifies one source-traceable WebC and its provenance manifest by SHA-256, then runs the package's `rustc` and `wasm-ld` commands under Wasmer. The compiler, matching standard library, pinned linker, and linker resources stay inside that package; there is no host compiler, linker, or registry resolution.
- C/C++ verifies the decompressed Clang WebC, WASI P1 sysroot, single pinned cc1/`wasm-ld` manifest, and two reproducible toolchain-admitted libc++ PCH profiles by SHA-256. Within a bounded Worker generation, unchanged translation units reuse dependency-validated objects; compressed PCH/toolchain responses remain in Cache Storage across generations. The real C++ PCH conformance case compiles and executes below the ten-second target on the native Wasmer host.
- Compile and run paths perform no runtime registry resolution. Asset fetches are static GET requests and contain no source, stdin, environment, diagnostics, or artifact data. Guest network imports are denied by the runtime policy rather than routed to a host network implementation.
- Clearing caches is available under Build settings.

See [Architecture](docs/architecture.md) for the worker protocol, compilation pipelines, artifact model, and trust boundaries.
The latest recorded browser/server parity and efficiency measurements are in [the conformance report](docs/conformance-report.md).
