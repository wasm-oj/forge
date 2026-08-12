# Changelog

All notable changes to WASM-OJ are recorded here. Releases follow
[Semantic Versioning](https://semver.org/) and the contract/package versioning policy in
[the versioning policy](docs/versioning.md).

## 0.2.0 - 2026-08-12

- Replaced the experimental contract with the breaking WASM-OJ contract 2 boundary.
- Split the public API into contracts, core, browser, server, organizer, SDK, and five
  independently versioned toolchain packages.
- Made browser and server toolchain sources explicit and digest-verified; removed implicit
  CDN, directory-search, and compatibility fallback paths.
- Reorganized UI code into reusable primitives and domain feature modules.
- Renamed product-facing APIs, schemas, protocols, binaries, storage identities, and
  operational configuration to WASM-OJ. The GitHub repository path remains unchanged.

## 0.1.0 - 2026-07-19

Initial experimental release of the retired monolithic package.

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
