#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/localwasi-toolchains.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

TYPESCRIPT_VERSION="7.0.2"
TYPESCRIPT_COMMIT="2bd066d87f5bafd315be9f40889d0a60b9e58e0b"
QUICKJS_VERSION="0.15.1"

[[ "$(go version | awk '{print $3}')" == "go1.26.3" ]] || {
  echo "TypeScript/WASI must be built with Go 1.26.3." >&2
  exit 1
}
[[ "$(zig version)" == "0.16.0" ]] || {
  echo "QuickJS-ng/WASI must be built with Zig 0.16.0." >&2
  exit 1
}

TYPESCRIPT_SOURCE="$WORK/typescript-go"
git -C "$WORK" init -q typescript-go
git -C "$TYPESCRIPT_SOURCE" remote add origin https://github.com/microsoft/typescript-go.git
git -C "$TYPESCRIPT_SOURCE" fetch -q --depth=1 origin "$TYPESCRIPT_COMMIT"
git -C "$TYPESCRIPT_SOURCE" checkout -q --detach FETCH_HEAD
mkdir -p "$TYPESCRIPT_SOURCE/cmd/localwasi"
cp "$ROOT/toolchains/typescript-wasi/main.go" "$TYPESCRIPT_SOURCE/cmd/localwasi/main.go"
gofmt -w "$TYPESCRIPT_SOURCE/cmd/localwasi/main.go"
(
  cd "$TYPESCRIPT_SOURCE"
  GOOS=wasip1 GOARCH=wasm go build \
    -trimpath \
    -gcflags=all=-l \
    -ldflags='-s -w -buildid=' \
    -o "$WORK/typescript.wasm" \
    ./cmd/localwasi
)
gzip -n -9 -c "$WORK/typescript.wasm" > "$ROOT/public/toolchains/typescript-$TYPESCRIPT_VERSION.wasm.gz"

QUICKJS_SOURCE="$WORK/quickjs-ng"
git clone -q --depth=1 --branch "v$QUICKJS_VERSION" https://github.com/quickjs-ng/quickjs.git "$QUICKJS_SOURCE"
zig cc \
  -target wasm32-wasi \
  -O3 \
  -D_GNU_SOURCE \
  -D_WASI_EMULATED_SIGNAL \
  "-DCONFIG_VERSION=\"$QUICKJS_VERSION\"" \
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
gzip -n -9 -c "$WORK/quickjs.wasm" > "$ROOT/public/toolchains/quickjs-$QUICKJS_VERSION.wasm.gz"

if command -v sha256sum >/dev/null; then
  sha256sum "$ROOT/public/toolchains/typescript-$TYPESCRIPT_VERSION.wasm.gz" "$ROOT/public/toolchains/quickjs-$QUICKJS_VERSION.wasm.gz"
else
  shasum -a 256 "$ROOT/public/toolchains/typescript-$TYPESCRIPT_VERSION.wasm.gz" "$ROOT/public/toolchains/quickjs-$QUICKJS_VERSION.wasm.gz"
fi
