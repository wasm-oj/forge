# WASM-OJ versioning policy

WASM-OJ has one active compatibility number:

```ts
WASM_OJ_CONTRACT_VERSION = 2
WASM_OJ_CONTRACT_ID = "wasm-oj-v2"
```

The contract jointly covers compiler and runner requests, artifacts, deterministic inputs,
resource enforcement and metering, cost normalization, `JudgeSpec`, dependency locks, replay,
toolchain descriptors, Worker/native wire schemas, caches, and conformance snapshots. Production
code must not create independent compiler, determinism, meter, resource, cost, or judge contract
counters.

An incompatible change increments `WASM_OJ_CONTRACT_VERSION` once and updates all affected schema,
binary, storage, cache, cost-profile, and evidence identities atomically. A new contract begins
with new browser databases/caches and new browser/server conformance evidence. Older contracts are
rejected; WASM-OJ does not silently migrate or probe legacy wire formats.

Other versions remain deliberately independent:

- `@wasm-oj/contracts`, `@wasm-oj/core`, `@wasm-oj/browser`, `@wasm-oj/server`,
  `@wasm-oj/organizer`, and `@wasm-oj/sdk` use one synchronized SDK SemVer. Compatible releases
  may implement the same WASM-OJ contract.
- The five `@wasm-oj/toolchain-*` packages release independently. Their descriptor declares the
  supported WASM-OJ contract and exact content identity.
- Upstream compiler/runtime versions and packaging revisions participate in artifact/cache/cost
  identity without creating another protocol compatibility number.

Pre-reset protocols and runners are removed rather than carried as compatibility paths. Historical
reports may describe earlier experiments, but active core protocol and storage identities are
scoped to `wasm-oj-v2`. Product-specific authoring/publication schemas retain their own explicit
WASM-OJ names and versions, such as `wasm-oj-platform/managed-collection/v2` and
`wasm-oj-browser-collection-v5`; they do not create alternate compiler/runtime contracts.

The canonical TypeScript declaration is `src/core/contract.ts`; the native runtime mirrors it in
`crates/runtime-core/src/contract.rs`. `scripts/verify-contract.mjs` and cross-host conformance
tests prevent drift.
