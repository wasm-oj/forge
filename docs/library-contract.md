# Library contract

`@wasm-oj/forge` is the public, environment-neutral contract.
`@wasm-oj/forge/browser` and `@wasm-oj/forge/server` provide host adapters that
implement the same `ForgeCompiler`, `ForgeRunner`, `ForgeArtifactStore`,
`BuildArtifact`, and `RunResult` interfaces. The judge depends only on the root
contract. `JudgeEngine` performs no network, filesystem, UI, or registry I/O on
its own; a downstream `JudgeInputProvider` explicitly owns any external I/O it
introduces.

## Compile, run, and judge

```ts
import {
  createForgeEngine,
  FORGE_CONTRACT_VERSION,
  textMatcher,
} from "@wasm-oj/forge";

const engine = await createForgeEngine({ compiler, runner, artifactStore });
const result = await engine.judgeProject({
  language: "rust",
  target: "wasip1",
  entry: "src/main.rs",
  files: { "src/main.rs": "fn main() { println!(\"42\"); }" },
}, {
  version: FORGE_CONTRACT_VERSION,
  failFast: false,
  cases: [{
    kind: "batch",
    id: "sample-1",
    input: { kind: "inline", value: "" },
    matcher: textMatcher("42\n"),
    determinism: { randomSeed: 7 },
    resources: { instructionBudget: 100_000_000 },
  }],
});
```

`judgeProject()` is the compile-once/run-many convenience operation. `compile()`, `run()`, and `judge()` remain separately available for applications that own artifact scheduling or persistence.

Every `BuildArtifact` carries `forgeContract: 1`. `assertValidBuildArtifact()`
is the shared fail-closed boundary used after compilation, on artifact-cache
loads, and before runtime-driver selection or cost-baseline lookup. For built-in
languages it binds the exact artifact kind, target, toolchain identities, cost
profile, and runtime package/command. It also verifies payload size and canonical,
path-safe runtime-bundle manifests. This makes serialized artifacts self-describing
instead of inferring compatibility from filenames or cost-profile strings.

`assertValidProject()` is the matching fail-closed boundary for project data.
It requires the exact plain-data project shape, normalized unique source paths,
existing entry and active files, valid language/target/optimization coordinates,
complete deterministic and resource policies, and string-only arguments,
standard input, environment, and source contents. It never fills defaults or
coerces values. `CompileCoordinator.compile()` and `precompile()` call it before
compiler identity, hashing, cache access, or compilation. Browser project
storage also validates before writes; malformed persisted records are removed
individually while other valid drafts remain available. The exported
`PROJECT_SOURCE_LIMITS` caps a project at 256 files, 4 MiB of UTF-8 source per
file, and 16 MiB total, so neither a browser Worker transfer nor a server child
transport can grow from an unbounded source payload.

## Compile-ahead contract

`precompile(input)` starts an exact content-addressed build intended for an editor idle debounce. A later `compile(input)` with the same canonical build identity joins that in-flight request; if it already completed, the normal `ForgeArtifactStore` returns it without invoking the compiler. `supersedePrecompile()` invalidates and cancels only speculative work. It never cancels a foreground build.

The identity includes the project ID and name, language, target, optimization, entry, canonically sorted file paths, file languages, source bytes, and the selected compiler's `cacheIdentity(project)`. Project ID and name are included because artifact metadata and runtime manifests carry them. Built-in compiler identities bind the Forge contract and exact toolchain content. A downstream compiler must change its identity whenever any compiler, linker, standard-library, configuration, or packaging input capable of changing output changes. Runtime stdin, arguments, environment, deterministic seed/clock values, and resource limits remain excluded because they do not change the build. Changed source can therefore never receive a stale artifact, while changing only a test case can reuse the compiled submission.

Compiler execution has one internal contract-fixed seed, logical clock, and
`SOURCE_DATE_EPOCH`; compiler input metadata uses that same epoch. Compile
requests expose no project-selectable determinism fields. This keeps C/C++
features such as `__TIMESTAMP__` compatible with the cache identity while run
requests remain free to select their own deterministic clock and seed.

