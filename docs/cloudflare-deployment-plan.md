# Cloudflare production deployment

WASM-OJ has one normal deployment path and one deliberately separate, one-time architecture-v2
cutover. The normal path cannot apply the destructive reset by accident.

## Production resources

The production Worker configuration is [wrangler.quick-production.jsonc](../wrangler.quick-production.jsonc).
It binds the application and static assets, the single `DB` D1 database, one private R2 bucket,
the `SubmissionJudgeContainer`, and the Submission and Catalog Workflows. R2 v2 retains only
immutable judge packages and submission sources. Catalog validation reads bounded exact-commit
Git blobs and never starts a Container.

The protected GitHub `production` Environment requires Owner approval and provides:

- `CLOUDFLARE_DEPLOY_API_TOKEN` (including Workers R2 Storage Read/Write) and
  `CLOUDFLARE_ACCOUNT_ID` for deployment and complete bucket inventory;
- `WASM_OJ_PRODUCTION_RELEASE_REQUEST_BASE64`, the canonical activation request for the exact
  already-active release used by a normal deploy;
- `WASM_OJ_ARCHITECTURE_RESET_TOKEN`, a random value of at least 32 bytes used only by the cutover;
- `WASM_OJ_V2_ACTIVATION_REQUEST_BASE64`, the canonical request produced by
  `scripts/prepare-production-release.mjs` from a generated input bundle whose
  `expectedCurrentReleaseId` is null; and
- short-lived `WASM_OJ_CUTOVER_ADMIN_SESSION` and `WASM_OJ_CUTOVER_ADMIN_CSRF` values used only for
  authenticated cutover Admin calls: release activation, maintenance smoke, and reopening formal
  mutations. Remove these two values after cutover.

Cloudflare stores the application OAuth, GitHub App, webhook, Turnstile, account-erasure, and
invite-code secrets directly on the Worker.

## Preparing a release request

Release preparation has no digest template. Build and push the `linux/amd64` Container under the
release UUID tag, retain the digest reported by the registry, and extract
`/app/release/container-identity.json` from that exact image. Resolve the tag again through the
registry and preserve its exact OCI bytes:

```sh
node scripts/verify-oci-release-image.mjs \
  --reference "registry.cloudflare.com/ACCOUNT/wasm-oj-judge-production:$RELEASE_ID" \
  --expected-digest "$CONTAINER_DIGEST" \
  --config wrangler.quick-production.jsonc \
  --output-dir release-oci
```

Create a self-contained input bundle from the actual package, Worker/static trees, Container
identity, OCI evidence, SBOM, audit, test evidence, runtime bytes, toolchains, licenses, lockfile,
and migrations; then derive the manifest/request from that bundle:

```sh
node scripts/generate-production-release-inputs.mjs \
  --release-id "$RELEASE_ID" --version "$VERSION" --git-commit "$GIT_COMMIT" \
  --created-at "$CREATED_AT" --container-registry "registry.cloudflare.com/ACCOUNT/wasm-oj-judge-production" \
  --container-identity container-identity.json --oci-evidence release-oci/evidence.json \
  --npm-package release-package.tgz --sbom sbom.json --audit audit.json --tests-evidence tests.json \
  --provenance-issuer owner-manual-release --provenance-subject wasm-oj-production \
  --expect-no-active-release --output-dir release-inputs
node scripts/prepare-production-release.mjs \
  --inputs release-inputs/release-inputs.json --output-dir prepared-release
```

The generator copies every byte under `release-inputs/`, records fixed file/tree roles, and hashes
the copied bytes again before writing its canonical index. Prepare repeats the full verification;
changing any saved byte fails closed. If conformance or cost calibration was intentionally not run,
the generator writes canonical `status: "not-run"` evidence. It never substitutes a stale passing
digest. SBOM, audit, and tests remain required explicit evidence files.

## Normal deployment

An Owner starts **Deploy Cloudflare production** manually. The workflow installs the pinned Node
and pnpm versions, validates and binds the release coordinates, typechecks, builds, applies
non-reset migrations, deploys, waits for the exact Submission Container rollout, and verifies
`/api/health/live` and `/api/health/ready`.

The committed production config contains release placeholders, never a previous release ID or
manifest digest. Before any build or Cloudflare mutation,
`scripts/verify-oci-release-image.mjs` first resolves the UUID tag, checks the registry digest and
`linux/amd64` platform, and preserves the tag manifest, platform manifest, and config bytes.
`scripts/configure-production-release.mjs` then decodes `WASM_OJ_PRODUCTION_RELEASE_REQUEST_BASE64` as
canonical standard Base64, validates the request's exact shape and v2 release manifest, recomputes
the canonical manifest SHA-256, requires `manifest.source.commit` to equal the checked-out
`GITHUB_SHA`, re-hashes the saved OCI evidence, and binds the Worker ID, manifest digest, and
Submission Container as `registry:releaseId@sha256:...`. A missing, malformed, stale, cross-commit,
or tag/digest-mismatched request stops the workflow. For normal
redeployment, configure this secret from the immutable request for the release that is already
active in production; normal deployment does not activate a new release or open a maintenance
window. Before applying even a non-reset migration, the production migration preflight joins
`wasm_oj_active_releases` to the non-revoked immutable manifest in `wasm_oj_releases` and requires
that D1 ID/digest pair to exactly match the rendered config. A candidate that has not already been
activated therefore fails before the first Cloudflare mutation.

