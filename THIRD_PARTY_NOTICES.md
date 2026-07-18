# Third-party notices

This file covers third-party software distributed by the `@wasm-oj/forge`
package, including the content-addressed compiler and runtime assets under
`public/toolchains`. The Forge source code is licensed under the MIT License in
`LICENSE`; that license does not replace the terms of any component listed
below.

The canonical machine-readable component, distribution, source-revision, and
license-file inventory is `licenses/components.json`. Its verifier binds every
listed file to a SHA-256 digest and rejects unlisted toolchain or license files.

## JavaScript runtime dependency

### Wasmer JavaScript SDK

- Component: `@wasmer/sdk` 0.10.0
- npm integrity: `sha512-YQ+s5tGag6P/I8kp9BTH+XhjoS9UFvWiZJvnWEEovClHffhYToKhprWr4UJG7wLP7c/2HQpGkF7ZrjoUvKjdmA==`
- Source revision: `wasmerio/wasmer-js@93b8b738ebd3ee57e118da0f0eb795b97d5b999e`
- Locked Rust graph: `Cargo.lock` SHA-256
  `d352926f3f05e3d4308c4e261711d07db568e5c2b4387067180f920da074791f`
- Source: <https://github.com/wasmerio/wasmer-js/tree/93b8b738ebd3ee57e118da0f0eb795b97d5b999e>
- License: MIT
- License material: `licenses/wasmer-sdk-MIT.txt`,
  `licenses/wasmer-sdk-dependencies.html`, and
  `licenses/wasmer-sdk-dependencies.json`

Forge consumes the official npm artifact without patching the installed
package. The generated dependency report covers every package in the pinned
normal Cargo dependency graph selected for `wasm32-unknown-unknown`; its compact
inventory binds all 332 package identities and the exact HTML report digest.

## Distributed toolchain assets

### TypeScript-Go

- Distributed asset: `typescript-7.0.2.wasm.gz.bin`
- Source revision: `microsoft/typescript-go@2bd066d87f5bafd315be9f40889d0a60b9e58e0b`
- Source: <https://github.com/microsoft/typescript-go/tree/2bd066d87f5bafd315be9f40889d0a60b9e58e0b>
- Build runtime: Go 1.26.3 standard library (`GOOS=wasip1`, `GOARCH=wasm`)
- Licenses: TypeScript-Go Apache-2.0; Go standard library BSD-3-Clause
- License and attribution material: `licenses/Apache-2.0.txt`,
  `licenses/typescript-go-NOTICE.txt`, and
  `licenses/go-BSD-3-Clause.txt`

The TypeScript-Go notice is carried from the exact pinned source revision
(normalized from CRLF to LF without changing its text). The Go license is from
the exact `go1.26.3` source tag used by the reproducible build script.

### Go compiler toolchain

- Distributed assets: `go-1.26.5-wasip1.webc.gz.bin`,
  `go-1.26.5-wasip1.stdlib.gz.bin`, and
  `go-1.26.5-wasip1.manifest.json`
- Source: <https://go.dev/dl/go1.26.5.src.tar.gz>
- Source archive SHA-256:
  `495be4bc87176ac567392e5b4116abd98466d33d7b49d41e764ccc6976b2dc42`
- License: BSD-3-Clause
- License material: `licenses/go-BSD-3-Clause.txt`

Forge packages the standard Go `compile` and `link` commands plus the matching
349-package `GOOS=wasip1 GOARCH=wasm` standard library. The stored license is
byte-identical to `go/LICENSE` in the exact Go 1.26.5 source distribution.

### QuickJS-ng

- Distributed asset: `quickjs-0.15.1.wasm.gz.bin`
- Compressed SHA-256: `5b1419b8d65d2b910b61954071e28d99ce1fd401b5dd9b47e2bf16552f9ff582`
- Expanded Wasm SHA-256: `21fcf23a5fdf3e64b803344c9af86be01e95feabf4779d02aef325c852bc2c2e`
- Source revision: `quickjs-ng/quickjs@fd0a0210b7be00957751871e7e01b8291268fc29`
- Source: <https://github.com/quickjs-ng/quickjs/tree/fd0a0210b7be00957751871e7e01b8291268fc29>
- Build SDK: [WASI SDK 24.0 release archive for arm64 macOS](https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-24/wasi-sdk-24.0-arm64-macos.tar.gz),
  SHA-256 `aeae999396d5f5caa5ce419f52e83c35869d5fd21d40af80acba2c80f51b0b3a`
