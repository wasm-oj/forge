#!/usr/bin/env bash
set -euo pipefail
umask 022

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/forge-toolchains.XXXXXX")"
cleanup() {
  rm -rf "$WORK"
  if [[ -n "${TYPESCRIPT_STAGED:-}" ]]; then rm -f "$TYPESCRIPT_STAGED"; fi
  if [[ -n "${QUICKJS_STAGED:-}" ]]; then rm -f "$QUICKJS_STAGED"; fi
}
trap cleanup EXIT

TYPESCRIPT_VERSION="7.0.2"
TYPESCRIPT_COMMIT="2bd066d87f5bafd315be9f40889d0a60b9e58e0b"
TYPESCRIPT_SHA256="287c1a1e48179014821b8acbaa78000c17df4d072cab2cb9e8d7477cd55878f7"
QUICKJS_UPSTREAM_VERSION="0.15.1"
QUICKJS_COMMIT="fd0a0210b7be00957751871e7e01b8291268fc29"
QUICKJS_SOURCE_DATE_EPOCH="1780584979"
QUICKJS_VERSION="$QUICKJS_UPSTREAM_VERSION"
QUICKJS_WASM_SHA256="21fcf23a5fdf3e64b803344c9af86be01e95feabf4779d02aef325c852bc2c2e"
QUICKJS_SHA256="5b1419b8d65d2b910b61954071e28d99ce1fd401b5dd9b47e2bf16552f9ff582"
WASI_SDK_VERSION="24.0"
WASI_SDK_REVISION="d2bea01edcc46f731156a817f710cdd9fc9c1c19"
WASI_SDK_LLVM_REVISION="26a1d6601d727a96f4301d0d8647b5a42760ae0c"
WASI_SDK_WASI_LIBC_REVISION="b9ef79d7dbd47c6c5bafdae760823467c2f60b70"
WASI_SDK_ARCHIVE_SHA256="aeae999396d5f5caa5ce419f52e83c35869d5fd21d40af80acba2c80f51b0b3a"
WASI_SDK_CLANG_SHA256="8a575e20ad21e3c4f0027d172acc6b65655455a809d1fa074701857aa461b94f"
WASI_SDK_LLD_SHA256="0de6e4b0f3afa9ac3ed9355ded1f543f7c233763f5f8c4f1cf73543672888116"
WASI_SDK_LLVM_OBJCOPY_SHA256="a2c3a57601c1c01ed01ef0d598daee6490aedee85817628e8d2cfed79bddbcf4"
WASI_SDK_CRT1_SHA256="70ab781288ab357ea925888f7ddbd67593a0932f2a02ef402be2b1a2f2b7ca5a"
WASI_SDK_LIBC_SHA256="2757f3632939c6d87e5cd17181344759832cbb9c49284bc16965e7c9ed5f4e3b"
WASI_SDK_LIBM_SHA256="6d44d508e943a0c58bee925afa4e26abfe83f0c1ce8abf397bdd858c9cdb3439"
WASI_SDK_SIGNAL_SHA256="799adc0ff263a94060036d30304862a4655041f3f6ecd2eab45da24fc2780eae"
WASI_SDK_COMPILER_RT_SHA256="5a4d4ed583fa0a19f50ff87d336064fb097193ed5314ecdaa119379614436956"
TYPESCRIPT_OUTPUT="$ROOT/public/toolchains/typescript-$TYPESCRIPT_VERSION.wasm.gz.bin"
TYPESCRIPT_STAGED="$(mktemp "$TYPESCRIPT_OUTPUT.XXXXXX")"
QUICKJS_OUTPUT="$ROOT/public/toolchains/quickjs-$QUICKJS_VERSION.wasm.gz.bin"
QUICKJS_STAGED="$(mktemp "$QUICKJS_OUTPUT.XXXXXX")"

verify_digest() {
  local expected="$1"
  local file="$2"
  local actual
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "Toolchain digest mismatch for $file: expected $expected, received $actual" >&2
    exit 1
  fi
  echo "$actual  $file"
}

