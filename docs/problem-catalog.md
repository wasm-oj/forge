# Problem collection loading

Forge's default problem collection is the public
[`wasm-oj/problems`](https://github.com/wasm-oj/problems) repository. The browser never lists
repository directories or guesses statement, editorial, solution, or test paths.

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

The `wasm-oj-browser-collection-v4` index is capped at 512 KiB and contains localized list and
learning-track metadata, explicit repository-root-relative statement paths for both locales, and
one bundle descriptor per problem. Forge renders the challenge list after loading
the index and initially downloads only the first problem. Selecting another problem fetches its
`wasm-oj-browser-problem-v3` bundle on demand.

The learning-assistant button opens ChatGPT in one click with a compact query. It links to the
active locale's public statement Markdown, which includes the samples, and keeps only the selected
language's starter template inline. Forge never guesses a statement path from a slug or bundle
name. This keeps the query URL bounded while preserving an explicit source for the full problem.

The canonical repository keeps stable manifest IDs and paths for calibration evidence and API
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
- unique test identities and supported case kinds;
- exact calibration languages and method;
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
language and exact cost-profile identity must match the problem calibration before judging begins.
