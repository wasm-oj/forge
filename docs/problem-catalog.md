# Problem catalog

Forge carries the complete 40-problem systems track at the repository root.
`catalog.json` is the only discovery entry point; consumers must follow each
manifest path and then resolve every declared content path relative to that
manifest. Directory listing and filename guessing are not part of the contract.

The catalog uses `wasm-oj-catalog-v2` and names `wasm-oj-problem-v3`. Its
localization block declares `zh-TW` as the default and the ordered locale set
`["zh-TW", "en"]`. Every problem provides both locales for its title,
statement, editorial, scoring-policy titles, and complexity-path names. Missing
locales fail validation; consumers must not silently substitute another locale.

The browser does not maintain a second handwritten problem list.
`scripts/generate-judge-problems.mjs` resolves the catalog, reads the explicitly
declared localized documents and test pairs, validates the manifest identities,
and writes `src/judge/problems.generated.ts`. The generated file is committed so
the browser bundle has no runtime filesystem dependency. `pnpm problems:verify`
reconstructs it byte-for-byte and fails when it is stale.

Instruction policies are evidence-derived. For each language, Forge first takes
the maximum net weighted cost over the complete manifest case set. The optimal
tier averages the C, C++, Rust, and Go maxima and adds 5%; the efficient tier
uses the maximum of those four plus 5%; and the baseline tier uses the maximum
of all seven reference languages plus 5%. Every result is rounded upward by the
documented decimal quantum. `pnpm problems:verify` recomputes this derivation
from the content-bound calibration evidence before accepting the catalog.

Every judge case is executed once under the first, broadest resource policy.
After output matching, Forge evaluates the same normalized cost, peak linear
memory, and optional logical-time metrics against every cumulative policy. The
incremental policy points are summed per case and averaged over the complete
manifest case set. Artifact language and exact cost-profile identity must match
the manifest calibration before judging begins.

Each completed case retains its exact net, raw, and baseline instruction cost,
peak linear memory, optional logical time, and the result of every individual
policy check. The result panel exposes those values, the remaining distance to
the next cumulative policy, a logarithmic instruction-cost threshold axis, and
a linear memory threshold axis.

The original handwritten 20-problem catalog and its single fixed instruction
budget were removed. There is no compatibility reader or fallback fixture path.
