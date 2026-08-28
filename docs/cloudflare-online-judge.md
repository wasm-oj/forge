# Cloudflare Online Judge architecture

WASM-OJ keeps deployment and persisted content authority deliberately thin. Git repositories own
problem and contest declarations; an exact Git commit is the only catalog content version. D1 owns
query projections and operational state, R2 owns private judge packages and verified public cache
objects, Workflows coordinate asynchronous work, and `SubmissionJudgeContainer` performs Official
Submit execution.

## Data ownership

| Data | Authority |
| --- | --- |
| Problem/contest content and ordering | Exact repository commit |
| Active repository revision | `catalogs.active_commit_sha` |
| Problem identity | `problem_series(catalog_id, slug)` |
| Problem projection | `problem_revisions(problem_id, commit_sha)` |
| Contest identity and repository rules | `contest_series`, `contest_rule_revisions`, and `contest_rule_problems` |
| Contest timeline and entrants | `contest_runtimes`, `contest_timeline_events`, and `contest_entrants` |
| Contest epochs, reveal, and checkpoints | D1 v2 contest epoch/grant/decision tables |
| Prompt provenance and quota | `prompt_public_contexts`, `prompt_attempts`, and `prompt_attempt_quota` |
| Invite code | D1 HMAC only |
| Entrants, submissions, eligibility, and effective results | D1 operational tables |
| Judge package | Immutable `judge-packages/v2/<sha256>` R2 object |
| Public content cache | `public-content/v1/<sha256>` R2 object |

`Catalog Workflow` implements `sync exact commit`. It resolves the requested ref once, validates
the three repository manifests and all object descriptors, repairs missing judge objects, and
atomically writes projections plus the active commit. Its status resource is one of `queued`,
`running`, `succeeded`, or `failed`; a failure cannot move the active pointer.

The Organizer boundary validates format, path, size, digest, redaction, and judge-package
deployability only. It never compiles or executes trusted reference code. Official Submit is the
first platform boundary that compiles and runs user source against already synchronized immutable
judge data.

## Public reads and submissions

Problem list and detail APIs expose a stable `problemId`, `catalogCommit`, `judgeDigest`, and a
content URL containing the commit. Public bundle reads use the descriptor's SHA-256 as the cache
key and fetch only the exact GitHub commit on a miss.

Official Submit uses a discriminated context. Practice sends `kind: "practice"`, `problemId`, and
`catalogCommit`; admission requires the pair to equal the current active problem revision or returns
`409 problem-revision-stale`. Contest submission sends `kind: "contest"`, `contestId`, `problemId`,
`contentCommit`, `timelineGeneration`, `ruleEpoch`, and `problemEpoch`. Its final INSERT fences those
tokens together with entrant state, pause state, quota, the logical problem window, and every due
checkpoint decision. Unlike practice, a contest `contentCommit` remains an admissible immutable
revision when a metadata-only catalog sync moves the active commit without advancing its content
epoch. A Prompt
Program prompt uses the prompt-attempt API and is never encoded as a language value.

The submission stores the stable problem ID, content commit, judge digest/epoch, and contest
eligibility permanently. The runtime build ID is recorded later on `submission_attempts`, when the
attempt actually starts.

An effective historical result continues to rank. It is `stale` only when its `judgeDigest`
differs from the active revision. APIs also expose `judgedCommit` and `activeCommit`; title,
statement, or contest-time edits alone do not make a result stale. A manual commit-to-commit
rejudge creates child submissions and atomically changes the effective result when all children
reach deterministic terminal outcomes. The origin submission is never rewritten.

Repository synchronization immediately controls content and judge epochs. Changes to schedule,
membership, scoring, checkpoints, or limits become pending rules for a running contest and require
a paused Organizer activation. Scores removed from the current official timeline remain visible as
invalid history. Invite HMACs and entrants are operational data and are never overwritten by sync.

Judge-package changes immediately bind new submissions to the new epoch and create a bounded
rejudge rollout for existing timeline sources. The prior leaderboard remains effective and is
marked provisional until all new results can switch atomically. Prompt Program rejudge reuses its
locked generated source and never invokes the compiler adapter again.

Prompt Program context is content-addressed from the exact public problem projection. A production
deployment without a registered compiler adapter still serves the contest, with
`promptCompilerAvailable: false`; prompt admission returns typed
`503 prompt-compiler-unavailable` before quota reservation and does not select a fallback provider.

## Execution and event delivery

Submission Workflow reads the active immutable judge descriptor, creates an attempt token, then
fences the Container before forwarding that token. The fence compares the 40-character Worker
build ID, Worker version ID, container contract, and container protocol. Submission progress is
persisted as append-only `submission_events`; clients resume with
`events?after=<cursor>`. Reconciler and outbox processing repair bounded operational delivery, not
catalog content history.

One user may have at most eight queued submissions and one active submission. Eight is an
admission ceiling, not reserved global capacity; a saturated global queue can still return 429.

`formal_mutations_enabled` is the maintenance gate for catalog sync, submission, and rejudge
mutations. Read-only product routes remain available while the gate is paused. Production exposes
one scoped maintenance-smoke bypass only while the reason is exactly
`repository-source-truth-cutover`; it requires the configured smoke token in addition to normal
user authorization and is used to verify the cutover before the global gate is restored.

## Health

`/api/health/live` reports process liveness. `/api/health/ready` verifies D1 access, formal mutation
control access, a valid Git build ID, and `CF_VERSION_METADATA.tag === WASM_OJ_BUILD_ID`.
`/api/health/container` is a protected deployment probe that additionally verifies the running
Container build ID, contract, and protocol.