`scripts/wait-container-rollout.mjs` runs immediately after `wrangler deploy` and before health
checks. It reads the digest-pinned image from the rendered Worker config, then polls the pinned
Wrangler JSON interface for at most 15 minutes. Two consecutive observations must agree on the
application ID, exact image and generated application version; report `ready`; have every reported
application instance healthy with zero active, assigned, stopped, failed, scheduling, or starting
instances; and have no live Durable Object placement on an older version. Lookup or status errors
remain pending only within that bound, then fail closed. The successful receipt is retained with
the release OCI evidence.

`scripts/production-migrations.mjs normal` first proves that `0017_architecture_reset.sql` is
already present in D1's migration ledger. Before the one-time cutover it fails closed. It never
applies 0017 as part of an ordinary deployment. There is no v1 catalog backfill, catalog-count
assumption, dual read/write, or compatibility verification in this path.

## One-time architecture-v2 cutover

Start **One-time Cloudflare architecture v2 cutover** only during the approved maintenance window.
Type `RESET-PRODUCTION-ARCHITECTURE-V2`. On the first run, leave `workflows_drained` false: the run
enables maintenance and then stops before reading or writing R2. Wait through the maximum Workflow
timeout plus the safety margin, verify every pre-v2 Workflow is terminal, and rerun with
`workflows_drained` true. The production Environment approval and reset-token secret are mandatory.

The workflow validates `WASM_OJ_V2_ACTIVATION_REQUEST_BASE64` and renders all three deployment
coordinates before typechecking, building, or enabling maintenance. The same exact validated bytes
must carry a null expected-current release because the reset creates an empty v2 release authority,
and are retained at `cutover-evidence/activation-request.json` for the later Admin call. Exact OCI
manifest/config bytes are retained under `cutover-evidence/oci/`. The workflow
then executes this fail-closed sequence:

1. Set the production `formal_mutations_enabled` control to zero. Formal mutation APIs return 503;
   browser-local practice and drafts remain available.
2. Before any R2 write, perform a read-only D1 quiescence check and require the external Workflow
   drain assertion. Any active submission, catalog import, rejudge, erasure, or outbox row aborts.
3. Read the pre-reset D1 key columns and paginate the complete R2 bucket through Cloudflare's
   [List Objects API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/).
   Create one exact, prefix-validated cleanup manifest; unknown roles or prefixes abort the run.
4. Unconditionally overwrite every inventoried legacy submission-source key with one constant,
   non-personal tombstone and read the object back byte-for-byte. The receipt binds every source key
   and the complete inventory digest.
5. Recheck D1 quiescence, the external Workflow assertion, inventory, receipt, protected reset
   token, and that 0017 is the first pending migration. Only then apply the reset and any later
   exact migrations in the same guarded invocation.
6. Deploy the v2 Worker, Submission Workflow, Catalog Workflow, and Submission Container using the
   release ID, canonical manifest digest, and digest-pinned Container reference from that request.
7. Before activation, require `scripts/wait-container-rollout.mjs` to prove the digest-pinned
   Container application is terminal, fully healthy, and free of a live older application version.
   Preserve its receipt in the cutover evidence.
8. Submit the already-validated canonical activation request to
   `POST /api/admin/releases/activate`. D1 inserts or verifies the immutable release manifest and
   performs an expected-current environment-pointer CAS in one batch; the endpoint also requires
   the manifest identity to match the deployed Worker. The environment pointer is the sole active
   release authority.
9. Verify liveness and readiness while formal mutations remain paused.
10. Preserve the inventory, tombstone receipt, rollout receipt, activation request, and response as a 30-day GitHub
   artifact named with the cutover run ID.

If any step fails, the maintenance gate remains closed. Correct the cause and deploy forward; do not
resume formal mutations or run a legacy fallback. A first run that finds active work is expected to
stop safely before R2 inventory: wait for the already-paused jobs to drain, verify the external
Workflows, and rerun with the drain confirmation.

## Catalog bootstrap, production smoke, and reopening