Compile-ahead never shares a mutable compiler process across concurrent requests. Browser C/C++ bounds each Worker generation to eight output-ready compiler stages and retains only immutable toolchain handles plus content-addressed object bytes. Both Forge target labels use the same pinned `wasm32-unknown-wasip1` cc1 and LLD arguments; `wasix` changes artifact, cache, cost-calibration, and runtime-profile identity rather than selecting a second compiler ABI or runtime implementation. The runner validates the module's actual imports. Before a C/C++ build, the client reserves the maximum number of translation-unit, runtime-shim, and linker stages; after success it records the actual cache misses plus linker. Reuse requires the exact pinned toolchain and cc1 argv identity, source digest, and a fresh digest check of every recorded project dependency; an unchanged unit is verified, never assumed.

Browser Rust and Go requests are serialized through persistent language stages per compiler Worker generation. Rust retains its verified Wasmer Runtime, WebC package, compiler/linker command handles, and SDK thread pool; every Rust build receives a fresh project filesystem and command instances. Go retains the initialized runtime-core binding plus verified WebC, manifest, and decoded standard-library bytes; every Go build creates and drops a fresh two-stage compile/link pipeline. Rust conservatively reserves two output-ready stages per build and caps a generation at eight. Before crossing that boundary, the stage frees its commands, package, and Runtime and acknowledges shutdown; the outer compiler then releases its own resources and acknowledges quiescence before the client creates the replacement generation. The outer Wasmer Runtime is lazy and is not initialized for Rust, Go, or Python. The server contract remains one fresh Node/Wasmer child per build. Browser Python compilation uses a disposable stage Worker per build and retains no Python Runtime or package handles.

The standard Go compiler path is `GOOS=wasip1 GOARCH=wasm`. The pinned Go WebC exposes the official `compile` and `link` commands and a deterministic standard-library archive built from the same Go 1.26.5 distribution. Forge rejects Go/WASIX instead of silently compiling another ABI. Compiler and linker execute under Wasmer on browser and server hosts; no host `go` executable participates in a user build.

For C++ a single project file whose basename is `forge.pch.hpp` opts into precompiled-header compilation. The cache is an explicit source/header/package/PCH/object/link-result dependency graph. Every clean cc1 result records the compiler-emitted dependency set, and every lookup rehashes those inputs. Link-result identity includes exact object bytes and the pinned toolchain. Browser graph archives are stored in IndexedDB with SHA-256 verification and restored into replacement compiler Workers; `clearCache()` removes this archive together with the toolchain and artifact caches. A translation unit that emitted a warning is not cached because Forge cannot recreate its diagnostic stream without rerunning cc1.

## Dependency and lockfile contract

`ForgeDependencyManager` presents one API over Cargo crates, npm packages, PyPI distributions, Go modules, and C/C++ libraries. A `DependencyManifest` contains normalized requirements plus ecosystem-tagged native `manifest`, `lockfile`, or `source` files. One registered `ForgeDependencyResolver` owns each ecosystem; this keeps registry and package-manager policy out of Forge core while giving every resolver the same result contract.

Resolution produces one canonical `DependencyLock` containing ecosystem-qualified package IDs, exact versions, source identities, dependency edges, features, and SHA-256 payload integrity. Its `manifestSha256` binds the lock to the complete canonical cross-ecosystem request. Cycles are permitted because valid npm graphs may contain them. Scoped npm names are valid package names. Conflicting package records, missing or extra payloads, digest failures, dangling edges, and non-canonical locks fail closed.

`IndexedDbDependencyCache`, `FileSystemDependencyCache`, and `MemoryDependencyCache` implement the same content-addressed cache interface. Offline bundles contain the canonical lock and exactly one verified payload for every distinct digest. `resolve(..., { offline: true, previousLock })` never invokes a resolver; it requires a manifest-matching lock and verifies every cached payload first. This gives browser and server hosts the same lock and offline-import semantics without claiming that Forge core itself owns registry credentials or network policy.

