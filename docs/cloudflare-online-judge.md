# Cloudflare Online Judge

Forge has two product paths:

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
- practice leaderboards;
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

The Organizer selects a repository, ref, and collection index. The server resolves an exact commit,
downloads the archive, rejects unsafe entries, validates the managed collection in the Validation
Workflow and Container, and creates separate public and private judge projections. Publishing is an
explicit Organizer action that creates immutable managed problem version IDs.

The official `wasm-oj/official-problems` repository is an ordinary managed collection and can be
published as `official-practice` through the same import UI.

## Resource model

| Resource | Scope / owner | Storage |
| --- | --- | --- |
| User, role, Profile | GitHub user | `CORE_DB` |
| GitHub App installation | Organizer | `CORE_DB`; GitHub stores repository authority |
| Collection import and snapshot | Organizer + exact repository commit | `CORE_DB`, private R2 |
| Managed problem version | Published snapshot | `CORE_DB`, public/private R2 projections |
| Contest | Organizer | `CORE_DB` |
| Submission source and result | User + managed problem | `SUBMISSIONS_DB`, private R2 |
| Submission event cursor log | Submission | `SUBMISSIONS_DB` |
| Local project and local progress | Browser profile | IndexedDB/browser cache only |

Primary and same-account mirror R2 protect against a single mistaken object write. They are not an
external backup. D1's built-in Time Travel is the only database recovery facility promised by this
deployment.

## Submission state and capacity

D1 is authoritative for submission state, events, and capacity. Workflow and Container callbacks
append allowlisted public events to `submission_events`; the browser reads at most 100 events at a
time from `/api/submissions/:id/events?after=<cursor>` and polls again from the returned opaque
cursor. There is no socket-specific state or in-memory replay source. A terminal D1 state stops
polling even when an older submission has no event history.

Submission admission and execution claims use conditional D1 writes. The fixed pilot limits are
one executing and three queued submissions per account, 50 executing submissions globally, and
500 nonterminal submissions globally. A terminal state naturally releases capacity.

`CORE_DB` also stores one `formal_mutations_enabled` switch per environment. Authenticated Admin
API routes can pause or resume new Official Submit, import, publish, contest-start, and rejudge
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

Cloudflare Containers require Durable Object-backed adapter classes. Forge keeps only
`SubmissionJudgeContainer` and `ValidationJudgeContainer` for that platform integration; product
state is not stored in those adapters.

Deployment details are in the [production deployment guide](cloudflare-deployment-plan.md).
