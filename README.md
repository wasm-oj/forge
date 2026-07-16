# LocalWASI Judge

LocalWASI Judge is a fully in-browser online judge powered by the [Wasmer JavaScript SDK](https://docs.wasmer.io/sdk/wasmer-js/). Its 20 original problems, compiler toolchains, submissions, test execution, diagnostics, progress, and build artifacts all stay on the device.

## Judge experience

- Browse and filter 20 progressively harder Traditional Chinese problems.
- Work in C, C++, Rust core, Python, JavaScript, or TypeScript with Monaco and multi-file projects.
- Build once, run the sample, then execute each judge case locally through Wasmer.
- Compare normalized stdout, surface compile/runtime/time-limit/wrong-answer verdicts, and retain solved progress in browser storage.
- Stop a running submission by terminating and recreating the compiler Worker.

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
| C | `clang/clang` under Wasmer | Standalone WASI or WASIX `.wasm` |
| C++ | Clang++ mode and `wasm-ld` under Wasmer | Standalone WASI or WASIX `.wasm` |
| Rust | Local Rust/WASI core-profile frontend under CPython/WASI, then Clang | Standalone WASI or WASIX `.wasm` |
| Python | CPython 3.12/WASIX byte-compilation | Runtime bundle containing bytecode, project modules, and a pinned WASIX runtime contract |
| JavaScript | TypeScript 7.0.2/WASI checking and emit | CommonJS runtime bundle executed by QuickJS-ng 0.15.1/WASI |
| TypeScript | Native TypeScript 7.0.2 compiler built for WASI | CommonJS runtime bundle executed by QuickJS-ng 0.15.1/WASI |

The Rust frontend is deliberately a dependency-free core profile, not a fake `rustc`. For judge problems it adds a deterministic `read_int()` primitive, and supports functions, primitive numeric and string types, `let`, mutable bindings, ranges, `if`, `while`, returns, arithmetic, and print macros. It rejects Cargo, crates, collections, traits, structs, enums, pattern matching, async, and unsafe code with source diagnostics. A full browser-hosted `rustc` Wasmer package does not currently exist.

Python, JavaScript, and TypeScript use a runtime-bundle artifact because these languages require their language runtime. The executable WebAssembly runtime is pinned in the bundle manifest and is always launched by Wasmer. C, C++, and the Rust core profile produce raw standalone modules.

## Run locally

Requirements: Node.js 22.13 or newer and a modern browser with `SharedArrayBuffer` support.

```bash
npm install
npm run dev
```

Open the printed local URL. The development and production servers send COOP/COEP headers because Wasmer uses shared memory and worker threads.

Useful checks:

```bash
npm run typecheck
npm test
npm run build
```

## Local-first storage and network policy

- Per-problem language drafts and build artifacts are stored in IndexedDB.
- Solved-problem progress is stored in localStorage.
- Compiler packages, standard libraries, and registry payloads are cached with Cache Storage.
- The versioned TypeScript and QuickJS-ng WASI assets are built reproducibly from pinned upstream revisions and cached with Cache Storage.
- The first C/C++ build downloads the pinned Clang package and WASI sysroot; later builds reuse the device cache.
- Registry requests contain only pinned package identifiers. User source, stdin, environment values, diagnostics, and artifacts are never sent.
- Clearing caches is available under Build settings.

See [Architecture](docs/architecture.md) for the worker protocol, compilation pipelines, artifact model, and trust boundaries.
