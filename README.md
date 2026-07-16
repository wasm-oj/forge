# LocalWASI Studio

LocalWASI Studio is a browser-local, multi-file compiler workbench powered by the [Wasmer JavaScript SDK](https://docs.wasmer.io/sdk/wasmer-js/). Source code, compiler diagnostics, build artifacts, and program input stay on the device.

## Language support

| Language | Build path | Output |
| --- | --- | --- |
| C | `clang/clang` under Wasmer | Standalone WASI or WASIX `.wasm` |
| C++ | Clang++ mode and `wasm-ld` under Wasmer | Standalone WASI or WASIX `.wasm` |
| Rust | Local Rust/WASI core-profile frontend under CPython/WASI, then Clang | Standalone WASI or WASIX `.wasm` |
| Python | CPython 3.12/WASIX byte-compilation | Runtime bundle containing bytecode, project modules, and a pinned WASIX runtime contract |
| JavaScript | TypeScript syntax pipeline under QuickJS/WASI | ES module runtime bundle with a pinned QuickJS/WASI runtime contract |
| TypeScript | TypeScript 4.9 executed inside QuickJS/WASI | Transpiled ES module runtime bundle with a pinned QuickJS/WASI runtime contract |

The Rust frontend is deliberately a dependency-free core profile, not a fake `rustc`. It supports functions, primitive numeric and string types, `let`, mutable bindings, ranges, `if`, `while`, returns, arithmetic, and print macros. It rejects Cargo, crates, traits, structs, enums, pattern matching, async, and unsafe code with source diagnostics. A full browser-hosted `rustc` Wasmer package does not currently exist.

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

- Projects and build artifacts are stored in IndexedDB.
- Compiler packages, standard libraries, and registry payloads are cached with Cache Storage.
- The first C/C++ build downloads the pinned Clang package and WASI sysroot; later builds reuse the device cache.
- Registry requests contain only pinned package identifiers. User source, stdin, environment values, diagnostics, and artifacts are never sent.
- Clearing caches is available under Build settings.

See [Architecture](docs/architecture.md) for the worker protocol, compilation pipelines, artifact model, and trust boundaries.
