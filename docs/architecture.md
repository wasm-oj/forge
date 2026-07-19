# Architecture

## Data flow

```mermaid
flowchart LR
  UI["Problem catalog + host application"] --> OS["Submission operation scheduler"]
  OS -->|"structured-cloned project"| CW["ForgeCompiler Web Worker"]
  CW --> CE["Built-in compiler engine"]
  SC["ServerForgeCompiler"] --> CE
  CE --> WR["Wasmer JS runtimes"]
  DM["Locked + verified dependency file trees"] --> CE
  CW --> RS["Browser serialized persistent Rust stage"]
  RS --> WR
  CW -.-> SW["Browser custom SDK secondary Workers"]
  RS -.-> SW
  WR --> TC["Pinned compiler and runtime modules"]
  TC --> AR["Wasm module or runtime bundle"]
  AR --> IDB["IndexedDB artifact cache"]
  AR --> RR["Shared runtime drivers"]
  BP["Pinned browser runtime plug-ins"] --> RR
  RR --> BW["Browser runtime-core Wasm Worker"]
  RR --> NP["Native runtime-core process"]
  BW -.-> SW
  DC["Seed + logical clock + net resource policy"] --> RR
  CB["Contract-bound empty-program baselines"] --> RR
  BW -->|"Wasmer 7 / WASIX"] RC["Metered disposable instance"]
  NP -->|"Wasmer 7 / WASIX"] RC
  RC -->|"stdout, stderr, exit, metrics"| JR["Judge / library caller"]
  JR --> OS
  JR -->|"verdict + diff"| UI
  PIN["Digest-pinned same-origin assets"] --> CS["Cache Storage"]
  CS --> WR
```

The UI sends immutable requests to dedicated compiler and runner module Workers. The compiler Worker and `ServerForgeCompiler` configure the same host-neutral built-in compiler engine. Both C/C++ target labels compile through the same eight-stage-bounded Clang 22 WASI P1 Worker pipeline. Browser Rust and Go builds are serialized through persistent language stages nested inside a compiler Worker generation; Python stages are disposable. The outer compiler Wasmer Runtime is lazy and is never created for Rust-, Go-, or Python-only generations. Server compiler children remain one-shot. A host-neutral `CompileCoordinator` may start an exact build during editor idle time, join a matching foreground request, and cancel stale speculative work; builds remain serialized. Every retained-family switch or stage-budget boundary uses the nested shutdown and outer quiescence acknowledgements before replacement. Cancellation, restart, timeout, cache clearing, disposal, or an infrastructure fault hard-terminates the complete browser compiler Worker tree. The browser runner Worker and native `forge-runner` execute the same Rust runtime core. Cancelling browser runner work recreates its Worker; cancelling server work kills its child process.

## Local judging

The catalog is a static, typed set of 20 original problems. Every problem defines its statement, input/output contract, constraints, examples, deterministic weighted-cost budget, and at least four judge cases. Fixture tests run independent reference solvers against every expected output.

A submission compiles once. For each case, `JudgeEngine` resolves `JudgeCaseSpec.input` and creates an independent `RunConfig`; it does not mutate the compiled project or its build configuration. Output comparison normalizes CRLF and trailing whitespace while preserving leading whitespace. The first wrong answer, non-zero exit, timeout, or runtime failure ends the submission. Accepted problem IDs persist in localStorage; per-problem, per-language drafts persist in IndexedDB.

The wall limit is an emergency host safety boundary, not a judging score. Browser and server hosts first apply a separate fixed 120-second preparation deadline. Only after runtime resolution succeeds does the browser start the guest timer; expiry replaces the runner Worker. `ServerForgeRunner` likewise starts the guest timer only for the native child and sends `SIGKILL` on expiry. Guest execution cannot continue after either deadline. Optimizer-derived weighted metering is the deterministic CPU limit, while `logicalTimeLimitMs` is the deterministic elapsed-time limit used for cross-host judging.

