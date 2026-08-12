# Cloudflare Online Judge

WASM-OJ has two product paths:

| Path | Where it runs | Login | Server record |
| --- | --- | --- | --- |
| Local Build / Run / Judge | Browser | No | None |
| Official Submit | Cloudflare Container | GitHub | Submission, result, Profile, leaderboard |

Local activity stays in the browser and never creates a server submission or analytics event.

## User features

- GitHub login and Profile;
- anonymous local practice for public collections;
- managed official-practice problems;
- source-only Official Submit with live queue and verdict events from a D1 cursor log;
- practice leaderboards and the Performance Lab;
- public and invite-only contests;
- contest join, submit, freeze-aware leaderboard, and source visibility; and
- account deletion.

Official Submit accepts a managed problem version, optional contest, language/profile, entry,
source files, and idempotency key. The server ignores client artifacts, limits, and verdicts. It
recompiles source in a one-shot Container with no public Internet. Hidden cases, expected output,
case identity, and stdout/stderr are not returned by public APIs or events.

## Organizer features

An approved Organizer connects the environment's GitHub App to selected repositories. Private
repository access uses a short-lived installation token. A signed `installation.created` webhook
binds the exact installation to the signed-in GitHub identity; a callback cannot claim another
installation.

The Organizer selects a repository, ref, and collection index. Before admitting work, the server
resolves the ref once to an exact commit. Catalog Workflow reads only the declared Git tree and
blobs, with bounded schema, path, size, digest, canonical-encoding, redaction, and static Wasm
checks. It never downloads an archive, runs author code, or starts a Container. Explicit publish
streams the declared immutable judge packages into R2 and atomically creates D1 publication and
problem-version records. Activation is a separate explicit action; contests bind a publication ID.

The official `wasm-oj/official-problems` repository is an ordinary managed collection and can be
published as `official-practice` through the same import UI.

## Resource model

| Resource | Scope / owner | Storage |
| --- | --- | --- |
| User, role, Profile | GitHub user | `DB` |
| GitHub App installation | Organizer | `DB`; GitHub stores repository authority |
| Collection revision pointers | Organizer + exact repository commit | `DB`; bytes remain in GitHub |
| Problem version | Immutable publication-to-series identity | Thin `DB` link; metadata comes from the immutable revision view and judge bytes from private R2 |
| Contest | Organizer | `DB` |
| Submission source and result | User + managed problem | `DB`, private R2 |
| Submission event cursor log | Submission | `DB` |
| Local project and local progress | Browser profile | IndexedDB/browser cache only |

One private R2 bucket stores only `WOJJDG02` immutable judge packages and submission source bytes.
Practice and contest-public content is authorized through D1, then proxied from an exact Git commit
with a cache of at most 300 seconds. R2 writes use exact keys, conditional creation, and stored size
and SHA-256 verification; it is not a second problem repository or version authority.

## Submission state and capacity

D1 is authoritative for submission state, events, and capacity. Workflow and Container callbacks
append allowlisted public events to `submission_events`; the browser reads at most 100 events at a
time from `/api/submissions/:id/events?after=<cursor>` and polls again from the returned opaque
cursor. There is no socket-specific state or in-memory replay source. A terminal D1 state stops
polling even when an older submission has no event history.

Submission admission and execution claims use conditional D1 writes. The fixed pilot limits are
one executing and three queued submissions per account, 50 executing submissions globally, and
500 nonterminal submissions globally. A terminal state naturally releases capacity.

Capacity exhaustion does not create a second waiting state: work remains `queued` until the shared
oldest-eligible dispatcher atomically claims it as `preparing`. Rejudge children use the same queue
and dispatcher, subject to the ten-slot rejudge cap.

## Performance Lab

Every managed problem exposes a Performance tab backed by the canonical effective-result read
model. The global frontier contains at most one completed result per participant and compares
score, deterministic cost, and peak memory. A point is Pareto-optimal only when no other returned
candidate has at least its score, at most its cost and memory, and one strict improvement. The UI
plots `log1p(deterministicCost)` on the horizontal axis, score on the vertical axis, memory as point
size, and language as color. This is a visualization of judge results, not a separate ranking
authority.

Signed-in users also receive their bounded chronological origin-submission history. Rejudge changes
the effective metrics but never changes the origin timestamp; compile and judge failures remain in
the evolution event strip instead of being fabricated as chart coordinates. Official practice uses
the active effective version. Contest metadata remains pinned to the contest publication, and a
running contest's global frontier obeys the existing freeze cutoff while the owner can still inspect
their own complete history.

A completed Container result includes one bounded policy aggregate for the fixed `baseline`,
`efficient`, and `optimal` policies. D1 stores only total cases, output-accepted cases, and aggregate
earned/cost/memory/logical-time counts. It never stores or returns case IDs, inputs, expected output,
case order, or per-case metrics for this feature. Non-completed submissions have no policy summary.
The summary is available to its owner and, after the existing visibility and contest-embargo rules
allow it, to viewers of a public submission. Both Performance APIs return `private, no-store`
responses; anonymous viewers receive the authorized global frontier but no personal evolution.

`DB` also stores one `formal_mutations_enabled` switch per environment. Authenticated Admin
API routes can pause or resume new Official Submit, catalog validation, publish, contest-start, and rejudge
mutations with a reason. Those routes are intentionally absent from the student UI. Jobs that have
already started continue. There are no leases, drain receipts, reservation generations, or
cost-circuit state machines.

## Turnstile

Turnstile is required for first-use Organizer/Official actions and risk-triggered formal actions.
The app serves a same-origin `/turnstile/challenge` iframe. Only that route permits Cloudflare's
widget script and iframe; all other app pages retain the self-hosted executable-code policy. The
server verifies the action-bound token before admitting the formal request.

## Operations

The public Worker exposes liveness and minimal readiness. The same Worker exposes the three
Admin-only formal-mutation control routes; there is no separate operations control plane.
Automatic traces and raw invocation logs remain disabled. Structured logs must not contain query
strings, OAuth values, tokens, source, output, hidden data, or private repository names.

Cloudflare Containers require a Durable Object-backed adapter class. WASM-OJ keeps only
`SubmissionJudgeContainer` for Official Submit and rejudge execution; product state is not stored
in the adapter. Catalog Workflow performs exact-commit schema, path, size, digest, redaction, and
static judge-format validation without starting a Container.

One per-minute scheduled recovery pass dispatches oldest eligible Submission and Catalog Workflow
rows, repairs stranded submission admission, resumes account erasure directly from
`submission_sources.state='erasing'`, and advances rejudge work. The source row is the durable,
idempotent tombstone queue; there is no second maintenance-task state machine.
Each retention class has its own elapsed-time cursor and quota: submission events expire seven days
after terminal state; terminal catalog jobs, webhook deliveries, and settled outbox rows expire
after 30 days; authentication and claim records expire 24 hours after their own expiry. Unreferenced
staging judge packages expire after 24 hours under a per-digest D1 deletion fence, so a concurrent
publisher either owns `staging` or defers behind `deleting`. There is no UTC-midnight dependency or
legacy import/archive/canonical/audit cleanup path.

Deployment details are in the [production deployment guide](cloudflare-deployment-plan.md).
