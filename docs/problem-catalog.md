# Problem collection loading

Forge's default problem collection is the public
[`wasm-oj/problems`](https://github.com/wasm-oj/problems) repository. The browser never lists
repository directories or guesses statement, editorial, solution, or test paths.

The repository contract is intentionally open. A compatible public GitHub repository can be
loaded anonymously from Judge settings or shared with a credential-free URL. Forks are isolated
by the normalized repository source key and each problem bundle digest, so drafts, verified cache
entries, and local solved progress cannot cross-contaminate revisions.

## Authoring CLI and GitHub Action

The package publishes one validator used by repository authors and the browser parser:

```sh
forge-collection build .
forge-collection validate .
forge-collection verify .
```

`build` reads `collection/source.json`, emits canonical content-addressed bundles and
`collection/index.json`, and recomputes the collection revision. `validate` checks the published
schema and integrity. `verify` additionally requires canonical JSON and rejects undeclared
content-addressed bundles. Paths change only through explicit `--source` and `--index` options;
Forge never guesses alternate locations.

Repositories can use `.github/actions/forge-collection/action.yml` with an exact package version.
A collection intended for managed import must also run:

```sh
forge-collection verify . --managed collection/managed.json
```

`collection/managed.json` is unnecessary for browser-only practice. For formal publishing it binds
the browser collection revision to allowed languages and one byte-length/SHA-256-addressed
reference program per language. Publication validates only the declared schema, paths, sizes,
digests, and judge packaging; reference programs are author-owned examples and are not compiled,
executed, scored, or treated as proof that a problem is correct.

```json
{
  "schema": "forge-managed-collection-v1",
  "collectionRevision": "<collection/index.json revision>",
  "problems": [{
    "id": "sum-two",
    "allowedLanguages": ["c"],
    "references": [{
      "language": "c",
      "target": "wasip1",
      "optimization": "release",
      "entry": "main.c",
      "files": [{
        "path": "main.c",
        "repositoryPath": "problems/sum-two/solutions/c/main.c",
        "bytes": 123,
        "sha256": "<lowercase SHA-256>"
      }]
    }],
    "judge": { "kind": "text" }
  }]
}
```

`repositoryPath` identifies immutable archive bytes; `path` is the project path seen by the
compiler. A source file is limited to 256 KiB and one program to 128 files/1 MiB. `text` keeps the
browser bundle's line matcher. A managed problem may instead declare exactly one `checker` or
`interactive` program. That program must be C, C++, Rust, or Go source which the pinned validation
Container compiles to standalone Wasm; prebuilt Wasm, runtime bundles, package dependencies, build
scripts, repository Actions, shell commands, and native binaries are never accepted or executed.

A minimal custom checker replaces `judge` above with:

```json
{
  "kind": "checker",
  "program": {
    "language": "c",
    "target": "wasip1",
    "optimization": "release",
    "entry": "checker.c",
    "files": [{
      "path": "checker.c",
      "repositoryPath": "problems/sum-two/checker/checker.c",
      "bytes": 456,
      "sha256": "<lowercase SHA-256>"
    }],
    "assets": [{
      "path": "/checker/assets/policy.dat",
      "repositoryPath": "problems/sum-two/checker/policy.dat",
      "bytes": 32,
      "sha256": "<lowercase SHA-256>"
    }],
    "args": ["/checker/assets/policy.dat"]
  }
}
```

The checker always receives input, expected output, contestant stdout, and contestant stderr as
its first four fixed file arguments; declared `args` follow. Checker assets must live below
`/checker/assets/`. An interactive judge uses the same program shape, assets below
`/interactor/assets/`, plus an `inputPath` below `/interactor/input/`; Forge prepends that path to
the interactor arguments. Assets are arbitrary bounded bytes and are mounted as data only.
Each asset and one trusted program's combined assets are limited to 4 MiB; normalized trusted Wasm
is limited to 8 MiB. The complete canonical server-judge projection—including problem data,
base64 artifact, and assets—must remain within 32 MiB or validation rejects it.

Canonical validation source records every declared source and asset's repository path, byte length,
and SHA-256. Validation compiles only a declared checker/interactor so the judge package is runnable;
it does not run reference solutions or assess their correctness, performance, or score. The private
server-judge projection receives only the normalized standalone judge Wasm and its bounded runtime
assets. Practice and contest-public projections contain none of those trusted bytes. Official audit
rows contain only verdict, contestant termination, deterministic cost, and contestant peak
memory—never hidden input, expected output, case ID, output, diagnostics, or interactive protocol.

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

Forge validates every value before constructing a `raw.githubusercontent.com` URL. Repository
paths must be normalized relative POSIX paths and cannot contain absolute paths, empty segments,
backslashes, `.` or `..`. Settings are scoped to the current browser. Project drafts and solved
progress combine the normalized source key with each problem bundle digest. Unchanged problems
keep their state across index updates; a changed problem is isolated automatically even when its
slug stays the same.

## Lazy loading and integrity

The `wasm-oj-browser-collection-v5` index is capped at 512 KiB and contains localized list and
learning-track metadata, explicit repository-root-relative statement paths for both locales, and
one bundle descriptor per problem. Forge renders the challenge list after loading
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

These source strings are part of the integrity-addressed bundle. `forge-collection build` and the
browser use the same exact parser, so an external author must provide every language template and
cannot rely on Forge to synthesize a missing file. Creating a draft copies the declared file map
byte-for-byte, sorts paths deterministically, and selects the declared entry. The local 45-problem
development fixture generates its generic templates only while building the fixture; no runtime
template fallback exists.

The learning-assistant button opens ChatGPT in one click with a compact query. It links to the
active locale's public statement Markdown, which includes the samples, and keeps only the selected
language's declared starter entry file inline. Forge never guesses a statement path from a slug or bundle
name. This keeps the query URL bounded while preserving an explicit source for the full problem;
the default catalog is regression-tested so every locale and language combination stays below
2,048 URL characters.

The canonical repository keeps stable manifest IDs and paths for API
consumers. Its separate `learning-path.json` groups problems by topic and orders each group from
lower prerequisite load to more advanced techniques. The published browser index flattens that
path into contiguous display numbers and includes each stable track ID and localized track name. Forge groups the
catalog by those tracks and searches across display number, slug, both localized titles, both
localized track names, and tags.

Every descriptor declares the exact byte length and lowercase SHA-256 digest. Forge enforces a
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
configuration error. Forge does not silently switch repositories or use a bundled catalog.

## Cache behavior

Verified bundles are stored in the browser Cache API by SHA-256, not request URL or branch name.
Cached bytes are re-hashed before reuse, so unchanged problems survive index revisions safely.
The index is requested again on startup. If and only if the network itself is unavailable, Forge
may load the previously validated index for the exact same source key and labels it `verified
cache` in the interface. HTTP and validation failures never fall back to cached configuration.

The canonical source repository defines generation and publication of the split collection.
Forge keeps `src/judge/problems.generated.ts` solely as a typed test fixture regenerated from its
development mirror; no problem payload is emitted as a Sites static asset or included in the
server Worker.

## Scoring

Instruction policies remain evidence-derived. For each language, Forge takes the maximum net
weighted cost over the complete manifest case set. The optimal tier averages the C, C++, Rust,
and Go maxima and adds 5%; efficient uses the maximum of those four plus 5%; baseline uses the
maximum of all seven reference languages plus 5%. Results are rounded upward by the documented
decimal quantum.

Each judge case runs once under the broadest hard limits. Forge then evaluates the same normalized
cost, peak linear memory, and optional logical time against each cumulative policy. Artifact
language and exact cost-profile identity must match the problem configuration before judging begins.
