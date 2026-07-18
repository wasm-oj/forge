# Changelog

All notable changes to WASM OJ Forge are recorded here. Releases follow
[Semantic Versioning](https://semver.org/); the package version is independent
from the `wasm-oj-forge-v1` execution contract described in
[the versioning policy](docs/versioning.md).

## 0.1.0 - 2026-07-19

Initial experimental release of `@wasm-oj/forge`.

- Browser and server compiler hosts for C, C++, Rust, Go, Python, JavaScript,
  and TypeScript targeting `wasip1`, with the supported C/C++ `wasix` profile.
- Deterministic Wasmer runner with weighted metering, normalized startup cost,
  virtual clocks and randomness, memory/output/VFS quotas, and replay bundles.
- Multi-file judging, special checkers, interactive judging, dependency locks,
  content-addressed incremental compilation, and unified browser storage.
- Submission-scoped operations, stable errors and observations, browser runtime
  driver plug-ins, and one-line server initialization.
- Cross-host conformance evidence covering 21 language, target, filesystem,
  capability, and deterministic-time cases.