Execution reproducibility is a runner property, not part of the build key. The cache key includes sources, entry point, target, optimization, and `ForgeCompiler.cacheIdentity(project)`; each built-in compiler identity binds the Forge contract and pinned toolchain content. It excludes stdin, args, environment, run seed, run clock values, and resource limits. Compiler-side timestamps, entropy, source paths, and tool options are separately fixed by the compiler contract and cannot be selected by a run request. A submission therefore compiles once and starts every case from a fresh Wasmer instance with an explicit deterministic run configuration.

All judge cases necessarily ship to the browser. The UI and README state that this mode is designed for private practice and self-verification rather than cheat-resistant contests.

The default cross-host conformance panel covers every declared language/target profile, including standard Go/wasip1, plus deterministic-filesystem metadata, multi-file I/O, and a C/WASIX denied-capability probe. Every case compiles twice and runs repeatedly; the probes verify request-epoch filesystem timestamps, captured output-file bytes, and that `wasix_32v1.thread_spawn` reaches Forge's deterministic trap rather than a host concurrency implementation. The canonical panel and evidence procedure are defined in the [contract 1 conformance specification](../experiments/forge-contract-1-conformance/SPEC.md).

## Compilation pipelines

### C and C++

`scripts/pin-clang-cc1-argv.mjs` expands the packaged driver at toolchain-build time and freezes one set of complete `wasm32-unknown-wasip1` cc1 and `wasm-ld` argv templates for C17/C++20 and debug/release. The browser verifies the decompressed WebC package, filesystem archive, and argv manifest by SHA-256, mounts each immutable project at `/project`, invokes the frontend atom directly for every cache miss, and links the resulting objects. No compiler stage relies on guest fork/exec.

A successful stage is observed when its mounted object (plus complete dependency file) or linked module is valid WebAssembly. stdout and stderr are drained concurrently, so warnings and errors retain filename, line, column, severity, and message, plus a compiler code when supplied. Waiting for the SDK's delayed WASIX process cleanup added about 30 seconds after valid output; releasing the instance early removes that delay. Because those guest processes remain pending internally, one Wasmer Runtime cannot be reused without bound. The public `BrowserForgeCompiler` therefore accounts for frontend and linker stages and terminates the entire Worker before a build could cross the eight-stage Clang 22 safety boundary. The bound stays below an observed failure after 11 completed stages; freeing a Runtime in-place is explicitly forbidden because it produced delayed asynchronous traps. A single project whose cold build itself exceeds the budget is rejected explicitly.

The object cache is scoped to that Worker generation. Its identity covers the pinned toolchain digest, manifest digest, exact cc1 argv, configuration, unit path, and source SHA-256. Before reuse, every project dependency recorded by Clang is rehashed. System headers are covered by the separately verified toolchain filesystem digest. Every command still receives a fresh project filesystem and process state. Browser/server behavior and compile timing are recorded by the Forge contract conformance suite.

This pipeline removes host lifecycle latency but cannot remove all C++ frontend work. A single `forge.pch.hpp` opts into a real C++20 precompiled header. Forge ships separate debug/release PCH bytes for the canonical `FORGE_LIBCXX_PCH_HEADER`; they are generated by the packaged Clang command from the same frozen cc1 templates and `/usr` sysroot, gzip-reproducible, and bound by a dedicated manifest. Exact header equality is required, so the optimization cannot silently inject additional declarations. Because Wasmer VFS metadata differs from the compiler-build VFS epoch, only these fully digest-admitted bytes use `-fno-validate-pch`; custom PCHs keep Clang validation. Clang dependency files produce a content-addressed source/header/package/PCH/object/link-result graph; only diagnostically clean units are reusable. Browser Workers serialize a SHA-256-verified archive to IndexedDB after each C/C++ build and restore it after lifecycle recycling. The opt-in full conformance suite executes the admitted header profile. `wasip1` and `wasix` use the same pinned compiler arguments and emit the same WASI P1 module bytes for identical language, optimization, and source inputs. The Forge target label changes artifact, cache, cost-calibration, and runtime-profile identity only; it does not select a second Clang target or runtime implementation. The runner validates the module's actual imports.

