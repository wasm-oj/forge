# Release contract

Forge releases are immutable npm packages and matching GitHub Releases. The
package currently uses experimental SemVer `0.x`; that does not change the
single `wasm-oj-forge-v1` compiler, runner, judge, replay, and evidence contract.

## Automation boundary

- `.github/workflows/ci.yml` runs on every `main` push and pull request. It
  verifies pnpm policy, conformance provenance, types, lint, tests, the packed
  browser/server consumers, the production site, native runtime tests, and the
  web runtime target.
- `.github/workflows/release.yml` runs only for a `vMAJOR.MINOR.PATCH` tag. It
  repeats the full CI gate without a dependency cache, checks that the tag is
  exactly `v${package.version}`, packs one deterministic tarball, creates a
  SHA-256 sidecar and GitHub build attestation, publishes that exact tarball to
  npm, and then publishes the draft GitHub Release.
- A rerun accepts an existing npm version only when the registry tarball is
  byte-identical to the locally verified release tarball.

Every action dependency is pinned to an immutable commit. Workflows use the
minimum permissions declared by each job. The release job is attached to the
`npm` GitHub environment and requires `contents: write`, `id-token: write`, and
`attestations: write`; normal CI has read-only repository access.

## npm authentication

The release workflow is prepared for npm trusted publishing from organization
`wasm-oj`, repository `forge`, workflow `release.yml`, and GitHub environment
`npm`. Trusted publishing is the steady-state credential: it exchanges GitHub's
short-lived OIDC identity and publishes provenance without storing an npm token.

The first package publication must bootstrap the npm package identity. During
that one release only, store a publish-capable granular token as the `NPM_TOKEN`
secret on the `npm` environment. After `@wasm-oj/forge` exists, configure the
trusted publisher in npm and delete that secret. The workflow deliberately
supports both states so the published artifact and verification path do not
change during the credential migration.

## Cutting a release

1. Update `version` and `CHANGELOG.md` in the same pull request.
2. Merge only after the required `CI / verify` check succeeds on `main`.
3. Confirm the canonical conformance matrix binds the release commit with
   `pnpm run conformance:verify`.
4. Create and push one annotated tag, for example `git tag -a v0.1.0 -m v0.1.0`
   followed by `git push origin v0.1.0`.
5. Monitor the `Release` workflow. Do not publish the same version manually.
6. Verify the npm provenance statement, GitHub artifact attestation, attached
   tarball checksum, and generated release notes.

The tag is the only release trigger. There is no manual dispatch, alternate
branch, or unverified local-publish fallback.