```ts
const manager = new ForgeDependencyManager(cache, [cargoResolver, npmResolver]);
const manifest = {
  requirements: [
    { ecosystem: "cargo", name: "serde", requirement: "=1.0.228" },
    { ecosystem: "npm", name: "@scope/parser", requirement: "1.4.0" },
  ],
  sourceFiles: [{
    ecosystem: "cargo",
    role: "lockfile",
    path: "Cargo.lock",
    contents: cargoLock,
  }],
} as const;
const lock = await manager.resolve(manifest);
const offlineBundle = await manager.exportOffline(lock);
```

Leaving a retained C/C++, Rust, or Go family, or crossing a bounded stage budget, performs the acknowledged quiescence sequence before another family or generation builds. Cancellation, restart, request timeout, toolchain-cache clearing, disposal, and infrastructure failure hard-terminate the complete compiler Worker tree, including persistent language stages and Wasmer SDK secondary workers. A missing, malformed, failed, or timed-out graceful-shutdown acknowledgement fails closed; Forge never treats an unconfirmed teardown as reusable state.

`ForgeEngine.clearCache()` closes its operation gate, cancels accepted compiler
and runner work, and awaits both hosts' quiescence before deleting toolchain,
runtime, or artifact state. `ForgeRunner.cancelAndWait()` is therefore part of
the environment-neutral runner contract, not a browser-only convenience. The
compile coordinator also serializes persistence by cache key: if cancellation
lands during an artifact save, that save is removed before an exact retry can
load or replace it. Cache clearing cannot complete while a late save or runtime
preparation can still repopulate the cleared state.

## Serializable judge specification

The versioned `JudgeSpec` is designed as a serializable data contract. Its built-in fields contain only data; downstream matcher configuration must remain structured-clone- and serialization-safe. `validateJudgeSpec()` validates the built-in semantic fields, but it cannot make arbitrary custom configuration serializable.

- ordered, stable case IDs;
- inline input or a named provider/key plus optional SHA-256 integrity check;
- a discriminated `batch` or `interactive` execution mode;
- a named matcher plus serializable configuration for batch cases;
- per-case arguments, environment, deterministic clock/seed overrides, and resource overrides;
- provider-backed mounted files and explicit output-file capture paths;
- fail-fast or complete-case execution.

The built-in `text` matcher supports `exact`, `lines`, and `trimmed-lines`
normalization. `lines` normalizes line endings, removes trailing whitespace
from each line, and ignores terminal blank lines; `trimmed-lines` additionally
trims the outer edge of the complete output. The built-in `sha256` matcher
keeps large expected output out of the specification. When an input provider
supplies an expected SHA-256 digest, its data is verified before execution.

Applications register custom `JudgeInputProvider` and `JudgeMatcher` implementations through `ForgeEngineOptions.judge` or `engine.judging`. A matcher receives the artifact, resolved stdin, complete `RunResult`, stdout, stderr, captured files, and case descriptor. Built-ins cover text, digest, token, floating-point tolerance, set/multiset, and exact output-file-set policies.

`wasmCheckerMatcher(checker, expected)` mounts case input, expected output, contestant stdout/stderr, and captured output files under `/checker`, then executes the standalone checker artifact through the same `JudgeExecutor` and `ForgeRunner` sandbox. Checker exit 0 accepts, exit 1 rejects, and any other exit or resource termination is a judge error. The checker does not receive a host callback or escape the normal deterministic/resource policy.

An `interactive` case supplies a standalone Wasm interactor artifact and an `inputPath`. Forge prepares contestant and interactor using streaming-capable runtime drivers, starts them concurrently, and connects contestant stdout to interactor stdin and the reverse direction. Each side has independent arguments, environment, filesystem, cwd, instruction/logical-time/memory/output limits, metering state, and virtual-clock elapsed counter while using the same explicit determinism configuration. Keeping clocks process-local avoids making virtual time depend on host thread scheduling. Primary input and provider-backed secret files are mounted only for the interactor; the contestant receives none of them. The result retains both protocol directions and both stderr/termination records. Interactor exit 0 accepts, exit 1 is wrong answer, and any other interactor failure is a judge error. QuickJS bundles are rejected for interaction because their adapter consumes a complete prebuilt stdin script instead of a streaming fd 0; standalone Wasm and CPython declare streaming support explicitly.

