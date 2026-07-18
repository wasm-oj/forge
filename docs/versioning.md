# Forge versioning policy

Forge has one compatibility number:

```ts
FORGE_CONTRACT_VERSION = 1
FORGE_CONTRACT_ID = "wasm-oj-forge-v1"
```

The contract jointly covers compiler and runner behavior, deterministic inputs,
resource enforcement and metering, artifact and runtime-bundle identity, cost
normalization, `JudgeSpec`, Worker/native wire schemas, caches, and conformance
snapshots. Production code must not create independent compiler, determinism,
meter, resource, cost, or judge contract counters.

An incompatible change increments `FORGE_CONTRACT_VERSION` once and updates all
schema/storage identities atomically. A new contract starts with a new browser
database and caches, new cost calibration, and new browser/server conformance
evidence. Forge does not silently migrate or accept an older contract.

Two other kinds of identifiers are deliberately separate:

- The npm and Rust crate SemVer values describe library releases. Multiple
  compatible releases may implement the same Forge contract.
- Compiler/runtime versions and packaging revisions identify exact upstream
  content and reproducible assets. They participate in artifact cache keys but
  do not create another compatibility contract.

Pre-reset experimental protocols and their runners are removed rather than
carried as compatibility paths. Current evidence is scoped directly to the
single Forge contract that produced it.

The canonical TypeScript declaration is `src/core/contract.ts`; the native
runtime mirrors the shared number and native wire schemas in
`crates/runtime-core/src/contract.rs`. Cross-host conformance tests prevent the
two implementations from drifting.
