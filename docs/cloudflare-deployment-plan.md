# Cloudflare production deployment

Forge uses one direct, Owner-approved production deployment. It does not require staging
acceptance, artifact attestation, qualification evidence, drain receipts, bootstrap recovery, or a
release-package retention service.

## Production resources

The production Worker configuration is [wrangler.quick-production.jsonc](../wrangler.quick-production.jsonc).
It binds:

- the application Worker and static assets;
- `CORE_DB` and `SUBMISSIONS_DB`;
- private primary and mirror R2 buckets;
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
4. waits until D1 reports no active submissions, imports, or rejudges;
5. applies pending migrations to both D1 databases while formal mutations remain disabled;
6. deploys the app Worker, Workflows, the two Container adapter bindings, and Turnstile route;
7. checks `/api/health/live` and `/api/health/ready`; and
8. enables formal mutations.

This is intentionally a fast deployment path. There is no automatic staging promotion or
cross-account backup. Production is best-effort and has no formal SLO or 24/7 on-call promise.

Immediately after the workflow completes, use the normal production UI to run one Turnstile-backed
Official Submit through D1 event polling, one Organizer import/publish, and both problem and contest
leaderboard reads. If a functional smoke fails, an Admin pauses formal mutations and the fix is
deployed forward.

## Operations

`GET /api/health/live` checks the Worker process. `GET /api/health/ready` checks both D1 bindings.
An authenticated Admin can read, pause, or resume new formal work through
`/api/admin/formal-mutations`, `/pause`, and `/resume`. These routes are not exposed in the student
UI.

Formal mutations normally remain enabled. Pause them only for an actual incident or migration that
cannot accept new formal jobs. Existing submissions continue through Workflows and Containers.

Deleting the five old product-state Durable Object classes is a one-way cutover. A failure after
that point is fixed by deploying the corrected Worker forward; the workflow does not attempt a
version rollback across the schema change. D1 Time Travel remains available for operator-assisted
database recovery, but deployment does not automatically restore or rewrite data.

## Deliberately removed

- staging-acceptance workflow and synthetic 50/500 load harness;
- release candidate/qualification/activation state machine;
- GitHub artifact attestations and evidence bundles;
- external drain observations and one-use drain receipts;
- bootstrap intent/resume protocol;
- release-package primary/mirror root and GC protocol;
- clean-commit provenance and cost-calibration deployment gates; and
- scheduled cost-monitor workflow.

The remaining checks are the ones needed to compile, migrate, deploy, and answer health probes.
