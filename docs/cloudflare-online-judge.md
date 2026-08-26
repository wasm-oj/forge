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
| Contest identity/projection | `contest_series` and `contest_revisions` |
| Invite code | D1 HMAC only |
| Participants, submissions, effective results | D1 operational tables |
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

Official Submit sends `problemId` and `catalogCommit`. Admission requires that pair to equal the
current active problem revision; otherwise it returns `409 problem-revision-stale`. The submission
stores the stable problem ID, actual catalog commit, and judge digest permanently. The runtime
build ID is recorded later on `submission_attempts`, when the attempt actually starts.

An effective historical result continues to rank. It is `stale` only when its `judgeDigest`
differs from the active revision. APIs also expose `judgedCommit` and `activeCommit`; title,
statement, or contest-time edits alone do not make a result stale. A manual commit-to-commit
rejudge creates child submissions and atomically changes the effective result when all children
reach deterministic terminal outcomes. The origin submission is never rewritten.

Repository synchronization immediately controls contest status, metadata, problem membership,
and order. Scores for a problem removed from the active contest projection no longer contribute to
the current aggregate, but remain visible in personal history. Invite HMACs and participants are
operational data and are never overwritten by a sync.

## Execution and event delivery

Submission Workflow reads the active immutable judge descriptor, creates an attempt token, then
fences the Container before forwarding that token. The fence compares the 40-character Worker
build ID, Worker version ID, container contract, and container protocol. Submission progress is
persisted as append-only `submission_events`; clients resume with
`events?after=<cursor>`. Reconciler and outbox processing repair bounded operational delivery, not
catalog content history.

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
