#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_ABOUT="${CARGO_ABOUT:-cargo-about}"
EXPECTED_VERSION="cargo-about 0.9.1"

if ! command -v "$CARGO_ABOUT" >/dev/null 2>&1; then
  echo "cargo-about 0.9.1 is required. Install it with:" >&2
  echo "cargo install --locked cargo-about --version 0.9.1 --features cli" >&2
  exit 1
fi
CURRENT_VERSION="$("$CARGO_ABOUT" --version)"
if [[ "$CURRENT_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "Expected '$EXPECTED_VERSION', received '$CURRENT_VERSION'." >&2
  exit 1
fi

COMMON=(
  generate
  --config "$ROOT/crates/runtime-core/about.toml"
  --manifest-path "$ROOT/crates/runtime-core/Cargo.toml"
  --locked
  --offline
  --target wasm32-unknown-unknown
  --no-default-features
  --features web
  --fail
)

cargo fetch \
  --locked \
  --manifest-path "$ROOT/crates/runtime-core/Cargo.toml"

STAGED_HTML="$(mktemp "${TMPDIR:-/tmp}/forge-runtime-licenses.XXXXXX.html")"
RAW_JSON="$(mktemp "${TMPDIR:-/tmp}/forge-runtime-licenses.XXXXXX.raw.json")"
trap 'rm -f "$STAGED_HTML" "$RAW_JSON"' EXIT

"$CARGO_ABOUT" "${COMMON[@]}" \
  --output-file "$STAGED_HTML" \
  "$ROOT/scripts/runtime-licenses.hbs"
"$CARGO_ABOUT" "${COMMON[@]}" \
  --format json \
  --output-file "$RAW_JSON"
node "$ROOT/scripts/compact-runtime-license-report.mjs" \
  "$RAW_JSON" \
  "$STAGED_HTML" \
  "$ROOT/licenses/runtime-core-dependencies.html" \
  "$ROOT/licenses/runtime-core-dependencies.json"