- WASI SDK source revision: `WebAssembly/wasi-sdk@d2bea01edcc46f731156a817f710cdd9fc9c1c19`
- LLVM and compiler-rt source revision: `llvm/llvm-project@26a1d6601d727a96f4301d0d8647b5a42760ae0c`
- WASI libc source revision: `WebAssembly/wasi-libc@b9ef79d7dbd47c6c5bafdae760823467c2f60b70`
- Sources: <https://github.com/WebAssembly/wasi-sdk/tree/d2bea01edcc46f731156a817f710cdd9fc9c1c19>,
  <https://github.com/llvm/llvm-project/tree/26a1d6601d727a96f4301d0d8647b5a42760ae0c>, and
  <https://github.com/WebAssembly/wasi-libc/tree/b9ef79d7dbd47c6c5bafdae760823467c2f60b70>
- Licenses: QuickJS-ng and the Forge adapter MIT; LLVM compiler-rt
  Apache-2.0 WITH LLVM-exception plus the third-party terms collected in its
  license; WASI libc Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT, with
  separately licensed dlmalloc, cloudlibc-derived, and musl-derived portions
- License and attribution material: `licenses/quickjs-ng-MIT.txt`,
  `licenses/wasi-sdk-24.0-Apache-2.0-LLVM-exception.txt`,
  `licenses/wasi-sdk-24.0-compiler-rt-LICENSE.txt`,
  `licenses/wasi-libc-b9ef79d-LICENSE.txt`,
  `licenses/wasi-libc-b9ef79d-Apache-2.0.txt`,
  `licenses/wasi-libc-b9ef79d-MIT.txt`,
  `licenses/wasi-libc-b9ef79d-cloudlibc-BSD-2-Clause.txt`,
  `licenses/wasi-libc-b9ef79d-dlmalloc-CC0-NOTICE.txt`, and
  `licenses/wasi-libc-b9ef79d-emmalloc-NOTICE.txt`, and
  `licenses/wasi-libc-b9ef79d-musl-MIT.txt`

The reproducible build links `crt1-command.o`, `libm.a`,
`libwasi-emulated-signal.a`, `libc.a`, and
`libclang_rt.builtins-wasm32.a` from that one digest-verified SDK archive.
Linker tracing confirms that the selected allocator is dlmalloc, not emmalloc.
Forge distributes the resulting stripped Wasm runtime, not the host Clang, LLD,
or strip executables. The build script nevertheless verifies those executables
and every linked archive by SHA-256 before compiling.

### Rust compiler and standard libraries

- Distributed assets: `rust-1.91.1-dev.webc.gz.bin` and
  `rust-1.91.1-dev.manifest.json`
- Build source: `olimpiadi-informatica/wasm-compilers@ae62cab6adf0665377d19ffa39daeaf758290431`
- Build artifact: GitHub Actions run `26545267884`, `rust.tar.br` SHA-256
  `ba0096d05275954d852a3fb3a9c4c9438dad501f8e428b867c0b88cfa7301c14`
- Linker payload: `@yowasp/clang@22.0.0-git20542-10`, npm archive SHA-256
  `6230ea1afa9691fa065935cf68c01642ff9b31c183fe8ac64cdfda025df06009`;
  its exact source revisions and license closure are recorded in the following
  “Clang, LLD, libc++, and WASI libc” section
- Rust source submodule: `rust-lang/rust@ed61e7d7e242494fb7057f2657300d9e77bb4fcb`
- LLVM source submodule: `llvm/llvm-project@87f0227cb60147a26a1eeb4fb06e3b505e9c7261`
- GCC source submodule: `gcc-mirror/gcc@ae91b5dd14920ff9671db8ff80c0d763d25f977f`
- Source: <https://github.com/olimpiadi-informatica/wasm-compilers/tree/ae62cab6adf0665377d19ffa39daeaf758290431>
- Build repository license: Apache-2.0
- Rust license: MIT OR Apache-2.0; LLVM license: Apache-2.0 WITH LLVM-exception
- `libloading` 0.8.8: ISC; Cargo.lock checksum
  `07033963ba89ebaf1584d767badaa2e8fcec21aedea6b8c0346d487d49c28667`
