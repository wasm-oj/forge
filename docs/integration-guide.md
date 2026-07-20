# Forge integration guide

This is the host-facing guide for embedding Forge in another online judge. The
same `ForgeEngine` submission, error, observation, dependency, artifact, judge,
and replay contracts are used in browsers and Node.js servers; only compiler,
runner, and storage adapters differ.

## Install and import boundaries

```bash
pnpm add @wasm-oj/forge
```

Use only the public export that owns the code's execution environment:

| Import | Purpose |
| --- | --- |
| `@wasm-oj/forge` | Host-neutral types, `ForgeEngine`, judge, dependencies, replay, and conformance |
| `@wasm-oj/forge/browser` | Browser Workers, IndexedDB storage, runtime-driver plug-ins, and service-worker registration |
| `@wasm-oj/forge/server` | Node.js/Wasmer compiler and runner, filesystem stores, and `createServerForge()` |

Forge contract version `1` supports `wasip1` and `wasix`. A target label never
silently selects another ABI: unsupported language/target pairs fail before a
build begins.

## Browser host

Deploy the package's emitted Worker assets without renaming them and serve the
exported `public/toolchains/` files at `assetBaseUrl`. Then construct one host:

```ts
import { Forge, registerToolchainCache } from "@wasm-oj/forge/browser";

await registerToolchainCache({
  scriptUrl: "/toolchain-cache-sw.js",
  scope: "/",
});

const forge = await Forge.create({
  assetBaseUrl: "/toolchains/",
  artifactCache: true,
});
```

The page must be cross-origin isolated. Its responses need COOP
`same-origin`, COEP `require-corp`, and CORP `same-origin`; CSP must permit
`worker-src 'self' blob:`.
Toolchain requests are static, digest-pinned GETs and contain no source code,
stdin, diagnostics, or artifacts.

## Server host

Provision the native binaries once, before application startup:

```bash
pnpm --dir node_modules/@wasm-oj/forge run runtime:build-native
```

When binaries and toolchains remain in their package-relative locations,
server initialization is one line:

```ts
import { createServerForge } from "@wasm-oj/forge/server";

const forge = await createServerForge();
```

For immutable application images, build into an external directory and name it
explicitly:

```ts
const forge = await createServerForge({
  runtimeDirectory: "/srv/forge-runtime/release",
  cacheDirectory: "/var/cache/forge",
});
```

Startup verifies both executables as real executable files and streams a
SHA-256 check over every pinned toolchain asset. It never downloads, builds, or
falls back to another distribution. An invalid distribution rejects with a
`ForgeError` whose code is `initialization-failure`.

## Submission-scoped operation

A submission is the unit of queueing, observation, cancellation, and result
ownership. Register the engine-wide observer before `submit()` when the host
needs the complete trace. A scoped `operation.onEvent()` subscription begins
with the operation's current state snapshot, then receives subsequent events:

```ts
import {
  FORGE_CONTRACT_VERSION,
  ForgeError,
  textMatcher,
} from "@wasm-oj/forge";

const stopObserving = forge.onObservation((event) => {
  persistObservation(event.operationId, event.sequence, event);
});

const operation = forge.submit({
  id: "submission-018f",
  input: {
    language: "rust",
    target: "wasip1",
    entry: "src/main.rs",
    files: { "src/main.rs": 'fn main() { println!("42"); }' },
  },
  spec: {
    version: FORGE_CONTRACT_VERSION,
    failFast: false,
    cases: [{
      kind: "batch",
      id: "sample-1",
      input: { kind: "inline", value: "" },
      matcher: textMatcher("42\n"),
    }],
  },
});

const stopOperationEvents = operation.onEvent(renderLiveEvent);

try {
  const { build, judge } = await operation.result;
  renderDiagnostics(build.diagnostics);
  renderVerdict(judge?.verdict);
} catch (error) {
  if (error instanceof ForgeError) recordInfrastructureFailure(error.toJSON());
  else throw error;
} finally {
  stopOperationEvents();
  stopObserving();
}
```

Operations run FIFO within one engine. IDs are unique for the engine's
lifetime. `operation.cancel(reason)` and an input `AbortSignal` cancel only that
operation; cancelling a queued operation does not touch the active compiler or
runner. While any submission is pending, direct `compile()`, `run()`,
`judge()`, replay, and cache clearing reject with `operation-conflict` so work
cannot cross the submission boundary.

Every observation contains an `operationId` and monotonically increasing
zero-based `sequence`. Event types are `state`, `progress`, `stream`, `build`,
`case`, and `error`. Listener failures are isolated from execution and remove
the failing listener.

## Errors, diagnostics, and verdicts

`ForgeError` is the stable infrastructure exception. Its serializable shape is:

```ts
interface ForgeErrorRecord {
  name: "ForgeError";
  message: string;
  code: ForgeErrorCode;
  stage: ForgeErrorStage;
  retryable: boolean;
  operationId?: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}
```

