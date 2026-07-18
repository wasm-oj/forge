#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/crates/runtime-core/Cargo.toml"
TARGET="$ROOT/crates/runtime-core/target/wasm32-unknown-unknown/release/wasm_oj_forge_runtime_core.wasm"
OUTPUT="$ROOT/src/runner/generated"
STAGED="$(mktemp -d "$ROOT/src/runner/.runtime-core.XXXXXX")"
BACKUP="$ROOT/src/runner/.runtime-core.backup.$$"

cleanup() {
  rm -rf "$STAGED" "$BACKUP"
}
trap cleanup EXIT

if [[ "$(wasm-bindgen --version)" != "wasm-bindgen 0.2.126" ]]; then
  echo "wasm-bindgen-cli 0.2.126 is required" >&2
  exit 1
fi

cargo build --locked --manifest-path "$CRATE" --release --target wasm32-unknown-unknown --no-default-features --features web
wasm-bindgen --target web --out-dir "$STAGED" --out-name runtime-core "$TARGET"

if [[ -e "$OUTPUT" ]]; then
  mv "$OUTPUT" "$BACKUP"
fi
if ! mv "$STAGED" "$OUTPUT"; then
  if [[ -e "$BACKUP" ]]; then
    mv "$BACKUP" "$OUTPUT"
  fi
  exit 1
fi
rm -rf "$BACKUP"
