# Declarative contest rules

WASM-OJ models a contest as three independent choices: the official track (`code` or
`prompt-program`), the entrant identity, and one typed rule set. Version 2 entrants are accounts;
the stored entrant kind reserves a future `system` identity without exposing a connector or
credential API. Repository manifests own rules and content. Operational clock, pause, checkpoint,
judge rollout, and rewind facts live in D1 and point to exact repository commits and epochs.

## Canonical repository contract

`wasm-oj-platform/contests/v2` is the only accepted contest schema. Every object and nested rule is
exact-shape validated. Repository v1, unknown properties, invalid enum combinations, and implicit
defaults fail synchronization. There is no text DSL and no v1 fallback.

Each contest has these canonical rule fields:

- `clock`: `global` declares a registration window, `startsAt`, and `durationSeconds`;
  `individual` declares an enrollment window and duration. An individual entrant must perform one
  irreversible Start before their logical clock runs.
- `officialTrack`: `code` declares `aiAssist: allowed | disabled`. `prompt-program` pins an
  immutable compiler config ID and SHA-256 digest, prompt/token/output/time limits, attempt policy,
  and `private | best-after-end` disclosure.
- `evidenceAt`: `input-admitted`, `generated-source-ready`, or `judge-terminal`.
  `generated-source-ready` is valid only for Prompt Program.
- `problems`: each problem declares `slug`, `batch`, release and submission-close offsets,
  contest `points`, and `attemptLimit`. Prompt Program also fixes `language`, `target`,
  `optimization`, and `entry` for generated output.
- `scoring`: `score`, `icpc`, or `progress`, each with only its declared tie-break enums.
- `checkpoints`: a logical offset, released-problem/batch/explicit-problem scope, solved and/or
  score threshold, optional global top-K/top-percent ranking, and settlement policy.
- `leaderboard`: `live`, a global logical `freeze`, or `hidden-until-end`.

Release, close, freeze, and checkpoint offsets must fit inside the logical duration. A release batch
contains at most eight problems, matching the per-entrant queued limit. Individual clocks cannot
use top-K/top-percent checkpoints and always use provisional settlement. For global top-percent,
the seat count is `ceil(active entrants × percent / 100)` and everyone tied on the complete
competitive key at the cutoff advances.

The Organizer boundary validates schema, paths, bounds, digests, and judge-package deployability.
It does not compile or run reference solutions, call a language model, or assess correctness,
performance, or score. Judge packages still emit 0–100; the contest's `points` field supplies the
weight.

## Authoring presets

`collection/source.json` may use these conveniences:

- `classic-score`: all problems release at logical time 0 and use weighted best score.
- `icpc`: solved count and declared wrong-attempt penalty.
- `blitz-batches`: releases bounded batches at a fixed interval and creates progress checkpoints.
- `prompt-five-by-three`: the Issue #24 five-problem, three-attempt Prompt Program profile.

`woj organizer collection build` expands a preset and writes only canonical v2 rules. The
five-by-three values are not Prompt Program limits: authors can write canonical rules with other
problem counts and attempt limits. Runtime code never branches on a preset name.

## Scoring and checkpoints

`score` chooses the best eligible result per problem, scales its 0–100 judge score by contest
points, and applies declared fully-passed-cases, deterministic-cost, peak-memory, and
final-best-achievement-time tie-breaks. `icpc` ranks solved count descending and penalty ascending;
the first 100-point result solves a problem, and only contestant verdicts explicitly listed by the
manifest add wrong-attempt minutes. Judge, infrastructure, and cancelled outcomes never add a
penalty. `progress` ranks the furthest passed checkpoint first, then solved count, aggregate score,
and declared tie-breaks.

A checkpoint can examine every problem released by its boundary, one batch, or an explicit set.
Ordinary elimination is irreversible inside a timeline generation: a late result or rejudge cannot
revive an entrant. Eliminated entrants keep read-only history and already revealed problem records,
but receive no future reveals and cannot submit.

`provisional` settlement temporarily advances entrants with bounded pending work; a later
insufficient result eliminates them and invalidates post-checkpoint official work.
`pause-until-terminal` atomically pauses a global contest at the boundary, waits for the bounded
pending set, finalizes decisions, and resumes with future wall boundaries shifted by the pause.

## Logical time, pause, and rule activation

Every official entrant joins; `public` means no invite code, not anonymous participation.
Organizer preview does not create an entrant. The centralized policy evaluator owns contest list,
metadata, bundle visibility, performance, admission, checkpoint, and leaderboard decisions so a
locked problem cannot leak through a secondary API.