if [[ "$#" -ne 1 || "$1" != /* ]]; then
  echo "Usage: $0 /absolute/path/to/wasi-sdk-$WASI_SDK_VERSION-arm64-macos.tar.gz" >&2
  exit 1
fi
WASI_SDK_ARCHIVE="$1"
[[ -f "$WASI_SDK_ARCHIVE" ]] || {
  echo "The pinned WASI SDK archive does not exist: $WASI_SDK_ARCHIVE" >&2
  exit 1
}
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || {
  echo "The pinned WASI SDK $WASI_SDK_VERSION archive requires an arm64 macOS build host." >&2
  exit 1
}
verify_digest "$WASI_SDK_ARCHIVE_SHA256" "$WASI_SDK_ARCHIVE"

[[ "$(go version | awk '{print $3}')" == "go1.26.3" ]] || {
  echo "TypeScript/WASI must be built with Go 1.26.3." >&2
  exit 1
}

mkdir -p "$WORK/wasi-sdk"
tar -xf "$WASI_SDK_ARCHIVE" -C "$WORK/wasi-sdk"
WASI_SDK="$WORK/wasi-sdk/wasi-sdk-$WASI_SDK_VERSION-arm64-macos"
WASI_SYSROOT="$WASI_SDK/share/wasi-sysroot/lib/wasm32-wasip1"
WASI_CLANG="$WASI_SDK/bin/wasm32-wasip1-clang"
WASI_STRIP="$WASI_SDK/bin/llvm-strip"
[[ -x "$WASI_CLANG" && -x "$WASI_STRIP" ]] || {
  echo "The pinned WASI SDK archive has an unexpected executable layout." >&2
  exit 1
}
EXPECTED_CLANG_VERSION="clang version 18.1.2-wasi-sdk (https://github.com/llvm/llvm-project $WASI_SDK_LLVM_REVISION)"
[[ "$("$WASI_CLANG" --version | sed -n '1p')" == "$EXPECTED_CLANG_VERSION" ]] || {
  echo "The pinned WASI SDK archive exposes an unexpected Clang revision." >&2
  exit 1
}
[[ "$("$WASI_CLANG" --version | sed -n '2p')" == "Target: wasm32-unknown-wasip1" ]] || {
  echo "The pinned WASI SDK compiler does not target wasm32-unknown-wasip1." >&2
  exit 1
}
verify_digest "$WASI_SDK_CLANG_SHA256" "$WASI_SDK/bin/clang-18"
verify_digest "$WASI_SDK_LLD_SHA256" "$WASI_SDK/bin/lld"
verify_digest "$WASI_SDK_LLVM_OBJCOPY_SHA256" "$WASI_SDK/bin/llvm-objcopy"
verify_digest "$WASI_SDK_CRT1_SHA256" "$WASI_SYSROOT/crt1-command.o"
verify_digest "$WASI_SDK_LIBC_SHA256" "$WASI_SYSROOT/libc.a"
verify_digest "$WASI_SDK_LIBM_SHA256" "$WASI_SYSROOT/libm.a"
verify_digest "$WASI_SDK_SIGNAL_SHA256" "$WASI_SYSROOT/libwasi-emulated-signal.a"
verify_digest "$WASI_SDK_COMPILER_RT_SHA256" \
  "$WASI_SDK/lib/clang/18/lib/wasip1/libclang_rt.builtins-wasm32.a"

TYPESCRIPT_SOURCE="$WORK/typescript-go"
git -C "$WORK" init -q typescript-go
git -C "$TYPESCRIPT_SOURCE" remote add origin https://github.com/microsoft/typescript-go.git
git -C "$TYPESCRIPT_SOURCE" fetch -q --depth=1 origin "$TYPESCRIPT_COMMIT"
git -C "$TYPESCRIPT_SOURCE" checkout -q --detach FETCH_HEAD
[[ "$(git -C "$TYPESCRIPT_SOURCE" rev-parse HEAD)" == "$TYPESCRIPT_COMMIT" ]] || {
  echo "TypeScript-Go checkout does not match the pinned commit." >&2
  exit 1
}
mkdir -p "$TYPESCRIPT_SOURCE/cmd/forge"
cp "$ROOT/toolchains/typescript-wasi/main.go" "$TYPESCRIPT_SOURCE/cmd/forge/main.go"
gofmt -w "$TYPESCRIPT_SOURCE/cmd/forge/main.go"
(
  cd "$TYPESCRIPT_SOURCE"
  GOOS=wasip1 GOARCH=wasm go build \
    -trimpath \
    -gcflags=all=-l \
    -ldflags='-s -w -buildid=' \
    -o "$WORK/typescript.wasm" \
    ./cmd/forge
)
gzip -n -9 -c "$WORK/typescript.wasm" > "$TYPESCRIPT_STAGED"

QUICKJS_SOURCE="$WORK/quickjs-ng"
git -C "$WORK" init -q quickjs-ng
git -C "$QUICKJS_SOURCE" remote add origin https://github.com/quickjs-ng/quickjs.git
git -C "$QUICKJS_SOURCE" fetch -q --depth=1 origin "$QUICKJS_COMMIT"
git -C "$QUICKJS_SOURCE" checkout -q --detach FETCH_HEAD
[[ "$(git -C "$QUICKJS_SOURCE" rev-parse HEAD)" == "$QUICKJS_COMMIT" ]] || {
  echo "QuickJS-ng checkout does not match the pinned commit." >&2
  exit 1
}
SOURCE_DATE_EPOCH="$QUICKJS_SOURCE_DATE_EPOCH" "$WASI_CLANG" \
  -O3 \
  -D_GNU_SOURCE \
  -D_WASI_EMULATED_SIGNAL \
  "-DCONFIG_VERSION=\"$QUICKJS_UPSTREAM_VERSION\"" \
  "-ffile-prefix-map=$ROOT=/wasm-oj-forge" \
  "-fdebug-prefix-map=$ROOT=/wasm-oj-forge" \
  "-fmacro-prefix-map=$ROOT=/wasm-oj-forge" \
  "-ffile-prefix-map=$QUICKJS_SOURCE=/quickjs-ng" \
  "-fdebug-prefix-map=$QUICKJS_SOURCE=/quickjs-ng" \
  "-fmacro-prefix-map=$QUICKJS_SOURCE=/quickjs-ng" \
  -I"$QUICKJS_SOURCE" \
  "$ROOT/toolchains/quickjs-wasi/main.c" \
  "$QUICKJS_SOURCE/quickjs.c" \
  "$QUICKJS_SOURCE/dtoa.c" \
  "$QUICKJS_SOURCE/libregexp.c" \
  "$QUICKJS_SOURCE/libunicode.c" \
  "$QUICKJS_SOURCE/quickjs-libc.c" \
  -lm \
  -lwasi-emulated-signal \
  -o "$WORK/quickjs.wasm"
"$WASI_STRIP" --strip-debug "$WORK/quickjs.wasm"
verify_digest "$QUICKJS_WASM_SHA256" "$WORK/quickjs.wasm"
gzip -n -9 -c "$WORK/quickjs.wasm" > "$QUICKJS_STAGED"

verify_digest "$TYPESCRIPT_SHA256" "$TYPESCRIPT_STAGED"
verify_digest "$QUICKJS_SHA256" "$QUICKJS_STAGED"
chmod 0644 "$TYPESCRIPT_STAGED" "$QUICKJS_STAGED"
mv -f "$TYPESCRIPT_STAGED" "$TYPESCRIPT_OUTPUT"
mv -f "$QUICKJS_STAGED" "$QUICKJS_OUTPUT"
echo "Published $TYPESCRIPT_OUTPUT"
echo "Published $QUICKJS_OUTPUT"
echo "QuickJS runtime provenance: wasi-sdk@$WASI_SDK_REVISION, llvm-project@$WASI_SDK_LLVM_REVISION, wasi-libc@$WASI_SDK_WASI_LIBC_REVISION"
