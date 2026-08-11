# Releasing the npm package

The npm package release is intentionally small.

1. Update the version and changelog.
2. Run `pnpm run ci:verify`.
3. Create and push an annotated `vX.Y.Z` tag.
4. Approve the `npm` GitHub Environment.

The Release workflow installs the pinned Node and pnpm versions, runs the normal CI command,
publishes through npm trusted publishing, and creates GitHub release notes. It does not build a
second artifact evidence chain or upload a duplicate attestation bundle.

If publishing succeeds but GitHub release creation fails, create the GitHub release manually for
the same immutable tag. Never move an existing release tag.
