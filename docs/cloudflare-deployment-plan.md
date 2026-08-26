# Cloudflare production deployment and repository cutover

Production deploys one exact Git commit as both the Worker and Container build identity. This is
the complete deployment identity and is injected only into the Worker config and Docker build.

## Normal deployment

`.github/workflows/cloudflare-production.yml` performs the following ordered path:

1. Install, typecheck, and build the repository.
2. Run `scripts/render-production-config.mjs --build-id "$GITHUB_SHA"`.
3. Apply D1 migrations through `scripts/production-migrations.mjs apply`.
4. Run `wrangler deploy --config wrangler.quick-production.jsonc --tag "$GITHUB_SHA"`.
5. Run `scripts/wait-container-rollout.mjs` until the Container application is stably ready.
6. Probe `/api/health/container`, `/api/health/live`, and `/api/health/ready`.
7. Leave formal mutations unchanged by default. If the operator explicitly checks
   `resume_formal_mutations` after completing the product smoke, run
   `scripts/production-migrations.mjs resume --cutover-smoke-confirmed`.

The renderer replaces exactly one Worker `WASM_OJ_BUILD_ID` placeholder and exactly one Docker
`ARG WASM_OJ_BUILD_ID`. Both must be the lowercase 40-character `$GITHUB_SHA`. Wrangler builds and
pushes `containers[].image: "./Dockerfile"`; the workflow does not create an independent image
coordinate. The deploy tag is available as Worker version metadata.

Rollout wait remains mandatory because Worker and Container rollout do not complete as one
transaction. Production uses `rollout_step_percentage: 100` to replace Container capacity in one
step rather than staging 10% and 100% rollouts. Readiness rejects a Worker tag/build mismatch. The
protected Container smoke rejects a Container build, contract, or protocol mismatch before any
real submission attempt token is forwarded.

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
gate paused with reason `repository-source-truth-cutover`. During that exact reason only, an
authenticated Organizer request may use `X-WASM-OJ-Maintenance-Smoke-Token` to connect and sync
the prepared exact commit and to make a bounded Official Submit smoke while ordinary mutations
remain paused. Verify content and stale projection through the normal read APIs.

Only after those checks pass, rerun the production workflow with `resume_formal_mutations`
explicitly checked, or use the authenticated admin fallback below. Resume is fenced to the exact
paused reason and records `repository-source-truth-production-smoke-passed`; it cannot override an
unrelated incident pause.

The authenticated admin fallback is:

```sh
curl --fail -X POST "$WASM_OJ_ORIGIN/api/admin/formal-mutations/resume" \
  -H "Origin: $WASM_OJ_ORIGIN" \
  -H "Content-Type: application/json" \
  -H "X-WASM-OJ-CSRF: $WASM_OJ_CUTOVER_ADMIN_CSRF" \
  -H "Cookie: wasm_oj_session=$WASM_OJ_CUTOVER_ADMIN_SESSION; wasm_oj_csrf=$WASM_OJ_CUTOVER_ADMIN_CSRF" \
  --data '{"reason":"repository-source-truth-production-smoke-passed"}'
```

The maintenance Container probe uses `Authorization: Bearer $MAINTENANCE_SMOKE_TOKEN`; its secret
is configured as `MAINTENANCE_SMOKE_TOKEN` in the Worker environment and is never returned by an
untrusted route.

## Verification

`pnpm run github:verify` checks migration fixtures, the renderer, Container build context and
rollout behavior, and active GitHub workflow structure. `pnpm run docs:verify` checks that active
documentation describes only the repository-source runtime path.
