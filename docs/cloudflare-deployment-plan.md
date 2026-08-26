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
8. Probe `/api/health/container`, `/api/health/live`, and `/api/health/ready`.
9. Leave formal mutations unchanged by default. If the operator explicitly checks
   `resume_formal_mutations` after completing the product smoke, run
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
