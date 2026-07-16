# Browser toolchains

These compressed WebAssembly binaries are built from pinned upstream source and execute locally through the Wasmer browser runtime.

| Asset | Upstream | Source revision | Build runtime |
| --- | --- | --- | --- |
| `typescript-7.0.2.wasm.gz` | [microsoft/typescript-go](https://github.com/microsoft/typescript-go) | `2bd066d87f5bafd315be9f40889d0a60b9e58e0b` | Go 1.26.3, `wasip1/wasm` |
| `quickjs-0.15.1.wasm.gz` | [quickjs-ng/quickjs](https://github.com/quickjs-ng/quickjs) | `v0.15.1` | Zig 0.16.0, `wasm32-wasi` |

The small adapters under `toolchains/` provide deterministic stdin/stdout protocols so the compilers and runtimes do not depend on host filesystem access. Rebuild both assets with:

```sh
./scripts/build-browser-toolchains.sh
```

Expected SHA-256 digests:

```text
7d4f8368c864610deaaa630d96ef4644dd9396d473dd0c1d8568cf2ebd52a093  typescript-7.0.2.wasm.gz
aa971f170b6444264aec82f2353ba9ddd8b2fba286c8a8f4426dd9416745175a  quickjs-0.15.1.wasm.gz
```

TypeScript-Go is licensed under Apache-2.0. QuickJS-ng and the local adapters are licensed under MIT-compatible terms; see the linked upstream repositories for their license texts.
