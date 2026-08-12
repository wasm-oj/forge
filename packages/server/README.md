# `@wasm-oj/server`

Node.js filesystem, child-process, compiler, and runner adapters for WASM-OJ. Toolchain packages
must be installed and passed to `createServerEngine`; missing or invalid assets fail closed.

Build the packaged native executables with `pnpm run runtime:build-native` from this package.