The cutover workflow configures the 32–256 printable-ASCII-character `MAINTENANCE_SMOKE_TOKEN` Worker secret from
the protected `WASM_OJ_MAINTENANCE_SMOKE_TOKEN` GitHub secret before deploying v2. After the workflow
succeeds, keep formal mutations paused. An Admin uses an authenticated, CSRF-aware production
client and adds `X-WASM-OJ-Maintenance-Smoke-Token` to each mutation request. The Worker accepts this
header only in production, only while the D1 pause reason is one of the two exact architecture-v2
cutover reasons, and only when the token matches in constant time. Normal users continue to receive
503. The smoke token never replaces authentication or CSRF: every smoke mutation must also send the
exact production `Origin`, the Admin's `wasm_oj_session` and `wasm_oj_csrf` cookies, an
`X-WASM-OJ-CSRF` header equal to the CSRF cookie, and the endpoint's normal content type and body.

The built-in `/admin/operations` page is the preferred browser client. Paste the short-lived smoke
token into **Maintenance smoke lane** once; it remains only in the current JavaScript process and is
never written to local storage, session storage, a URL, or an API body. Client-side navigation then
adds the header to Organizer mutations and Official Submit, including a fresh Turnstile challenge.
Reloading, signing out, explicitly clearing the token, or successfully reopening formal mutations
removes it. The same page accepts the bounded canonical activation-request JSON in memory and calls
the existing Admin activation endpoint without introducing another credential path.

Through that bounded maintenance lane:

1. validate the official collection from its exact commit;
2. explicitly publish and activate its official-practice publication;
3. run Official Submit smoke cases for text, checker, and interactive judging;
4. run an ended-contest rejudge and verify the effective result, profile, and leaderboard; and
5. erase a dedicated smoke account and verify its source is tombstoned.

Any failed check leaves the global gate closed; correct the cause and retry only through the same
bounded lane. After all five checks pass, run the following from the secure cutover shell. The two
credential variables must contain a current session for a user with the `admin` role; do not paste
their values into logs or the command itself.

```sh
WASM_OJ_ORIGIN=https://wasm-oj-forge-production.jacob.workers.dev

curl --fail-with-body --silent --show-error \
  --request POST "$WASM_OJ_ORIGIN/api/admin/formal-mutations/resume" \
  --header "Origin: $WASM_OJ_ORIGIN" \
  --header "Content-Type: application/json" \
  --header "X-WASM-OJ-CSRF: $WASM_OJ_CUTOVER_ADMIN_CSRF" \
  --header "Cookie: wasm_oj_session=$WASM_OJ_CUTOVER_ADMIN_SESSION; wasm_oj_csrf=$WASM_OJ_CUTOVER_ADMIN_CSRF" \
  --data '{"reason":"architecture-v2-production-smoke-passed"}'
```

Do not proceed unless this returns HTTP 200 with `enabled: true` and reason
`architecture-v2-production-smoke-passed`. Then verify a normal authenticated mutation no longer
needs `X-WASM-OJ-Maintenance-Smoke-Token`, and delete or rotate the `MAINTENANCE_SMOKE_TOKEN`
Worker/GitHub secrets. The maintenance window is complete only then. The old fixed 45-problem
catalog check is intentionally gone because an exact publication, not a hard-coded item count, is
the v2 authority.

Alternatively, on `/admin/operations`, type the exact reason
`architecture-v2-production-smoke-passed` and choose **Resume formal mutations**. The control stays
disabled until `/api/health/ready` succeeds. The server independently verifies that D1's active
release ID and manifest digest exactly match the deployed Worker before it reopens the gate; the UI
is not the authority for this check.

## Exact-key R2 cleanup after 24 hours

Do not clean old R2 objects during cutover. After the manifest's `deleteNotBefore` time, start
**Cloudflare architecture v2 post-fence cleanup**, supply the successful cutover run ID, and type
`DELETE-EXACT-LEGACY-R2-KEYS`.

The cleanup downloads that run's immutable artifact, revalidates the inventory and tombstone
receipt, checks the protected reset token and 24-hour fence, and deletes each recorded key
individually. Allowed legacy prefixes cover imports, canonical snapshots/projections, validation
reports, attempt audits, old submission sources, release manifests, and erasure receipts. For each
pre-cutover `judge-packages/v1/` object, cleanup rechecks the v2 `judge_packages` table and preserves
every digest currently known to D1; only an unreferenced pre-cutover package is deleted. The script
cannot issue a bucket-wide or prefix-wide delete.

## Operations

`GET /api/health/live` checks the Worker process. `GET /api/health/ready` checks D1, the exact active
release identity, and the formal-mutation control row; a paused but internally consistent release is
ready. Authenticated Admins inspect, pause, or resume formal mutations through
`/api/admin/formal-mutations`, `/pause`, and `/resume`.

Production is a small-team, best-effort service without automatic staging promotion, schema
rollback, dual storage, or a 24/7 on-call promise. Schema and code fixes deploy forward.