Pause freezes logical time and rejects Join, Start, reveal, Official Submit, prompt admission, and
new checkpoint decisions. Generation, compile, judge, and rejudge work already admitted continues
to a terminal state and receives the frozen logical timestamp. Resume resets the wall/logical
anchor, shifting every future boundary without changing logical offsets.

Catalog state separates `rulesCommit`, each problem's `contentCommit`, and `judgeEpoch`. Public
content and judge packages can advance live. A metadata- or rules-only repository sync may move the
catalog's active commit while a running contest continues to use its exact effective `contentCommit`;
that immutable revision remains admissible until the problem content epoch advances. A digest change to schedule, membership, scoring,
checkpoint, or limits becomes pending rules and requires a paused contest. Clock kind, official
track, `evidenceAt`, and disclosure cannot change after the first Start. Prompt compiler/output
profile changes require rewind to logical time 0.

From the paused state, `monotonic-recalculate` can add eliminations and invalidate subsequent work,
but cannot revive an entrant. `rewind` creates a new whole-contest timeline generation at an
Organizer-selected past logical time. Global contests rewind everyone to the target; individual
contests use `min(currentLogicalTime, target)` for each started entrant and leave unstarted entrants
unchanged. Participant-specific rewind is forbidden.

Rewind applies the contest's `evidenceAt` to invalidate later or evidence-less attempts,
submissions, checkpoint decisions, and reveal grants. Records and sources remain available as
invalid history, while official prompt/code quota is restored. A new timeline can lock content
again, but the participant UI warns that an entrant may already have seen it.

The final submission INSERT fences entrant state, pause state, timeline generation, active rule and
problem epochs, quota, the logical problem window, and an `advanced` decision for every due
checkpoint in one transaction. Tokens from an older
projection fail rather than racing a short contest boundary.

## Judge epoch rollout

New attempts immediately bind to a newly synchronized judge epoch. Existing source snapshots in
the current timeline are rejudged in a bounded batch; Prompt Program reuses its locked generated
source and never calls the model again. Until every new result is ready, the old leaderboard stays
effective and is marked `provisional`. The system then switches the complete epoch atomically, so a
leaderboard never mixes old and new judge results. A rollout failure preserves the old board and
the provisional marker for retry. Finalized checkpoints do not change during an ordinary rejudge.

## Prompt Compiler and Prompt Program

A host-supplied compiler registry exposes immutable config identity, the exact public-context
digest, a trusted per-problem fixed output profile, bounded prompt/token/output/time limits, and a strict structured
multi-file response. Adapters receive no tools, browsing, hidden judge data, credentials, or
fallback parser. A prompt is one UTF-8 value of at most 16 KiB; generated files use the existing
Official Submission limits.

Assist places generated files into the ordinary editor, where the entrant may change them. Its
final submission is code and has no Prompt Program identity. Prompt Program instead reserves quota
atomically, and the first valid model response creates one locked generated-source record before
entering the normal Official Submission pipeline. A received malformed response or compile error
consumes the attempt; a terminal provider/platform failure before a model response releases it.

Production deliberately has no bundled model adapter. Published Prompt Program contests remain
visible and synchronize normally, but projections report `promptCompilerAvailable: false` and
admission returns typed `503 prompt-compiler-unavailable` before quota reservation. No fallback
provider is selected. Practice hides Assist and Prompt Program controls when no adapter is
registered.

`private` prompts never become public. After the whole contest ends, `best-after-end` exposes only
the best prompt and locked source selected for each entrant/problem by the final leaderboard.
Account erasure tombstones prompt/source material and removes it from that gallery.

## Public repository disclosure

Staged contests backed by a public GitHub repository provide UI-timed reveal only. Repository
contents may disclose unreleased problems before their logical release, so participant projections,
Organizer inspection, and participant UI must say **“UI timing only; GitHub content may be visible early.”**
The system does not claim repository secrecy.

## v2 cutover

Repository `contests/v1` is always rejected. Before activating contest v2, operators must pause
formal mutations, drain running or paused contests and nonterminal contest work, apply the v2
migration, and require every active catalog to synchronize an exact commit containing
`wasm-oj-platform/contests/v2` before a new contest starts.

The SQL phase records durable cutover items; the deployment tool then canonicalizes each persisted
v1 revision and hashes it into a deterministic classic-code v2 snapshot. It preserves source and
submission rows, synthesizes entrants for participants and public-contest submitters, and fails
closed when a clock, commit, problem membership, or terminal result cannot be represented exactly.
The `contest_v2_preflight_blockers` view remains non-empty until translation completes and every
formerly active catalog has successfully synchronized a strict `contests/v2` manifest. D1 fences
both global and individual Start while either gate is pending. Runtime code never reads the old
tables as a fallback.