## Verdict and metrics contract

Resource termination remains distinct from runtime failure: `instruction-limit`, `logical-time-limit`, `memory-limit`, `output-limit`, `filesystem-limit`, and `wall-time-limit` are stable verdicts. `logicalTimeLimitMs` bounds deterministic virtual elapsed time; sleep and clock polling fast-forward it without host waiting. `filesystemWriteLimitBytes` and `filesystemEntryLimit` bound additional live VFS occupancy above mounted inputs; growth and creation are transactional, and deletion releases reusable headroom. Every completed case retains its complete deterministic `RunResult`. The aggregate reports total net cost, total raw cost, the sum of the applied baselines, total logical time, maximum linear-memory/VFS occupancy, and stream byte counts; an unavailable host metric propagates as `null` instead of becoming a guessed value.

`instructionBudget` is the portable net CPU-scoring boundary. For the artifact's exact Forge contract, language, target, optimization, compiler/runtime content identity, and meter model, the runner resolves a calibrated empty-program baseline and applies:

```text
raw instruction budget = empty-program baseline + requested net instruction budget
reported net cost      = max(0, observed raw cost - empty-program baseline)
```

`RunResult.metrics` retains `cost`, `rawCost`, `baselineCost`, and `costProfile`. The subtraction removes only the fixed cost of starting the compiled runtime profile. Parsing or loading user modules, imports, stdin/args/environment handling, deterministic API initialization, I/O, allocation, and user code remain charged. Static `operations` are intentionally raw because they describe the executed module rather than a derived score.

The runner recomputes the expected profile from trusted artifact metadata and rejects mismatches or missing calibrations. A caller cannot attach another language's higher baseline to gain budget. `logicalTimeLimitMs` is portable contract data and may be used for deterministic elapsed-time judging. `wallTimeLimitMs` starts only when runtime preparation reaches the guest and is a deliberately generous emergency host boundary used to stop a broken or non-yielding engine; it is not deterministic and must not be used to compare submissions across machines. Browser and server hosts separately enforce a fixed 120-second preparation/control boundary, so package extraction or runtime setup cannot evade host termination by never reaching the guest.

## Conformance contract

`runConformanceHost()` produces a serializable `wasm-oj-forge-v1/conformance` snapshot. Browser and server can create snapshots in separate processes, then `compareConformanceSnapshots()` compares artifact digests and deterministic transcripts—including `logicalTimeNs`—and emits an efficiency matrix. The two compile measurements are explicitly named `firstUncachedCompileMs` and `repeatUncachedCompileMs`; neither pretends to be an artifact-cache hit. `runConformanceMatrix()` is the in-process convenience wrapper.

The default suite contains the declared C, C++, Rust, Go, Python, JavaScript,
and TypeScript target profiles plus deterministic filesystem metadata,
multi-file I/O, and denied-capability probes. The C/WASIX probe requires
`wasix_32v1.thread_spawn` to terminate with Forge's denied-capability trap. The
exported full suite adds a header-heavy libc++ probe. `/conformance` runs the
browser snapshot (`?suite=full` opts in to that probe); `npm run
conformance:server` runs the native-host snapshot
(`FORGE_CONFORMANCE_SUITE=full` does the same). The canonical panel is defined
in the [conformance specification](../experiments/forge-contract-1-conformance/SPEC.md),
and recorded measurements are published in the
[conformance report](conformance-report.md).

## Extension rules

Downstream languages use the same `ForgeCompiler` contract as Forge's seven built-ins. Implement a stable `cacheIdentity(project)` that changes whenever compiler or toolchain content affecting the build changes, then register the language with `ForgeCompilerRegistry`. The registry routes cache identity and builds by `project.config.language`, owns each compiler's lifecycle once, forwards progress, rejects ambiguous ownership, and seals its routing table on first use. Use `ForgeEngine` directly to compose this registry with a host runner; the browser `Forge` convenience class intentionally constructs only the built-in browser compiler.