Go uses the standard Go 1.26.5 compiler and linker atoms packaged as one WebC plus a deterministic archive of the matching 349-package `GOOS=wasip1 GOARCH=wasm` standard library. Browser builds use a persistent isolated Go stage; server builds use the same logical compile/link batch in a fresh child. Both execute the compiler and linker under Wasmer, and both produce a standalone WASI P1 module. The packager records the official source-distribution digest and reproducibly emits the same WebC, standard-library archive, and manifest digests.

### Rust / WASI P1

1. One browser Rust stage is created lazily inside each compiler Worker generation. It serializes requests and initializes its Wasmer Runtime, verified deterministic Rust WebC, provenance manifest, `rustc` and `wasm-ld` command handles, and SDK thread pool once. Those immutable toolchain handles stay warm for the generation. The package contains the real `rustc` 1.91.1-dev atom and matching standard-library volume, plus the pinned YoWASP LLVM 22 atom and `/usr` linker resources. During packaging, Forge replaces rustc's WASI clock and random imports with deterministic internal implementations; the manifest records compiler and linker source, content, and transformation hashes. The server instead initializes the same verified content in a fresh child for every build.
2. Every build creates a new project `Directory`, mounts its files at `/work`, and receives fresh `rustc` and linker command instances from the retained command handles. The package mounts its sysroot at `/rust` and linker resources at `/usr`. Forge invokes `rustc` with edition 2024, one codegen unit, `panic=abort`, a fixed source-path remap, deterministic LLVM/layout seeds, and the source-traceable `wasm32-wasip1-threads` target. It requests `--emit=obj` with saved temporary outputs, preserving both `main.o` and rustc's separately generated allocator-shim LLVM bitcode.
3. `-Zno-parallel-backend` and `-Z threads=1` make compilation single-threaded after rustc's required WASI-threads bootstrap. Forge then releases that command instance and invokes the package's `wasm-ld` command in a fresh instance with the exact manifest-pinned startup object, crate object, allocator bitcode, standard libraries, optimization, and output arguments. No host executable, registry package, or external linker participates.
4. Browser and server stages drain diagnostics concurrently and accept a mounted output only after byte-identical snapshots persist for 75 ms; a merely valid WebAssembly prefix is not sufficient. Each command instance is released after its stable output is copied, and each build's project `Directory` is freed. The browser retains only the stage's immutable Runtime, package, command handles, and SDK thread pool. Forge conservatively accounts for two output-ready processes per Rust build and permits at most four per compiler Worker generation. Before build three it asks the stage to free `rustc`, `wasm-ld`, the package, and Runtime, waits for `shutdown-complete`, then frees the outer compiler resources and waits for `quiesced` before starting the replacement Worker. The server child exits after every build. Both hosts consume identical package bytes, manifest arguments, environment, and source options.

The output uses shared linear memory because that is the standard library ABI supplied by this source build. Forge classifies the result as `wasip1`, provides the imported memory, and denies guest thread-spawn capability, so this does not grant submitted programs concurrent execution. The current compiler path includes `rustc` and `std`, but does not yet consume resolved Cargo packages or expose a WASIX Rust target; Cargo packages use the separate unified dependency/lockfile contract until a compiler adapter mounts them.

### Python

