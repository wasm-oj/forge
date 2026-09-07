# Cloudflare production deployment and repository cutover

Production deploys one exact Git commit as both the Worker and Container build identity. This is
the complete deployment identity and is injected only into the Worker config and Docker build.

## Normal deployment

`.github/workflows/cloudflare-production.yml` performs the following ordered path:

1. Install, typecheck, and build the repository.
2. Run `scripts/render-production-config.mjs --build-id "$GITHUB_SHA"`.
3. Build the exact amd64 Container with Buildx, loading and updating the shared
   `type=gha,scope=wasm-oj-submission-production` layer cache.
4. Apply D1 migrations through `scripts/production-migrations.mjs apply` and capture the current
   Container rollout baseline.
5. Push `wasm-oj-submission-production:$GITHUB_SHA` through `wrangler containers push`.
6. Run `wrangler deploy --config wrangler.quick-production.jsonc --tag "$GITHUB_SHA"`; the rendered
   config references the prebuilt exact-commit image rather than a Dockerfile.
7. Run `scripts/wait-container-rollout.mjs` until the Container application is stably ready.
8. Probe `/api/health/live` and `/api/health/ready`.
9. Leave formal mutations unchanged by default. If the operator explicitly checks
   `resume_formal_mutations` after completing the admin Container check and product smoke, run
   `scripts/production-migrations.mjs resume --cutover-smoke-confirmed`.

The renderer replaces exactly two config placeholders: the Worker `WASM_OJ_BUILD_ID` and the
Container image tag. Buildx passes the same lowercase 40-character `$GITHUB_SHA` through Docker
`ARG WASM_OJ_BUILD_ID`. A cache miss performs the same complete build; it never selects another
image. Wrangler authenticates and pushes the locally validated image to Cloudflare's managed
registry, and the deploy tag remains available as Worker version metadata.

The Dockerfile performs dependency imports, an identity-independent runtime execution smoke, and
broad permission hardening before the commit-specific build argument. Identity generation then
loads and verifies the embedded identity, executable inventory, and toolchain distribution before
the final write/delete fences. A new commit can therefore reuse the execution-tested runtime layer
while the small build-ID layer still verifies the exact final image contents.

Rollout wait remains mandatory because Worker and Container rollout do not complete as one
transaction. Production uses `rollout_step_percentage: 100` to replace Container capacity in one
step rather than staging 10% and 100% rollouts. Readiness rejects a Worker tag/build mismatch. The
authenticated Cloudflare rollout checks run in CI. After deployment, an admin uses **Check
Container** in Production operations to verify the live Worker and Container build, contract, and
protocol. Official Submit also rejects an identity mismatch before forwarding an attempt token.

## One-time repository-source cutover

Migration `0019_repository_source_truth.sql` has no compatibility view or runtime shim. Before it
runs, `scripts/production-migrations.mjs` disables formal mutations and verifies one exact preflight
row:

- `contests = 0`;
- no nonterminal catalog, submission, or rejudge work;
- no pending outbox delivery; and
- `formal_mutations_enabled = 0`.

Any nonzero count aborts. The migration preserves users, roles, profiles, terminal practice
submissions/results, sources, events, leaderboards, effective rejudge links, and operational audit
data. It derives historical `problem_revisions` from existing series and descriptors, selects only
the latest active official-practice commit per catalog, maps historical runtime Git commits onto
`submission_attempts.runtime_build_id`, then removes the old release and catalog lifecycle tables.

Before deploying the migration, add `wasm-oj.json`, `collection/problems.json`, and
`collection/contests.json` to the official problem repository. The migration leaves the global
gate paused with reason `repository-source-truth-cutover`. In production during that exact reason,
an authenticated admin can sync an existing catalog and make ordinary code Official Submit
requests while ordinary accounts remain paused. These two operations retain the existing
authentication, resource ownership, CSRF, and quota checks. All other formal mutation operations
remain paused, including catalog connection, Prompt Program attempts, rejudge, and contest
operations. An admin who owns the catalog syncs the prepared exact commit and makes a bounded
code submission smoke. Verify content and stale projection through the normal read APIs.