- GCC libstdc++ runtime components: GPL-3.0 with GCC Runtime Library
  Exception 3.1
- License and attribution texts: `licenses/rust-MIT.txt`,
  `licenses/Apache-2.0.txt`, `licenses/LLVM-exception.txt`,
  `licenses/rust-COPYRIGHT.txt`, `licenses/rust-COPYRIGHT.html`,
  `licenses/rust-COPYRIGHT-library.html`, `licenses/libloading-ISC.txt`,
  `licenses/GPL-3.0.txt`, and
  `licenses/GCC-Runtime-Library-Exception-3.1.txt`

The pinned build repository contains its complete Rust/LLVM source revisions,
the applied `rust.patch`, and the GitHub workflow used for the pinned artifact.
That workflow builds libstdc++ from the pinned GCC submodule before building
LLVM and rustc. The custom `rust.tar.br` omits Rust's generated binary-release
notices, so Forge carries the complete `COPYRIGHT.html` and
`COPYRIGHT-library.html` from the official Rust 1.91.1 release for the exact
`ed61e7d7e` source revision. The official release archive used to source those
notices is `rustc-1.91.1-x86_64-unknown-linux-gnu.tar.xz`, SHA-256
`4b4c596fc5268435c310a79c2e231a5a3567572c930ac0740ef9e147e83baf4e`.

Forge copies the matching `wasm32-wasip1-threads` sysroot, replaces rustc's
WASI `random_get` and `clock_time_get` imports with deterministic internal
implementations, and packages the transformed atom and sysroot together with
the verified YoWASP LLVM linker atom and resources into one WebC. The provenance
manifest records source-rustc, transformed-rustc, linker archive, linker core,
and linker-resource SHA-256 digests. These transformations and the generated
WebC do not relicense Rust or any third-party component identified by the exact
Rust COPYRIGHT reports and YoWASP source closure carried here.

### Clang, LLD, libc++, and WASI libc

- Distributed asset: `clang-22.0.0-git20542-10.webc.gz.bin`
- Clang source artifact: `@yowasp/clang@22.0.0-git20542-10`, npm archive
  SHA-256 `6230ea1afa9691fa065935cf68c01642ff9b31c183fe8ac64cdfda025df06009`
- YoWASP source revision: `YoWASP/clang@944dd7c774954180e621cc8e12984023a7f8bcbe`
- LLVM source revision: `YoWASP/llvm-project@97196c8eeb1d495fa43bb8af2fb26af5ef5b89fb`
- WASI libc source revision: `WebAssembly/wasi-libc@ac020b86fd44bafe60aa4fa12f407d16e3731329`
- Sources: <https://github.com/YoWASP/clang/tree/944dd7c774954180e621cc8e12984023a7f8bcbe>
  and <https://github.com/YoWASP/llvm-project/tree/97196c8eeb1d495fa43bb8af2fb26af5ef5b89fb>
- LLVM license: Apache-2.0 WITH LLVM-exception
- WASI libc license: Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT,
  with separately licensed portions identified by the upstream notice
- License and attribution texts: `licenses/LLVM-exception.txt`,
  `licenses/Apache-2.0.txt`, `licenses/wasi-libc-ac020b86-LICENSE.txt`,
  `licenses/wasi-libc-ac020b86-musl-fts-BSD-3-Clause.txt`,
  `licenses/wasi-sdk-24.0-Apache-2.0-LLVM-exception.txt`,
  `licenses/wasi-libc-b9ef79d-Apache-2.0.txt`,
  `licenses/wasi-libc-b9ef79d-MIT.txt`,
  `licenses/wasi-libc-b9ef79d-cloudlibc-BSD-2-Clause.txt`,
  `licenses/wasi-libc-b9ef79d-dlmalloc-CC0-NOTICE.txt`,
  `licenses/wasi-libc-b9ef79d-emmalloc-NOTICE.txt`, and
  `licenses/wasi-libc-b9ef79d-musl-MIT.txt`