A downstream compiler must emit a normal `BuildArtifact` whose contract, cache key, language, target, optimization, payload size, and toolchain provenance describe the build exactly. Downstream `toolchains` entries must be non-empty, unique, and trimmed. Call the exported `assertValidBuildArtifact()` at any additional persistence or transport boundary. Runtime-bundle compilers can use `createRuntimeBundleManifest()` to produce the required canonical manifest. Its cost profile must bind the exact downstream compiler/runtime content:

```ts
const profile = costProfileId(
  "zig",
  "wasip1",
  "release",
  "zig-0.13.0-sha256-deadbeef",
);
const baselines = createExtendedCostBaselineRegistry({ [profile]: measuredEmptyCost });
```

The explicit content identity is required for non-built-in languages. `resolveArtifactCostBudget()` validates the artifact coordinates before granting the calibrated baseline, and an unknown profile fails closed. `createExtendedCostBaselineRegistry()` adds downstream calibration without allowing a caller to replace any canonical Forge baseline.

A standalone `wasm` artifact uses the built-in runtime driver, so a downstream compiler can run on either host after its baseline is installed. A new `runtime-bundle` format additionally requires a `RuntimeDriver` registered in `RuntimeDriverRegistry`; `ServerForgeRunner` accepts that registry directly. `createDefaultRuntimeDrivers(baselines)` is the starting point when the extension should retain Forge's standalone, QuickJS, and CPython drivers.

When a runtime driver calls `RuntimeResolver.packageFileSystem()`, its
`PackageFileSystemRequest` must include the exact `expectedSha256` of the
exported `FORGEFS1` bytes. Browser and server resolvers include that digest in
the cache identity and verify cached and freshly exported bytes before
decoding. When a cached archive is corrupt, Forge removes that entry, performs
the normal cache-miss export in the same operation, verifies the pinned digest,
and only then decodes it. A corrupt fresh export fails the operation; it is
never accepted as a recovery path.

Server package preparation is a killable process boundary rather than an
in-process SDK call. `ServerForgeRunner` caches only verified bytes and decoded
file snapshots; Wasmer SDK handles remain owned by the one-shot child. A host
that needs to clear shared runtime storage must call `cancelAndWait()` before
`clearRuntimeCache()`. This prevents late preparation work from repopulating or
mutating storage after deletion starts. The built-in engine performs that
ordering as part of its cache-clear contract.

The current browser Worker boundary has one deliberate extension limit: `BrowserForgeRunner` can transfer `additionalCostBaselines`, but it cannot accept an arbitrary `RuntimeDriver` function through `postMessage`. Its Worker initializes only the runtime drivers bundled with Forge. Consequently, downstream languages that emit standalone Wasm or use an existing bundled runtime work in the browser, while a new runtime-bundle driver must first be included in the browser Worker build (or gain a future serializable Worker-extension protocol). Registering that driver only in the environment-neutral or server registry does not make it available inside the browser Worker.

Forge starts its emitted module Workers through same-origin `blob:` bootstraps. Every Wasmer SDK initialization supplies Forge's secondary-worker asset through the official `workerUrl` protocol. That worker validates the SDK initialization envelope (including `sdkUrl`), disables registry access, calls `initSync` with the transferred module and memory plus a page-aligned 1 MiB stack, installs the validated `sdkUrl`, and constructs the official `ThreadPoolWorker`. The packed build emits the facade, SDK/runtime Wasm, and nested Workers as external content-hashed assets rather than library-mode data URLs. This is host compiler/runtime scheduling policy and never grants guest thread-spawn capability.

A production host must serve `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless`, and `Cross-Origin-Resource-Policy: same-origin`; a Content Security Policy must allow `worker-src 'self' blob:`. Packed deployments must retain the emitted compiler, runner, Python-stage, Rust-stage, and Wasmer secondary-worker assets at URLs reachable from their parent bundles. Toolchain and cross-origin assets still require the CORS and Cross-Origin-Resource-Policy behavior imposed by the page's COEP policy.

Judge code remains unchanged. Any incompatible judge, artifact, normalization, metering, compiler, runner, extension, or conformance change increments the one Forge contract; artifacts and requests from older contracts are rejected explicitly. See [the versioning policy](versioning.md).
