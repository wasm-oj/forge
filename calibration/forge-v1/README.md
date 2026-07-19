# Forge v1 instruction-cost calibration

This directory is the audit trail for every `instructionBudget` in the catalog.

The catalog binding was refreshed when the repository moved from the
single-title catalog to localized `wasm-oj-catalog-v2` / `wasm-oj-problem-v3`.
That migration changed only titles and statement/editorial paths. Every measured
solution SHA-256, test input/output SHA-256, Forge content identity, and recorded
cost remains unchanged; the derivation tool rechecks all of those byte-level
measurement inputs before accepting the refreshed catalog hash.

- `reference-costs.json` contains 280 records (40 problems × 7 languages) and
  1,141 case executions. Every record binds the source, input, expected output,
  artifact profile, compiler, runner, generated Forge library, toolchains, Node
  runtime, and the two external JavaScript dependency trees by SHA-256.
- `derived-policies.json` is a deterministic projection of that evidence. It
  records every language's worst stored-case cost, the minimum-cost witness, and
  the three resulting budgets.

The isolated measurement checkout reports `?? node_modules` because its
dependency directory was a local symlink into the pinned Forge installation.
This path was not an engine input by name: the exact `@wasmer/sdk` and `fflate`
trees reached through the symlink are content-bound in `forge.dependencyTreeSha256`.
The Forge source commit, compiler/runner binaries, generated library, and
toolchains are independently bound as well.

## Reproduce or refresh

Build Forge, then run the calibration against an absolute Forge checkout path:

```bash
node tools/calibrate_costs.mjs --forge /absolute/path/to/forge
node tools/derive_cost_policies.mjs --write
```

The measurement command refuses to overwrite existing evidence. Use `--resume`
only with the same catalog and exact runtime identity. `--problem` and
`--language` can narrow an interrupted run; a production derivation still
requires all 280 records.

After changing a reference implementation, replace its stale records explicitly:

```bash
node tools/calibrate_costs.mjs --forge /absolute/path/to/forge \
  --problem 11 --resume --replace
```

`--replace` requires at least one problem selection and removes only the selected
problem/language records before remeasuring them.

Normal validation is read-only and fails closed if a solution, stored case,
evidence file, derivation, or manifest budget is stale:

```bash
node tools/derive_cost_policies.mjs
```

For problem `p`, language `l`, and stored case `c`, the method is:

```text
languageWorst[p,l] = max(cost[p,l,c])
ordered[p]         = sort ascending(languageWorst[p,*])
rawOptimal[p]      = ceil(ordered[p][1] × 105 / 100)
rawEfficient[p]    = ceil(ordered[p][2] × 105 / 100)
rawBaseline[p]     = ceil(ordered[p][7] × 105 / 100)
quantum(x)         = 5 × 10^(decimalDigits(x) - 2)  when decimalDigits(x) >= 3
quantum(x)         = 1                               otherwise
budget(x)          = ceil(x / quantum(x)) × quantum(x)
optimal[p]         = budget(rawOptimal[p])
efficient[p]       = budget(rawEfficient[p])
baseline[p]        = budget(rawBaseline[p])
```

All costs are Forge `wasm-oj-forge-v1` baseline-normalized net weighted costs.
The strict tier is always based on the lowest-cost language; the broader ranks
keep all seven supported reference languages eligible for partial credit. The
fixed 5% headroom is followed only by safe upward decimal rounding: from three
digits onward, a budget is rounded up to a multiple of `5 × 10^(digits - 2)`.
For example, `28,995` becomes `30,000` and `10,170,535` becomes `15,000,000`.
The rounding never lowers the unrounded bound. Wall time is not part of the
derivation.
