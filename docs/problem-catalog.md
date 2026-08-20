# Problem collection loading

WASM-OJ's default problem collection is the public
[`wasm-oj/problems`](https://github.com/wasm-oj/problems) repository. The browser never lists
repository directories or guesses statement, editorial, solution, or test paths.

The repository contract is intentionally open. A compatible public GitHub repository can be
loaded anonymously from Judge settings or shared with a credential-free URL. Forks are isolated
by the normalized repository source key and each problem bundle digest, so drafts, verified cache
entries, and local solved progress cannot cross-contaminate revisions.

## Authoring CLI and GitHub Action

The package publishes one validator used by repository authors and the browser parser:

```sh
pnpm exec woj organizer collection build .
pnpm exec woj organizer collection verify .
```

`build` reads `collection/source.json`, emits canonical content-addressed bundles and
`collection/index.json`, and recomputes the collection revision. `verify` requires canonical JSON,
checks the published schema and integrity, and rejects undeclared content-addressed bundles. Paths
change only through explicit `--source` and `--index` options; WASM-OJ never guesses alternate
locations. The distinct remote command `woj organizer collection validate <collection-id> --ref
<ref>` resolves the ref once and validates that exact commit on the platform.

Repositories can use `.github/actions/woj/action.yml`, pinned to the exact
`@wasm-oj/cli@0.2.0` release.
A collection intended for managed import supplies a separate author-only descriptor and builds the
published contract and packages explicitly:

```sh
pnpm exec woj organizer collection build . \
  --managed-source collection/managed-source.json \
  --managed collection/managed.json
pnpm exec woj organizer collection verify . --managed collection/managed.json
```

`collection/managed-source.json` is unnecessary for browser-only practice. Its schema is
`wasm-oj-platform/managed-collection-source/v1`; it binds each problem slug to allowed compile
profiles and either the built-in text judge or an already compiled standalone checker/interactor.
The Organizer never accepts source code for that trusted command and never invokes a compiler.

```json
{
  "schema": "wasm-oj-platform/managed-collection-source/v1",
  "problems": [{
    "slug": "sum-two",
    "allowedProfiles": {
      "c": { "target": "wasip1", "optimization": "release" }
    },
    "judge": { "kind": "text" }
  }]
}
```

A custom checker replaces `judge` with a digest-pinned standalone Wasm artifact and optional data
assets:

```json
{
  "kind": "checker",
  "artifact": {
    "path": "judges/sum-two/checker.wasm",
    "bytes": 12345,
    "sha256": "<lowercase SHA-256>",
    "runtimeProfile": "c-wasip1-release"
  },
  "assets": [{
    "path": "judges/sum-two/policy.dat",
    "guestPath": "/checker/assets/policy.dat",
    "bytes": 32,
    "sha256": "<lowercase SHA-256>"
  }],
  "args": ["/checker/assets/policy.dat"]
}
```

The checker always receives input, expected output, contestant stdout, and contestant stderr as
its first four fixed file arguments; declared `args` follow. Checker assets must live below
`/checker/assets/`. An interactive judge uses the same artifact shape, assets below
`/interactor/assets/`, plus an `inputPath` below `/interactor/input/`. Each asset and the combined
asset set are limited to 4 MiB; trusted Wasm is limited to 8 MiB. The parser admits only the four
declared release runtime profiles, validates the exact WASI Preview 1 import/signature surface,
rejects reserved exports and impossible memory, and caps the complete `WOJJDG02` package at 32 MiB.
It does not execute, score, benchmark, or assess the correctness of any trusted command or
reference solution.

`build` derives the public practice bundle and hidden judge data separately from the validated
authoring bundle. It derives the contest-public projection from the practice bundle, then requires
the private judge data to preserve the practice bundle's scoring/resources and every exact public
sample. After validating each declared byte length and digest, it emits content-addressed
`.contest.json` and `.wasmojjudge` files and writes
`wasm-oj-platform/managed-collection/v2` to `collection/managed.json`. That published contract
contains only each slug, its allowed profiles, and byte-length/SHA-256 references to the two
generated objects. `verify --managed` reconstructs and validates those relationships without
compiling or running guest code. Official Submit is the separate execution boundary.

## Source configuration

The user-selectable source has exactly four GitHub fields:

```json
{
  "owner": "wasm-oj",
  "repository": "problems",
  "ref": "main",
  "indexPath": "collection/index.json"
}
```

WASM-OJ validates every value before constructing a `raw.githubusercontent.com` URL. Repository
paths must be normalized relative POSIX paths and cannot contain absolute paths, empty segments,
backslashes, `.` or `..`. Settings are scoped to the current browser. Project drafts and solved
progress combine the normalized source key with each problem bundle digest. Unchanged problems
keep their state across index updates; a changed problem is isolated automatically even when its
slug stays the same.

## Lazy loading and integrity

The `wasm-oj-browser-collection-v5` index is capped at 512 KiB and contains localized list and
learning-track metadata, explicit repository-root-relative statement paths for both locales, and
one bundle descriptor per problem. WASM-OJ renders the challenge list after loading
the index and initially downloads only the first problem. Selecting another problem fetches its
`wasm-oj-browser-problem-v4` bundle on demand.

Problem bundle v4 requires a `starterTemplates` object with exactly the seven built-in language
keys (`c`, `cpp`, `rust`, `go`, `python`, `javascript`, and `typescript`). Each language declares
exactly one normalized relative `entry` path and a `files` map containing that entry. A language
template may contain at most 128 files, each file at most 256 KiB of UTF-8 source, and at most
1 MiB in total. Paths are trimmed normalized relative POSIX paths of at most 4,096 characters;
absolute paths, empty segments, `.`, `..`, backslashes, NULs, and trailing slashes are rejected.
The entry file must be non-empty. All source text must be valid Unicode without an unpaired
surrogate.

These source strings are part of the integrity-addressed bundle. `woj organizer collection build` and the
browser use the same exact parser, so an external author must provide every language template and
cannot rely on WASM-OJ to synthesize a missing file. Creating a draft copies the declared file map
byte-for-byte, sorts paths deterministically, and selects the declared entry. The local 45-problem
development fixture generates its generic templates only while building the fixture; no runtime
template fallback exists.

The learning-assistant button opens ChatGPT in one click with a compact query. It links to the
active locale's public statement Markdown, which includes the samples, and keeps only the selected
language's declared starter entry file inline. WASM-OJ never guesses a statement path from a slug or bundle
name. This keeps the query URL bounded while preserving an explicit source for the full problem;
the default catalog is regression-tested so every locale and language combination stays below
2,048 URL characters.

The canonical repository keeps stable manifest IDs and paths for API
consumers. Its separate `learning-path.json` groups problems by topic and orders each group from
lower prerequisite load to more advanced techniques. The published browser index flattens that
path into contiguous display numbers and includes each stable track ID and localized track name. WASM-OJ groups the
catalog by those tracks and searches across display number, slug, both localized titles, both
localized track names, and tags.

Every descriptor declares the exact byte length and lowercase SHA-256 digest. WASM-OJ enforces a
32 MiB per-problem ceiling while streaming the response, verifies the digest over the original
bytes before UTF-8 decoding or JSON parsing, then validates:

- bundle/index identity, order, title, track ID, localized track, difficulty, tags, and case count;
- both supported locales for titles, statements, editorials, policy names, and complexities;
- all seven bounded starter source trees and their declared entry files;
- unique test identities and supported case kinds;
- exact language/profile mappings;
- the ordered baseline, efficient, and optimal cumulative policies;
- positive safe-integer resource limits and broad-to-strict monotonicity; and
- the accepted optimal complexity path.

Any HTTP, size, digest, UTF-8, JSON, schema, or identity failure is reported as a collection
configuration error. WASM-OJ does not silently switch repositories or use a bundled catalog.

## Cache behavior

Verified bundles are stored in the browser Cache API by SHA-256, not request URL or branch name.
Cached bytes are re-hashed before reuse, so unchanged problems survive index revisions safely.
The index is requested again on startup. If and only if the network itself is unavailable, WASM-OJ
may load the previously validated index for the exact same source key and labels it `verified
cache` in the interface. HTTP and validation failures never fall back to cached configuration.

The canonical source repository defines generation and publication of the split collection.
WASM-OJ keeps `src/judge/problems.generated.ts` solely as a typed test fixture regenerated from its
development mirror; no problem payload is emitted as a Sites static asset or included in the
server Worker.

## Scoring

Instruction policies remain evidence-derived. For each language, WASM-OJ takes the maximum net
weighted cost over the complete manifest case set. The optimal tier averages the C, C++, Rust,
and Go maxima and adds 5%; efficient uses the maximum of those four plus 5%; baseline uses the
maximum of all seven reference languages plus 5%. Results are rounded upward by the documented
decimal quantum.

Each judge case runs once under the broadest hard limits. WASM-OJ then evaluates the same normalized
cost, peak linear memory, and optional logical time against each cumulative policy. Artifact
language and exact cost-profile identity must match the problem configuration before judging begins.
