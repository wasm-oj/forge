# Forge contract 1 cost baseline calibration

## Research question and contract

Can Forge publish an exact empty-program baseline for every supported language,
target, and optimization profile under the first formal `wasm-oj-forge-v1`
contract, including its shared virtual clock and logical-time resource policy?

Production semantics remain `net cost = max(0, raw cost - baseline)` and
`raw budget = baseline + requested net budget`. Only records produced directly
for contract 1 are admitted; pre-reset experimental records are not relabeled
or reused.

## Experimental unit and panel

One execution of a canonical empty artifact under one seed. The primary panel
covers every declared target and both `debug` and `release` for C, C++, Rust,
Go, Python, JavaScript, and TypeScript. Programs, stdin, arguments, environment,
and mounted inputs are empty.

- Metric: unadjusted `rawCostPoints` from the `weighted` model.
- Seeds: `0`, `1`, `42`, `1592594996`, `4294967295`.
- Required provenance: artifact digest and size, operations, transcript,
  toolchain identities, Forge contract, host, spec hash, and exact source-tree
  digest.

The default logical-time limit is part of every run request. Empty programs
must report deterministic `logicalTimeNs`; the value is transcript evidence but
does not alter the instruction baseline definition.

## Success and publication

Every profile must build and exit 0 with empty output. All five raw costs for a
profile must be identical. Missing, duplicate, malformed, trapped, timed-out,
or unequal results fail publication. Raw attempts are append-only.

The calibration runner supplies an explicit zero-baseline registry only for the
primary panel. Production remains fail-closed for unpublished profiles. The
deterministic transform verifies this spec, contract, source tree, full panel,
and all records before publishing the table, manifest, and generated runtime
module under this experiment directory.

```sh
npm run cost-baseline:calibrate
npm run cost-baseline:transform -- <raw-record.json>
npm run cost-baseline:calibrate
npm run cost-baseline:transform -- <fixed-point-raw-record.json>
```

Raw records live in `runs/raw/records/`; canonical outputs live in
`runs/tables/`. A future Forge contract requires a distinct calibration.