Forge builds CPython 3.14.6 from the official source archive with the pinned WASI SDK 24.0 toolchain, disables the unsupported `_socket` module, strips debug data, and packages the interpreter and pruned standard library as one deterministic WebC. The package is stored locally with source, SPDX, toolchain, license, expanded-WebC, and compressed-asset digests; no registry resolution participates in compilation or execution. The browser creates a disposable Python stage Worker for each build and terminates it after the result; Python Runtime and package handles are never retained across requests. The stage runs `py_compile` against every `.py` file inside the mounted project. Checked-hash invalidation keeps bytecode independent of filesystem timestamps. The artifact contains the byte-compiled entry, byte-compiled modules, source modules needed for Python imports, a manifest, and the exact runtime package identifier. Execution mounts the bundle and a deterministic archive of the pinned `/usr/local/lib/python3.14` standard library, then launches its WASI P1 entry with Wasmer.

### Wasmer SDK secondary workers

Every browser SDK initialization supplies Forge's emitted secondary-worker asset through Wasmer's official `workerUrl` option. The custom worker validates the official initialization envelope—including the required non-empty `sdkUrl`—then disables registry access, passes the transferred module and memory to `initSync` with a page-aligned 1 MiB stack, installs `sdkUrl`, and constructs the SDK's `ThreadPoolWorker`. This preserves the official initialization order while overriding only the verified stack policy. The packed browser pipeline emits the SDK facade, SDK Wasm, runtime-core Wasm, and nested Workers as separate content-hashed assets; Vite library-mode data-URL inlining is explicitly not used. The secondary pool implements host-side Wasmer scheduling for compiler and runtime packages; it is not a guest capability, and submitted modules still cannot spawn threads.

### JavaScript and TypeScript

The pinned native TypeScript 7.0.2 compiler is built from the official Go source as a WASI module. A small stdin/stdout adapter gives it an in-memory filesystem, so the Worker sends source files as JSON and receives emitted CommonJS modules plus native diagnostics without exposing host storage. JavaScript goes through the same parser, checker, and emit pipeline with `allowJs` and `checkJs` enabled.

Execution uses QuickJS-ng 0.15.1 plus the commit-pinned Forge adapter, built for WASI. The adapter exposes deterministic configuration through lazy host-backed getters, keeping empty-program startup independent of seed values. The Worker assembles emitted files into an in-memory CommonJS loader, injects stdin through the `std` contract, and launches the bundle with Wasmer. When served from the default same-origin `/toolchains/` path, the bundled service worker caches both compressed modules. Their upstream revisions, SHA-256 digests, and reproducible build command are documented in `public/toolchains/README.md`.

## Portable execution policy

`crates/runtime-core` is compiled in two forms from the same Rust source:

- `wasm32-unknown-unknown` plus wasm-bindgen for the browser runner Worker;
- a native `forge-runner` executable for `ServerForgeRunner`.

Both forms use Wasmer 7.2.0 and WASIX 0.702.0, run the same module-policy transformations, construct the same filesystem, install the same deterministic imports, and return the same Forge contract schema. The browser uses Wasmer's JavaScript engine; native builds use Cranelift plus limiting tunables. Host-observed `durationMs` can differ. The deterministic transcript is exit code, stdout, stderr, termination reason, net/raw/baseline weighted costs and profile, peak memory/VFS occupancy, output counts, and the effective deterministic/resource configuration.

### Weighted instruction metering

