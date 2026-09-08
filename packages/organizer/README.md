# `@wasm-oj/organizer`

Schemas and repository validation utilities for problem collections, contest projections, and immutable
judge packages. The Organizer boundary validates schema, paths, size, digest, and deployability; it
does not compile, run, score, or assess a reference solution.

Contest output uses only `wasm-oj-platform/contests/v2`. Authoring presets are expanded into
canonical typed rules before synchronization; contest v1 and unknown properties are rejected.

## Upgrading from 0.2.0

Managed collection parsers have been removed. Use `parseRepositoryRoot`,
`parseRepositoryProblems`, `parseRepositoryContests`, and `validateRepositoryCatalog` for the
repository-authored catalog. `wasm-oj.json` and its exact Git commit define catalog content.
