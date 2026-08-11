# Cloudflare production deployment

Forge uses one direct, Owner-approved production deployment. It does not require staging
acceptance, artifact attestation, qualification evidence, drain receipts, bootstrap recovery, or a
release-package retention service.

## Production resources

The production Worker configuration is [wrangler.quick-production.jsonc](../wrangler.quick-production.jsonc).
It binds:

- the application Worker and static assets;
- the existing core D1 database, bound once as `DB`;
- one private authoritative R2 bucket;
- the `SubmissionJudgeContainer` and `ValidationJudgeContainer` adapters required by Cloudflare
  Containers;
- Submission and Validation Workflows; and
- Submission and Validation Container pools.

The app Worker serves the route-scoped Turnstile challenge. The existing Container image tag in
the production config is deployed with both pools.

The GitHub `production` Environment stores the Cloudflare API token and requires the Owner's
manual approval. Cloudflare stores GitHub OAuth, GitHub App, webhook, Turnstile, erasure, and invite
secrets directly on the corresponding Workers.

## Deploy

Merging to `main` starts **Deploy Cloudflare production**; it can also be started manually from
GitHub Actions. After production Environment approval the workflow:

1. installs Node 24.18 and pnpm 10.34.5;
2. runs typecheck and the site build;
3. briefly replaces the app with a maintenance Worker so no new formal request can start;
4. waits at most ten minutes for active validation imports; submission and rejudge history is reset
   by the one-way single-store migration;
5. applies pending migrations once to `DB`, deletes retired `sources/` and `audits/` objects, and
   keeps formal mutations disabled;
6. deploys the app Worker, Workflows, the two Container adapter bindings, and Turnstile route;
7. checks `/api/health/live`, `/api/health/ready`, and the complete 45-problem official catalog; and
8. enables formal mutations so an authenticated operator can run the required Turnstile, Official
   Submit, and Organizer import/publish smoke.

This is intentionally a fast deployment path. There is no automatic staging promotion or
cross-account backup. Production is best-effort and has no formal SLO or 24/7 on-call promise.

Immediately after the workflow completes, use the normal production UI to run one Turnstile-backed
Official Submit through D1 event polling, one Organizer import/publish, and both problem and contest
leaderboard reads. If a functional smoke fails, an Admin pauses formal mutations and the fix is
deployed forward.

## Operations

`GET /api/health/live` checks the Worker process. `GET /api/health/ready` checks the single D1 binding.
An authenticated Admin can read, pause, or resume new formal work through
`/api/admin/formal-mutations`, `/pause`, and `/resume`. These routes are not exposed in the student
UI.

Formal mutations normally remain enabled. Pause them only for an actual incident or migration that
cannot accept new formal jobs. Existing submissions continue through Workflows and Containers.

The single-store migration and retired resource deletion are a one-way cutover. Existing accounts,
roles, installations, collections, published snapshots, contests, and participants remain. Existing
submission, solve, leaderboard, contest-result, and rejudge history is intentionally reset. A
failure is fixed by deploying forward; the workflow immediately disables formal mutations and does
not attempt a version rollback across the schema change.

The deployment workflow deliberately does not delete the retired submissions database or mirror
bucket after anonymous health/catalog checks. After the authenticated Official Submit and Organizer
smoke succeeds, run `node scripts/delete-retired-submissions-d1.mjs` and then
`node scripts/cleanup-production-r2.mjs --operation delete-mirror` with the production Cloudflare
credentials. If either functional smoke fails, pause formal mutations and roll forward instead.

## Deliberately removed

- staging-acceptance workflow and synthetic 50/500 load harness;
- release candidate/qualification/activation state machine;
- GitHub artifact attestations and evidence bundles;
- external drain observations and one-use drain receipts;
- bootstrap intent/resume protocol;
- release-package primary/mirror root and GC protocol;
- clean-commit provenance and cost-calibration deployment gates; and
- scheduled cost-monitor workflow.

The remaining checks are the ones needed to compile, migrate, deploy, answer health probes, and
confirm that the official catalog is still available.