Before compilation, the runtime removes index-bearing debug/name custom sections, preserves WASIX `dylink.0` runtime metadata, and injects a mutable 64-bit gas counter. The initial budget is embedded before instantiation, so a WebAssembly start section cannot execute for free. Forge contract 1's `weighted` model is adapted from [Binaryen's WebAssembly optimizer cost analysis](https://github.com/WebAssembly/binaryen/blob/7f8e4cbf6273c9b13b3a1a42f5e2833ea0d0f686/src/ir/cost.h). Forge preserves the opcode table carried through WARK 0.3, including WARK's deliberate 1000-point penalty for instructions absent from that table. Static `operations` counts are collected from the original module before meter instructions are injected. This preserves score and reporting semantics while the runtime also enforces deterministic logical time and hard memory/output boundaries.

### Empty-program cost normalization

The public `instructionBudget` is a net budget. Before execution, the runtime driver validates the artifact's profile against the Forge contract, language, target, optimization, exact compiler/runtime content identity, and meter model. It fails closed if the artifact-declared coordinates differ or no calibration exists. The raw meter receives `baseline + net budget`; the public result reports both raw cost and `max(0, raw - baseline)`.

The baseline table is generated from an append-only calibration run covering all 18 supported profiles and five seeds. The deterministic transform verifies the frozen experiment spec, Forge contract, source-tree digest, complete profile/seed panel, successful empty outputs, and exact within-profile equality before generating production data. Evidence records hash every tracked and untracked source/toolchain file while excluding their own run directories, so a dirty worktree is still bound to exact bytes. Raw evidence, the canonical table, and its manifest live under `experiments/forge-contract-1-cost-baseline/`.

Only fixed startup is removed. For CPython and QuickJS, deterministic configuration is read lazily so seed and clock values do not alter empty startup cost; using random/time APIs still initializes and charges those paths. Operation counts remain the raw module counts and are never baseline-adjusted.

### Hard resource boundaries

- The module is re-encoded so every defined or imported linear memory has a maximum no larger than `memoryLimitBytes`. A minimum above the limit rejects before instantiation. Native Wasmer also receives limiting tunables, giving two independent enforcement layers.
- Memory64 modules fail module-policy validation before engine compilation. The pinned Forge runtime currently admits only 32-bit linear memories; WASIX 64-bit syscall namespaces do not imply Memory64 support.
- stdout and stderr write through a shared `OutputBudget`. Once the combined byte budget is exceeded, the run terminates as `output-limit`; retained byte counts remain available in metrics.
- Explicitly collected output files consume the unspent portion of that same captured-output budget. They do not replace write-time VFS enforcement.
- `filesystemWriteLimitBytes` and `filesystemEntryLimit` bound additional simultaneous live file bytes and non-root inodes above the freshly mounted request baseline. File growth, including sparse gaps, and inode creation reserve capacity before mutation; a failed reservation returns WASI `ENOSPC`, leaves the attempted growth uncommitted, and makes the final termination `filesystem-limit`. Overwrite does not consume new capacity, while truncate, unlink, and inode destruction release headroom. Metrics report peak total live occupancy, including the mounted baseline.
- Runtime mounts are validated before allocation at 32,768 files, 256 MiB per file, and 512 MiB total. Compiler VFS instances use a separate internal 512 MiB/65,536-entry ceiling so a toolchain cannot bypass the host boundary while producing intermediates.
- Weighted-budget exhaustion terminates as `instruction-limit`. Virtual elapsed time beyond `logicalTimeLimitMs` terminates as `logical-time-limit`. Browser and server hosts separately impose a hard emergency wall deadline by terminating the Worker or native child process.
- Each request receives a new Wasmer store, instance, WASI environment, deterministic state, and in-memory filesystem.
- Interactive contestant and interactor processes each receive an independent virtual clock and logical-time budget under the same determinism configuration. Protocol scheduling therefore cannot make one process consume the other process's time budget or make transcript time depend on host task ordering.

### Deterministic runtime adapters

The Rust runtime replaces `random_get`, `clock_time_get`, `clock_res_get`, and `poll_oneoff` imports for WASI preview 1 and WASIX 32/64 namespaces, plus WASIX `thread_sleep`. Entropy comes from a seeded SplitMix64 stream. Realtime, monotonic, process, and thread clock observations share one elapsed counter and advance it by the configured logical step. Relative or absolute clock polls and sleep advance that same counter directly; a ready fd wins a mixed poll without advancing time. No virtual wait blocks on the host.

Built-in language adapters also control their public high-level surfaces:

- C and C++ link only Forge's deterministic entropy adapter; wasi-libc clock and sleep calls go directly to the runtime's shared virtual clock. Rust and Go use their pinned standard libraries unchanged and reach the same host policy.
- Python's bootstrap controls `random`, `Random()`, `os.urandom`, secrets/UUID entropy, timezone, locale, and hash randomization before `runpy` starts the byte-compiled entry. CPython's native time, datetime, and sleep implementations use the runtime virtual clock directly.
- QuickJS installs deterministic `Math.random`, `performance`, crypto random values, and UUID generation before the CommonJS loader. Native `Date` reads the runtime virtual clock; `performance.now()` derives from the same native clock relative to the configured epoch.

The runner reserves `FORGE_RANDOM_SEED`, `FORGE_REALTIME_EPOCH_MS`, `FORGE_CLOCK_STEP_NS`, `PYTHONHASHSEED`, `TZ`, and `LC_ALL`; callers cannot shadow them. `RunResult.determinism`, `RunResult.resources`, and `metrics.logicalTimeNs` record the effective contract and consumed virtual time. Before instantiation, supported socket, network, process-spawn, and thread-spawn imports are replaced with signature-preserving trap functions, and unknown import namespaces or functions are rejected. Deterministic WASIX helpers such as thread identity, reported parallelism, and logical sleep remain available for pinned runtimes but cannot create guest concurrency.

## Library boundaries and extensibility

`ForgeEngine` depends only on the `ForgeCompiler`, `ForgeRunner`, and optional `ForgeArtifactStore` interfaces. Browser and server hosts implement those interfaces independently of the judge UI. A downstream language implements `ForgeCompiler` and registers its language with `ForgeCompilerRegistry`. The registry routes both `cacheIdentity(project)` and `build(project, cacheKey)`, owns each shared compiler lifecycle once, forwards progress, rejects ambiguous language ownership, and seals registration on first use. The compiler's cache identity must be stable and must change with every compiler or toolchain input that can affect output.

Execution is selected from artifact metadata through `RuntimeDriverRegistry`. A downstream compiler emitting standalone Wasm can use the built-in runtime driver after registering its calibrated cost profile; a new runtime-bundle format also requires a runtime driver. `ServerForgeRunner` accepts a custom registry. Browser hosts provide declarative same-origin, SHA-256-pinned `runtimeDriverPlugins`; the runner Worker verifies and constructs each self-contained ESM driver before registry lookup. Arbitrary functions never cross `postMessage`, transitive imports are forbidden, and plug-ins run with trusted host—not guest—authority. Judge orchestration and native resource enforcement remain unchanged.

Batch filesystem inputs are explicit `RunConfig.files` entries mounted into a fresh guest filesystem. Only normalized absolute `outputPaths` are collected; stdout, stderr, and those collected bytes share the captured-output boundary, while all guest file mutation is independently governed at write time by live VFS byte and inode quotas. `RunResult.files` carries defensive byte copies across both Worker and native JSON transports. Judge input providers may resolve each mounted file independently; exact file-set matching detects missing and unexpected outputs.

Special checkers and interactive judges reuse `ForgeRunner` rather than introducing a privileged runtime. A Wasm checker is an ordinary standalone artifact with mounted `/checker` files and normal deterministic/resource enforcement. Interactive execution prepares two streaming-capable artifacts, assigns distinct metering stores and budgets, connects bounded in-memory pipes in both directions, and starts both Wasmer processes concurrently. The runtime captures both protocol streams and both stderr streams. Secret case files exist only in the interactor filesystem. Contestant cost is reported for scoring; interactor cost remains observable on its process result but is not charged to the submission.

Dependency resolution is a separate host-neutral graph contract. Ecosystem resolvers for Cargo, npm, PyPI, Go modules, and C/C++ libraries consume tagged native manifest/lock/source files and return exact package records plus canonical payloads. Forge validates payload SHA-256, merges graphs, binds the canonical lock to a complete manifest digest, and stores content through browser IndexedDB or a symlink-resistant server filesystem cache. Offline resolution never invokes a resolver and succeeds only when the supplied lock matches the manifest and every cached payload verifies. Before compilation, ecosystem build adapters safely extract bounded canonical file trees and bind the lock plus each tree digest into `Project`, compiler inputs, incremental object/package/link nodes, artifact metadata, and replay. Each compiler admits only its portable source subset and rejects build scripts, native extensions, or mismatched ecosystems.

Every standalone module and runtime bundle carries the exact Forge contract in
`ArtifactMetadata`. Runtime preparation validates it before driver selection or
cost-budget resolution, so a persisted or externally supplied artifact from a
different contract fails closed.

Every `ServerForgeCompiler.build()` creates a fresh Node child containing its own Wasmer JavaScript runtime and returns one V8-serialized response through a private, one-shot temporary file. The file is created exclusively, read only after the child exits, and removed with its private directory. Multiple `ServerForgeCompiler` library instances can therefore coexist without sharing scheduler state, and cancellation kills the active compiler child. Browser Workers and server children share one language-aware control deadline: 60 seconds for the SDK-direct C/C++ stages, 120 seconds for Python/JavaScript/TypeScript, and 190 seconds for the pinned Rust and Go pipelines. These are emergency ceilings, not compile-speed targets; the outer host enforces them because a synchronous SDK-to-Wasm call can block the inner JavaScript event loop and its timers. `ServerForgeRunner` uses the same hard process boundary when a runtime driver needs a pinned package command or filesystem export: a one-shot Node/Wasmer child owns every SDK `Runtime`, package, and command handle, then returns a bounded V8 response through a private file. The parent retains only digest-verified private byte copies and decoded files. Browser and server runtime preparation share a 120-second control deadline, extended to 300 seconds only for CPython's one-time verified filesystem export; only after preparation succeeds does execution use the separate guest wall-time deadline. Cancellation kills either child, and `cancelAndWait()` reaches logical quiescence before cache deletion can begin.

## Storage

IndexedDB has two object stores:

- `projects`: autosaved project snapshots keyed by project ID.
- `artifacts`: content-addressed build products keyed by SHA-256 of canonical files and build configuration.

The artifact store retains the 20 newest builds. `ForgeStorageCoordinator` joins artifact, dependency, incremental graph, runtime-files, and toolchain storage under one cross-tab Web Locks policy. It records logical size and access time at write/read boundaries, reserves configurable browser-quota headroom, and evicts by retention class followed by LRU. The package exports a service-worker asset plus `registerToolchainCache()`. Within the registration's caller-selected same-origin scope, the worker caches only GET requests carrying exactly one valid expected-SHA-256 query value; it records verified byte length and cache time for the coordinator and is not coupled to a hard-coded `/toolchains/` directory. Cache hits and network responses are rehashed, stale same-path identities are pruned only after a verified replacement is stored, and quota/write failures do not invalidate already verified response bytes. A caller-selected cross-origin `assetBaseUrl` is outside that service-worker cache and follows the static host's caching policy. No compiler or runner resolves a registry package at execution time. The CPython runtime filesystem is stored as a deterministic `FORGEFS1` archive whose exact SHA-256 is recorded in the toolchain manifest and content identity. Browser and server runners include that digest in the cache identity and verify every cache hit and fresh export before structural decoding. A corrupt or oversized cached archive is removed and reported, then handled as a normal cache miss; the replacement must match the pinned digest before it is decoded. A corrupt fresh export fails closed. On the server the same verified archive is stored in the configured cache directory with a 64 MiB read boundary. Browser persistent-storage permission is requested through the coordinator at startup. Solved-problem IDs use a validated localStorage record separate from build artifacts.

The judge editor debounces build-identity changes for 900 ms and then calls the same compile coordinator in the background. A Run or Judge action for that exact identity joins the request or uses the persisted result. Editing source, target, profile, entry, or toolchain identity supersedes the old speculative intent and invalidates its artifact identity. If the superseded build is already running, cancellation replaces its complete compiler Worker tree; otherwise the retained C/C++ or Rust generation may serve the new serialized build within its stage budget. Runtime-only input changes do not invalidate a valid artifact.

## Security and privacy boundaries

- The production response sets `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless`, and `Cross-Origin-Resource-Policy: same-origin`, plus the documented referrer, content-type, and permissions policies. A Content Security Policy must allow `worker-src 'self' blob:`.
- Guest programs see only explicit in-memory mounts and configured stdin, arguments, and environment variables.
- Source paths are normalized and cannot escape the project mount.
- User-controlled code runs only inside Wasmer's WASI/WASIX sandbox in a disposable Worker or native child process.
- Browser compilation and runtime setup issue static GET requests only to the configured `assetBaseUrl` (same-origin `/toolchains/` by default). These requests contain no source, stdin, environment, diagnostics, or artifact data; server hosts read their configured local toolchain directory.
- No guest socket, network, process-spawn, or thread-spawn implementation is exposed. Supported denied imports trap before guest code can use them; unsupported imports fail module validation.
- Toolchain packages are content-pinned. A missing file or digest mismatch fails the build explicitly.
- Packed deployments must preserve every emitted compiler, runner, Python-stage, Rust-stage, Go-stage, and Wasmer secondary-worker asset at the URL referenced by its parent bundle. Removing or relocating a nested Worker is a deployment error, not a supported fallback.
- Sites builds apply a transport-only content-addressed chunk manifest to pinned toolchain files above the provider's 25 MiB per-file limit. Before vinext indexes public assets, the build stages deterministic 16 MiB parts and their manifest; it removes the staging files afterward and removes only the oversized monolithic copies from `dist`. Vinext also emits browser Wasm into both client and SSR/server trees; the Sites build verifies those bytes are identical, retains the client-static copy, and removes the two server duplicates so the Worker remains below its 10 MiB upload limit. The Sites UI explicitly configures the service worker with the canonical chunk manifest path. The service worker validates and persists that manifest, then verifies every part's declared length and SHA-256 before caching or streaming it. The compiler worker verifies the reconstructed compressed asset against the original pinned toolchain digest before decompression or execution; library and server packages retain the canonical monolithic files and identities.

## Worker protocol

Requests and responses are discriminated TypeScript unions. Long work reports phases such as `loading-toolchain`, `compiling`, `linking`, and `running`. Build responses contain diagnostics and a structured artifact; run responses contain the exit code, stdout, stderr, and duration. A runtime failure is returned as an error response with its worker-side stack.

Browser adapters use discriminated Worker messages. Nested Rust- and Go-stage requests are serialized within one compiler generation. Graceful replacement uses a causal outer `quiesce` request, nested `shutdown` → `shutdown-complete` handshake, and final outer `quiesced` acknowledgement; a malformed or timed-out acknowledgement fails closed, while emergency lifecycle operations terminate immediately. The Wasmer secondary-worker initializer separately validates the SDK's official initialization envelope. Server compiler and package-preparation stages use private one-shot V8 envelopes with stable-descriptor reads and explicit response and diagnostic byte limits; the server runner similarly bounds its native base64-JSON stdout and stderr channels. All adapters expose the same TypeScript interfaces. `ForgeEngine` owns the environment-neutral orchestration: `compile()` accepts a language, entry point, and file map; `run()` accepts an artifact and runtime inputs; `execute()` composes both. Keeping those operations separate is required for compile-once/run-many judging. Schema, storage, judge, cost, metering, determinism, compiler, runner, and internal lifecycle compatibility all share `FORGE_CONTRACT_VERSION`; upstream toolchain and package releases remain content identities rather than parallel contracts. See [the versioning policy](versioning.md).
