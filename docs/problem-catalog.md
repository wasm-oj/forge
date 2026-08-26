# Repository problem and contest contract

The repository is the single source of truth for problem content and contest configuration. The
platform synchronizes one exact 40-character Git commit at a time; D1 stores only query projections,
stable series identities, operational credentials, and the active commit pointer.

## Repository layout

The root file is always `wasm-oj.json`:

```json
{
  "schema": "wasm-oj-platform/repository/v1",
  "problems": "collection/problems.json",
  "contests": "collection/contests.json"
}
```

`collection/problems.json` uses `wasm-oj-platform/problems/v1`. Each problem has a stable `slug`,
unique positive `order`, localized `title` and `summary` (`zh-TW` and `en`), `practiceEnabled`, and
exact descriptors for `practiceBundle`, `contestBundle`, and `judgePackage`:

```json
{
  "path": "dist/problems/sum-two.practice.json",
  "bytes": 4096,
  "sha256": "<64 lowercase hexadecimal characters>"
}
```

`collection/contests.json` uses `wasm-oj-platform/contests/v1`. A contest declares its stable
`slug`, `status` (`draft`, `published`, or `archived`), title, description, `accessMode`, UTC start,
end and optional freeze timestamps, plus an ordered list of problem slugs. Repository data may be
corrected at any later commit. Invite codes are credentials: only their D1 HMAC and rotation API
exist; the repository never contains them.

Manifest JSON must be valid UTF-8 and match the exact schema, but need not use canonical JSON byte
encoding. Paths are normalized repository-relative POSIX paths. Byte length and SHA-256 belong to
the referenced content object and are used for transport verification and content-addressed cache
keys. The Git commit itself is the complete catalog version.

## Authoring

```sh
pnpm exec woj organizer collection init .
pnpm exec woj organizer collection build .
pnpm exec woj organizer collection verify .
```

The optional author-only `collection/source.json` uses
`wasm-oj-platform/repository-authoring/v1`, and its trusted judge declarations use
`wasm-oj-platform/repository-authoring-judges/v1`. `build` derives practice and contest public
projections and a private `WOJJDG02` judge package, then writes the three repository manifests.
`verify` checks those outputs without rewriting them. `--source <path>` selects a different
normalized authoring input.

Both commands enforce schema, path, size, digest, public/private redaction, public-projection
relationships, supported compile profiles, and deployable judge-package structure. They do not
compile, run, benchmark, score, or assess a reference solution. `allowedProfiles` is carried only
inside the judge package manifest, and every problem's maximum score is 100.

Repositories can use [`.github/actions/woj/action.yml`](../.github/actions/woj/action.yml) with an
exact `@wasm-oj/cli@0.2.0` package version to run the same static verification in CI.

## Exact-commit synchronization

The remote Organizer journey is:

```sh
woj organizer catalog connect --repo <numeric-repository-id>
woj organizer catalog sync <catalog-id> --ref <branch-tag-or-commit> --wait
woj organizer catalog show <catalog-id>
```

The Catalog Workflow resolves `ref` exactly once. Every later GitHub request uses the resulting
commit SHA. It reads the root, problem, and contest manifests; verifies all referenced objects;
ensures each judge package is present under its content-addressed R2 key; then inserts the query
projection and changes `active_commit_sha` in one D1 transaction. A failed sync leaves the old
active commit untouched. Repeating the same commit is idempotent and still repairs a missing judge
object.

Public content is loaded on demand. The service first checks `public-content/v1/<sha256>` in R2.
On a miss it requests the declared repository path at the exact active commit, verifies byte length
and SHA-256, and conditionally fills the cache. A GitHub or R2 failure on a cold cache fails closed;
the service never substitutes a branch head, older commit, or unchecked bytes. The cache interface
is intentionally reusable by a future manual warm command.

## Browser-local collections

Credential-free GitHub collections used only for local browser practice remain a separate feature.
Their browser bundle schema and cache do not authorize Official Submit and do not participate in
the repository catalog sync described above.