After deployment, sign in as an admin and run **Check Container** in Production operations. This
calls `POST /api/admin/container-probe` with the existing browser session and CSRF protection. It
may start the Container and succeeds only when its build, contract, and protocol match the Worker.
CI continues to use its existing Cloudflare deployment credentials for rollout verification; the
live Container probe and catalog, content, submission, and stale-projection smoke are manual admin
checks.

Only after all checks pass, use **Resume formal mutations** in Production operations, or rerun the
production workflow with `resume_formal_mutations` explicitly checked. Both paths require an empty
`contest_v2_preflight_blockers` view and the exact cutover pause reason, then record
`repository-source-truth-production-smoke-passed`. An unrelated incident pause remains blocked.
The admin API uses the same existing browser authentication and CSRF protection:

```sh
curl --fail -X POST "$WASM_OJ_ORIGIN/api/admin/formal-mutations/resume" \
  -H "Origin: $WASM_OJ_ORIGIN" \
  -H "Content-Type: application/json" \
  -H "X-WASM-OJ-CSRF: $WASM_OJ_CUTOVER_ADMIN_CSRF" \
  -H "Cookie: wasm_oj_session=$WASM_OJ_CUTOVER_ADMIN_SESSION; wasm_oj_csrf=$WASM_OJ_CUTOVER_ADMIN_CSRF" \
  --data '{"reason":"repository-source-truth-production-smoke-passed"}'
```

## One-time contest v2 cutover

Migration `0020_contest_v2_runtime.sql` is a one-way rules/runtime cutover. Schedule it only after
formal mutations are paused and there are no running or paused contests, pending contest rule
operations, nonterminal contest submissions, prompt attempts, checkpoint settlements, or judge
rollouts. Do not start a v2 contest in the same deployment window until these checks complete.

The SQL phase retains the legacy rows as immutable source evidence and records one durable cutover
item per contest. The deployment tool then performs the bounded application phase because SQLite
does not provide the SHA-256 primitive needed by the repository contract. It deterministically
materializes every legacy revision as a classic code snapshot: global clock, simultaneous release
(split into batches of at most eight), 100 points per problem, the former leaderboard tie-breaks,
no checkpoints, and an effectively unbounded typed attempt limit. It also maps participants and
public-contest submitters to account entrants and attaches every terminal origin submission to the
new official timeline without modifying its source or submission row. Unrepresentable clocks,
missing commit/problem facts, or nonterminal work fail closed; no digest is guessed.

After applying and translating, the activation preflight is:

```sql
SELECT blocker_kind, blocker_key
FROM contest_v2_preflight_blockers
ORDER BY blocker_kind, blocker_key;
```

Any returned row blocks contest v2 activation. The runtime never reads `contest_revisions`,
`contest_revision_problems`, or `contest_participants` as a fallback.

Before restoring formal mutations for new contests, synchronize every catalog that was active at
cutover from an exact commit whose `collection/contests.json` declares
`wasm-oj-platform/contests/v2`. Each successful strict-v2 sync atomically clears that catalog's
`catalog_contest_v2_resync_requirements` row; D1 fences global and individual Start while it remains
pending. Repository v1 is rejected even when its contest list is empty. Confirm that contest projections expose a timeline
generation, rule/problem epochs, logical time, next boundary, problem lock state, entrant state,
and `promptCompilerAvailable`. A public repository staged contest must also expose the UI-only
timing warning.

## Verification

`pnpm run github:verify` checks migration fixtures, the renderer, Container build context and
rollout behavior, and active GitHub workflow structure. `pnpm run docs:verify` checks that active
documentation describes only the repository-source runtime path.
