# `@wasm-oj/organizer`

Schemas and publication utilities for problem collections, contest projections, and immutable
judge packages. The Organizer boundary validates schema, paths, size, digest, and deployability; it
does not compile, run, score, or assess a reference solution.

Contest output uses only `wasm-oj-platform/contests/v2`. Authoring presets are expanded into
canonical typed rules before publication; repository v1 and unknown properties are rejected.