Codes are `operation-cancelled`, `operation-conflict`, `invalid-input`,
`unsupported`, `integrity-failure`, `compiler-failure`, `runner-failure`,
`judge-failure`, `replay-failure`, `dependency-failure`, `storage-failure`,
`initialization-failure`, `disposed`, and `internal-failure`. Stages are
`operation`, `compile`, `prepare`, `run`, `judge`, `replay`, `dependency`,
`storage`, and `initialize`.
`FORGE_ERROR_CODES` and `FORGE_ERROR_STAGES` expose these closed vocabularies at
runtime so telemetry schemas do not duplicate string lists.

Compiler errors and warnings are normal `BuildResult.diagnostics` with source,
severity, filename, line, column, and ranges where the toolchain provides them.
Guest resource termination is normal `RunResult.termination`. Wrong answers
and checker failures are normal judge verdicts. Hosts must not treat those
expected contestant outcomes as infrastructure exceptions.

## Dependencies enter the compiler

Resolution and archive extraction are separate, verified steps. The resulting
file-tree bundle is passed to `compile()` and becomes part of the compiler
input, artifact provenance, incremental build graph, and cache identity:

```ts
const manifest = {
  requirements: [{
    ecosystem: "npm",
    name: "left-pad",
    requirement: "1.3.0",
  }],
  sourceFiles: [{
    ecosystem: "npm",
    role: "lockfile",
    path: "package-lock.json",
    contents: packageLockText,
  }],
} as const;

const lock = await forge.resolveDependencies(manifest);
const dependencies = await forge.prepareDependencies(lock);
const build = await forge.compile({
  language: "javascript",
  target: "wasip1",
  entry: "src/main.js",
  files: {
    "src/main.js": 'const pad = require("left-pad"); print(pad("7", 3, "0"));',
  },
  dependencies,
});
```

The built-in mapping and admitted portable subset are deliberately strict:

| Ecosystem | Languages | Lock input | Admitted compiler input |
| --- | --- | --- | --- |
| Cargo | Rust | Cargo.lock v3/v4 with checksums | Rust source crates; no build scripts, proc macros, renamed crates, or native links |
| npm | JavaScript, TypeScript | package-lock v2/v3 with SRI | Flat, uniquely named CommonJS packages; no lifecycle scripts, ESM, or native modules |
| PyPI | Python | Exact hash-locked requirements | Pure Python wheels; no sdists, native extensions, or `.data` remapping |
| Go modules | Go | go.mod and go.sum | Reachable pure-Go packages; no cgo, assembly, or build constraints |
| C/C++ | C, C++ | `forge-cpp.lock.json` with HTTPS archives | Source and headers; no prebuilt native or Wasm objects |

Mixed ecosystems or a language/ecosystem mismatch fail instead of mounting
unused files. `DependencyBuildBundle.lockSha256` and every package's canonical
`filesSha256` are reverified before build-key computation. Browser and server
default hosts provide IndexedDB and symlink-resistant filesystem dependency
caches respectively. `exportOffline()` and `importOffline()` move the exact
lock plus digest-keyed package payloads without invoking a registry.

## Browser runtime-driver plug-ins

Runtime-driver plug-ins are trusted host code, not contestant code. Bundle each
driver into one self-contained ESM file, compute SHA-256 over the exact served
bytes, and register only the descriptor:

```ts
import { costProfileId } from "@wasm-oj/forge";

const acmeCostProfile = costProfileId("acme", "wasip1", "release", "acme-runtime-1");
const forge = await Forge.create({
  runtimeDriverPlugins: [{
    id: "acme-runtime",
    moduleUrl: "/forge-plugins/acme-runtime.mjs",
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  }],
  additionalCostBaselines: {
    [acmeCostProfile]: 123_456,
  },
});
```

The module must export `createRuntimeDriver()` (or the configured named
factory) and return a `RuntimeDriver` with exactly the descriptor ID. The
runner Worker fetches it with same-origin credentials, rejects redirects,
limits source to 1 MiB, verifies its digest, rejects every static or dynamic
import, imports it from a temporary Blob URL, and registers it before runtime
driver selection. At most 16 plug-ins are accepted. `supports()` must match
exactly the custom artifacts it owns; zero or multiple matching drivers fail.

Because the module executes with runner-Worker authority, a plug-in can see
artifacts and run configuration and must be reviewed and pinned like host
application code. It does not weaken Forge's native metering, memory, output,
VFS, logical-time, or emergency wall limits; its `PreparedRunRequest` must
preserve those inputs and use a calibrated cost profile.

## Lifecycle

Use one engine for a host scheduling domain. `clearCache()` first closes the
operation gate, cancels and awaits compiler/runner quiescence, then clears
toolchains, runtime files, artifacts, dependency payloads, and build-graph
state. `dispose()` is idempotent and permanently closes the engine. A host must
dispose during shutdown; it must not delete cache directories behind a live
engine.

For the complete data contracts, see [Library contract](library-contract.md).
For trust and process boundaries, see [Architecture](architecture.md). For
portable reproduction, see the replay section of the library contract.