The published npm manifest incorrectly says `ISC` and omits a license file.
The exact source revision's root `LICENSE.txt` and npm README both explicitly
license the package under Apache-2.0. Forge does not redistribute the npm
JavaScript wrapper: the packaging script digest-verifies and extracts only the
LLVM core and LLVM/WASI resource payload, whose complete upstream license terms
are carried above. The common Apache, MIT, cloudlibc, dlmalloc, emmalloc, and
musl terms are byte-identical between the pinned `ac020b86` and `b9ef79d7`
source trees, so the inventory reuses the exact digest-bound `b9ef79d7` copies;
the revision-specific root and musl-fts notices remain separate. The generated
WebC and pinned command manifests do not relicense those payloads.

### CPython 3.14.6 for WASI P1

- Distributed assets: `python-3.14.6-wasip1.webc.gz.bin` and its provenance
  manifest `python-3.14.6-wasip1.manifest.json`
- Official source archive: <https://www.python.org/ftp/python/3.14.6/Python-3.14.6.tar.xz>,
  SHA-256 `143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63`
- Official SPDX document: <https://www.python.org/ftp/python/3.14.6/Python-3.14.6.tar.xz.spdx.json>,
  SHA-256 `1f5d394856783fa77e1f1db280f84eabf693bffc1fb06a747f7116de9f99f3bd`
- Expanded WebC SHA-256:
  `67ffc49c3df1c874ff8407bc7972b3ae951b0ba564687e9eb1ea2cb82f77cf86`
- Distributed gzip SHA-256:
  `f8ada27da0b9bbe8a4e06736f320d71f6aca33876e8a0fd8894c5733972ba3c5`
- Provenance manifest SHA-256:
  `ab6d91af39227ed8b0655b56f0b8340d67864d6397fa933df76e1b24a9134161`
- Deterministically exported `FORGEFS1` runtime archive SHA-256:
  `8aeae854650b5cc5af015dcfacb79f974d5a6997110c98b083cf4d618e20e4ba`
- CPython license: Python Software Foundation License Version 2 and the
  historical notices reproduced with it
- License text: `licenses/cpython-3.14.6-PSF-2.0.txt`
- Bundled third-party source: Expat 2.8.1 (MIT), HACL* revision
  `8ba599b2f6c9701b3dc961db895b0856a2210f76` (MIT), and libmpdec 2.5.1
  (BSD-2-Clause); their exact notices are
  `licenses/cpython-expat-2.8.1-MIT.txt`,
  `licenses/cpython-hacl-star-8ba599b-MIT.txt`, and
  `licenses/cpython-libmpdec-2.5.1-BSD-2-Clause.txt`.
- Build toolchain: WASI SDK 24.0 revision
  `d2bea01edcc46f731156a817f710cdd9fc9c1c19`, LLVM revision
  `26a1d6601d727a96f4301d0d8647b5a42760ae0c`, and wasi-libc revision
  `b9ef79d7dbd47c6c5bafdae760823467c2f60b70`.

Forge compiles this package from the pinned official sources, disables
`_socket`, removes test/development-only standard-library roots, canonicalizes
build-only sysconfig paths, and packages the complete source SPDX document and
applicable CPython, third-party, compiler-rt, WASI SDK, and wasi-libc notices
inside the WebC. The build does not consume or redistribute the retired Wasmer
Registry CPython/WASIX package, and Forge's MIT license does not apply to these
third-party contents.

## Forge runtime-core dependency closure

The browser runner embeds `wasm-oj-forge-runtime-core` and its locked normal
dependency graph for the `wasm32-unknown-unknown` target with the `web` feature.
The complete generated license report, including the selected license text for
every dependency, is `licenses/runtime-core-dependencies.html`. Its compact,
machine-verifiable package inventory and report digest are recorded in
`licenses/runtime-core-dependencies.json`. Both files are generated with pinned
`cargo-about` 0.9.1 and are verified against `crates/runtime-core/Cargo.lock`.

## Vendored Rust crates

Forge's source tree also contains patched source copies used to build the
runtime and packaging tools:

- `vendor/shared-buffer`: MIT OR Apache-2.0; see
  `vendor/shared-buffer/LICENSE_MIT.md` and
  `vendor/shared-buffer/LICENSE_APACHE.md`.
- `vendor/virtual-fs`: MIT; see `vendor/virtual-fs/LICENSE`.

These vendored sources are build inputs and are not included in the npm package
allowlist.
