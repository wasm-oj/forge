# Security Policy

## Supported releases

Only the latest published `0.x` release receives security fixes while Forge is
experimental. A newer release replaces, rather than extends, an affected
experimental release unless its public contract explicitly says otherwise.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting flow for `wasm-oj/forge` and include:

- the affected package version and host (`browser` or `server`);
- the smallest reproducible project, artifact, or replay bundle;
- the violated sandbox, determinism, integrity, or confidentiality invariant;
- whether untrusted source, dependency, runtime plug-in, or Wasm bytes are
  required to trigger the problem.

Forge executes hostile programs and package contents by design. Resource-limit
termination, rejected unsigned assets, unavailable capabilities, and local test
data visibility are expected behavior unless they violate the documented
[host integration contract](docs/host-integration-contract.md).
