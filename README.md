# WASM-OJ

[![CI](https://github.com/wasm-oj/forge/actions/workflows/ci.yml/badge.svg)](https://github.com/wasm-oj/forge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40wasm-oj%2Fsdk)](https://www.npmjs.com/package/@wasm-oj/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

WASM-OJ is a local-first compiler, deterministic runner, and online-judge SDK. C, C++, Rust,
Go, Python, JavaScript, and TypeScript compile and run through digest-pinned WebAssembly
toolchains. The browser host keeps source, artifacts, local tests, and practice progress on the
device. Official Submit sends source to a one-shot server Container, which recompiles it against
immutable judge data and returns only the authorized result.

The product and public SDK are named **WASM-OJ**. The GitHub repository remains
[`wasm-oj/forge`](https://github.com/wasm-oj/forge) until a separate repository migration is
approved; repository URLs in package metadata intentionally keep that path.

## Package architecture

The code packages share one release version and form a one-way dependency graph:

```text
@wasm-oj/contracts
        │
        ▼
  @wasm-oj/core
   ┌────┼──────────┐
   ▼    ▼          ▼
browser server  organizer
   └────┴────┬─────┘
             ▼
       @wasm-oj/sdk
        server ─────┐
       organizer ───┼──▶ @wasm-oj/cli
          core ─────┘
```

| Package | Boundary |
| --- | --- |
| `@wasm-oj/contracts` | Contract-2 constants, wire models, errors, toolchain descriptors, and source types; no host dependencies |
| `@wasm-oj/core` | Host-neutral `Engine`, compiler and runner contracts, judge, dependency, replay, and conformance logic |
| `@wasm-oj/browser` | Browser Workers, IndexedDB/Cache Storage adapters, and `createBrowserEngine()` |
| `@wasm-oj/server` | Node.js/Wasmer adapters, filesystem storage, native runtime processes, and `createServerEngine()` |
| `@wasm-oj/organizer` | Static collection and immutable judge-package validation/publication; never compiles or runs reference solutions |
| `@wasm-oj/cli` | The local-first `woj` Student/Organizer interface; explicit local runtime/toolchain commands and authenticated remote resource commands |
| `@wasm-oj/sdk` | Convenience entrypoints that re-export the packages above without embedding duplicate copies |

Compiler and runtime assets are independently versioned packages:

- `@wasm-oj/toolchain-clang`
- `@wasm-oj/toolchain-rust`
- `@wasm-oj/toolchain-go`
- `@wasm-oj/toolchain-python`
- `@wasm-oj/toolchain-javascript`
- `@wasm-oj/toolchain-java`

Neither `@wasm-oj/sdk` nor a host package installs or selects toolchains implicitly. Every host
receives an explicit source array. Source registration rejects a missing source, stale contract,
undeclared language/profile, or duplicate asset ownership. The browser checks each asset's byte
length and SHA-256 digest when that asset is first fetched; server startup verifies every declared
asset before accepting work.

## Install

Install only the host and toolchains the application uses:

```sh
pnpm add @wasm-oj/browser \
  @wasm-oj/toolchain-clang \
  @wasm-oj/toolchain-rust \
  @wasm-oj/toolchain-go \
  @wasm-oj/toolchain-python \
  @wasm-oj/toolchain-javascript \
  @wasm-oj/toolchain-java
```

Applications that prefer one namespace can install `@wasm-oj/sdk` and import
`@wasm-oj/sdk/browser`, `@wasm-oj/sdk/server`, or `@wasm-oj/sdk/organizer`. Toolchains remain
separate and explicit in either form.

## Browser host

Deploy each installed toolchain package's exported `assets/` directory to an HTTP directory. A
single directory may contain all five packages when filenames remain unchanged.

```ts
import { createBrowserEngine } from "@wasm-oj/browser";
import { browserSource as clangSource } from "@wasm-oj/toolchain-clang";
import { browserSource as rustSource } from "@wasm-oj/toolchain-rust";
import { browserSource as goSource } from "@wasm-oj/toolchain-go";
import { browserSource as pythonSource } from "@wasm-oj/toolchain-python";
import { browserSource as javascriptSource } from "@wasm-oj/toolchain-javascript";
import { browserSource as javaSource } from "@wasm-oj/toolchain-java";

const toolchainBase = "/toolchains/";
const engine = await createBrowserEngine({
  toolchains: [
    clangSource(toolchainBase),
    rustSource(toolchainBase),
    goSource(toolchainBase),
    pythonSource(toolchainBase),
    javascriptSource(toolchainBase),
    javaSource(toolchainBase),
  ],
  artifactCache: true,
});

const build = await engine.compile({
  language: "rust",
  target: "wasip1",
  optimization: "release",
  entry: "main.rs",
  files: { "main.rs": 'fn main() { println!("42"); }' },
});

if (build.artifact) {
  const result = await engine.run(build.artifact, { stdin: "" });
  console.log(result.stdout);
}

engine.dispose();
```

The page must be cross-origin isolated. Serve documents with COOP `same-origin`, COEP
`require-corp`, and CORP `same-origin`; CSP must permit `worker-src 'self' blob:`. Toolchain
requests address the immutable asset filename and append its digest query to any query parameters
configured on the source base URL. They never contain source, stdin, diagnostics, or artifacts.

## Server host

The server package ships the native runtime source, not opaque prebuilt host executables. Build
`wasm-oj-compiler` and `wasm-oj-runner` while constructing the deployment image:

```sh
pnpm --dir node_modules/@wasm-oj/server run runtime:build-native
```

Then pass the runtime directory and installed package-owned toolchain directories explicitly:

```ts
import { createServerEngine } from "@wasm-oj/server";
import { serverSource as clangSource } from "@wasm-oj/toolchain-clang";
import { serverSource as rustSource } from "@wasm-oj/toolchain-rust";
import { serverSource as goSource } from "@wasm-oj/toolchain-go";
import { serverSource as pythonSource } from "@wasm-oj/toolchain-python";
import { serverSource as javascriptSource } from "@wasm-oj/toolchain-javascript";
import { serverSource as javaSource } from "@wasm-oj/toolchain-java";

const engine = await createServerEngine({
  runtimeDirectory: "/srv/wasm-oj/runtime/release",
  cacheDirectory: "/var/cache/wasm-oj",
  toolchains: [
    clangSource(),
    rustSource(),
    goSource(),
    pythonSource(),
    javascriptSource(),
    javaSource(),
  ],
});
```

Startup verifies both executables and every declared asset. It does not search the filesystem,
download missing files, invoke a host compiler for user code, or fall back to another distribution.

## `woj` CLI

Install the one Student and Organizer CLI. Local commands do not authenticate or access the
network; remote commands use browser-assisted authorization and store the resulting token only in
the operating system credential store.

```sh
pnpm add -D @wasm-oj/cli
pnpm exec woj organizer collection build .
pnpm exec woj organizer collection verify .
pnpm exec woj auth login
pnpm exec woj organizer collection validate <collection-id> --ref <branch-tag-or-commit> --wait
```

`build` and `verify` are deterministic local preflight. Remote `validate` resolves the requested ref
once and statically validates that immutable commit; it never compiles or runs a reference
solution. Publication and official-practice activation are separate explicit commands. See the
[CLI journey](docs/cli.md) for the complete command tree and stable exit-code contract.

The Organizer boundary checks canonical schema, normalized paths, bounded byte lengths, digests,
and deployable `WOJJDG02` judge packages. Reference solutions remain author-owned input;
Organizer does not compile, execute, score, benchmark, or decide whether they are correct.

Official Submit is the execution boundary. It compiles a user's source inside a one-shot Container
and judges it against the already published immutable package with no public dependency network.

## Compatibility contract

All active wire and storage identities use contract 2:

```ts
WASM_OJ_CONTRACT_VERSION = 2
WASM_OJ_CONTRACT_ID = "wasm-oj-v2"
```

Contract 2 covers compiler/runner requests, artifacts, judge specifications, deterministic inputs,
metering, replay, caches, package descriptors, and conformance evidence. Older shapes are rejected;
there is no compatibility shim or silent migration path.

Host and infrastructure failures use the stable `WasmOjError` envelope. Compiler diagnostics and
guest verdicts remain typed domain results rather than exceptions.

Binary envelopes are also versioned and fail closed:

| Format | Magic |
| --- | --- |
| Replay bundle | `WOJRPL02` |
| Immutable judge package | `WOJJDG02` |
| Runtime filesystem archive | `WOJFS002` |
| Go shared-file archive | `WOJGO002` |

See [versioning](docs/versioning.md), the [library contract](docs/library-contract.md), and the
[host integration guide](docs/integration-guide.md).

## Supported languages

| Language | Compiler path | Artifact/runtime |
| --- | --- | --- |
| C | Clang 22 cc1 + LLD with pinned WASI P1 arguments | Standalone Wasm |
| C++ | Clang 22, libc++ and optional pinned PCH + LLD | Standalone Wasm |
| Rust | rustc 1.91.1-dev + matching standard library + wasm-ld | Standalone Wasm |
| Go | Go 1.26.5 `compile` + `link` + pinned `wasip1` standard library | Standalone Wasm |
| Python | CPython 3.14.6 bytecode preparation | Runtime bundle executed by CPython/WASI |
| JavaScript | TypeScript-Go checking/emit | Runtime bundle executed by QuickJS-ng 0.15.1 |
| TypeScript | TypeScript-Go checking/emit | Runtime bundle executed by QuickJS-ng 0.15.1 |

`wasix` is a profile identity for the admitted C/C++ output; it does not silently select a second
compiler ABI. Unsupported language/target/profile combinations fail before compilation.

## Determinism and judging

The Rust runtime core is built for browser Wasm and native server hosts. It validates imports,
instruments weighted instructions, enforces deterministic random/clock inputs, bounds memory,
output and filesystem growth, and records normalized metrics. Browser and server hosts use the
same artifact and judge contracts.

Batch judging supports text, SHA-256, token, float, set/multiset, file-set, and sandboxed Wasm
checker matchers. Interactive judging connects contestant and interactor through bounded
full-duplex pipes with separate resource policies. `instructionBudget` is the portable scoring
boundary; wall time is only a host safety deadline.

Dependencies enter compilation only as a verified, archive-independent `DependencyBuildBundle`.
Online resolution requires a host-supplied `DependencyNetworkAuthorizer` plus an explicit immutable
repository/bundle/host scope. See [dependency network consent](docs/dependency-network-consent.md).

## Online Judge product boundary

Local Build, Run, and Judge remain browser-only. Official Submit accepts canonical source files,
rebuilds them in a one-shot Container, and scores them against immutable judge data. The server
ignores client artifacts, limits, verdicts, and hidden-data claims.

Catalog import and publication are static Organizer operations. They validate exact-commit schema,
paths, sizes, digests, canonical encoding, redaction, and judge-package deployability. They do not
start a Container or evaluate reference solutions. See the [Cloudflare Online Judge](docs/cloudflare-online-judge.md)
and [production deployment](docs/cloudflare-deployment-plan.md) guides.

## Development

The repository uses Node 24 and pnpm 10:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Useful verification commands:

```sh
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run library:build
pnpm run library:verify
pnpm run docs:verify
pnpm run licenses:verify
pnpm run build
```

Package release instructions are in [docs/releasing.md](docs/releasing.md). Toolchain provenance,
asset digests, and rebuild commands are in [public/toolchains/README.md](public/toolchains/README.md).

## Security and licenses

WASM-OJ executes hostile guest programs by design; review [SECURITY.md](SECURITY.md) before a
production deployment. Project source is MIT licensed. Distributed toolchains and runtime
dependencies retain their upstream licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
and the machine-verifiable [`licenses/components.json`](licenses/components.json) inventory.
