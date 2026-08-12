# Releasing the npm packages

WASM-OJ publishes six synchronized code packages and five independently versioned toolchain
packages. The repository remains `wasm-oj/forge`; package metadata must keep that repository,
homepage, and issue URL until a separate repository migration is approved.

## Synchronized SDK release

The following packages always share one exact version:

1. `@wasm-oj/contracts`
2. `@wasm-oj/core`
3. `@wasm-oj/browser`, `@wasm-oj/server`, and `@wasm-oj/organizer`
4. `@wasm-oj/sdk`

Update `CODE_VERSION` in `scripts/library-packages.mjs`, the private root version and exact
workspace dependency specs, all six package manifests (including their exact internal dependency
specs), and the changelog. Then run:

```sh
pnpm install --lockfile-only
pnpm run library:build
pnpm run library:verify
pnpm run ci:verify
```

Create and push an annotated `vX.Y.Z` tag whose version exactly matches all six manifests. The
Release workflow uses npm trusted publishing, checks the tag against every code package, packs
verified tarballs with pnpm, and publishes those exact tarballs with npm's OIDC-aware CLI in the
dependency order above. Node 24.18.0 supplies npm 11.16.0, which satisfies trusted publishing's
npm 11.5.1 minimum. The root `wasm-oj-platform` manifest is private and is never published. The
umbrella package contains only code entrypoints and never depends on a toolchain package.

If npm publishing succeeds but GitHub release creation fails, create the GitHub release manually
for the same immutable tag. Never move an existing release tag and never rerun a partial release
with changed bytes at the same version.

## Independent toolchain release

Toolchains are separate asset packages:

- `@wasm-oj/toolchain-clang`
- `@wasm-oj/toolchain-rust`
- `@wasm-oj/toolchain-go`
- `@wasm-oj/toolchain-python`
- `@wasm-oj/toolchain-javascript`

Increment only the package whose descriptor or asset bytes changed, plus its exact root workspace
dependency spec, and refresh the lockfile. Regenerate its contract-2 manifest and pinned digests,
run its existing toolchain verification, then invoke the “Release one npm toolchain package”
workflow with the exact package and version. The workflow builds and packs only that package before
trusted publishing. The package semver and descriptor's compiler/toolchain version are independent
identities; change each only when its corresponding contract changes.

Each descriptor binds the contract version, languages, profiles, exact logical asset path, byte
length, SHA-256, and export subpath. `browserSource(baseUrl)` requires an explicit absolute or
root-relative HTTP asset directory; `serverSource()` resolves the installed package's read-only
asset directory. Missing assets, mismatched size or digest, unregistered languages, and retired
contract identifiers fail closed. There is no CDN, filesystem search, or bundled fallback.

## First publish and trusted-publisher setup

npm only lets a maintainer configure a trusted publisher after a package name exists. Bootstrap
each new package name once with an owner-authenticated manual publish of the verified tarball, then
configure its npm trusted publisher for this repository and the exact workflow filename:

- synchronized code packages: `release.yml`
- toolchain packages: `release-toolchain.yml`

Require the `npm` GitHub environment for both workflows. After the trust relationships are active,
revoke the bootstrap credential and use only the workflows for later versions. A toolchain release
also requires its declared exact `@wasm-oj/contracts` version to have been published already.
