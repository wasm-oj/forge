# Release contract

Forge releases are immutable npm packages and matching GitHub Releases. The
package currently uses experimental SemVer `0.x`; that does not change the
single `wasm-oj-forge-v1` compiler, runner, judge, replay, and evidence contract.

## Automation boundary

- `.github/workflows/ci.yml` runs on every `main` push and pull request. It
  verifies pnpm policy, conformance provenance, types, lint, tests, the packed
  browser/server consumers, the production site, native runtime tests, and the
  web runtime target.
- `.github/workflows/release.yml` normally runs for a `vMAJOR.MINOR.PATCH` tag.
  An explicit manual dispatch may resume one existing annotated tag; it cannot
  substitute a branch or a different commit. The workflow repeats the full CI
  gate without a dependency cache and checks that the tag is exactly
  `v${package.version}`.
- The packed source artifact is a release candidate. After publication, the
  workflow downloads the immutable npm `dist.tarball`, verifies its SHA-1 and
  SHA-512 registry metadata, and requires its complete uncompressed tar payload
  to equal the candidate. This deliberately permits harmless gzip-header
  differences between operating systems without permitting any package-content
  difference.
- The exact registry bytes are the canonical artifact. Only those bytes receive
  the SHA-256 sidecar, GitHub build attestation, and GitHub Release attachment.
  A rerun verifies the existing attachment names, uploaded state, byte lengths,
  and GitHub SHA-256 digests before reusing them. Exact matches skip the large
  upload; absent or different assets are replaced. A rerun therefore remains
  idempotent even when the package version and GitHub Release already exist.

Every action dependency is pinned to an immutable commit. Workflows use the
minimum permissions declared by each job. The release job is attached to the
`npm` GitHub environment and requires `contents: write`, `id-token: write`, and
`attestations: write`; normal CI has read-only repository access.

## npm authentication

The release workflow is prepared for npm trusted publishing from organization
`wasm-oj`, repository `forge`, workflow `release.yml`, and GitHub environment
`npm`. Trusted publishing is the steady-state credential: it exchanges GitHub's
short-lived OIDC identity and publishes provenance without storing an npm token.

The first package publication must bootstrap the npm package identity because
npm does not accept a trusted-publisher relationship for a package that does
not yet exist. Pack and verify the tagged candidate locally, publish that exact
file with an interactive npm session, configure the trusted publisher
immediately, and manually dispatch the same tag. The resumed workflow downloads
the just-published registry bytes, proves payload equivalence, and completes the
normal attestation and GitHub Release path. No npm token is stored in GitHub.

## Cutting a release

1. Update `version` and `CHANGELOG.md` in the same pull request.
2. Merge only after the required `CI / verify` check succeeds on `main`.
3. Confirm the canonical conformance matrix binds the release commit with
   `pnpm run conformance:verify`.
4. Create and push one annotated tag, for example `git tag -a v0.1.0 -m v0.1.0`
   followed by `git push origin v0.1.0`.
5. Monitor the `Release` workflow. For a recovery, dispatch `Release` with the
   exact existing tag; never move or recreate the tag.
6. Verify registry integrity, the GitHub artifact attestation, attached tarball
   checksum, generated release notes, and npm provenance for every
   trusted-publisher release after the one-time bootstrap.

Manual dispatch is a recovery entry point, not an alternate release identity.
Both triggers check out and verify the immutable tag. The one interactive npm
publication described above is permitted only to create a package identity that
npm requires before trusted publishing can be configured.
