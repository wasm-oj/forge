# Browser dependency network consent

WASM-OJ never grants dependency resolvers implicit network access. Online resolution requires:

1. a `DependencyNetworkAuthorizer` supplied to `createBrowserEngine()` or a dependency manager;
   and
2. `networkAccess` on each resolution containing the normalized repository source key, immutable
   problem-bundle SHA-256, and complete public DNS host set.

`BrowserDependencyNetworkConsent` stores approval under the source key plus bundle digest. The
first request prompts with the complete host set; adding a host or changing the bundle prompts
again. Resolution fails before `fetch` when approval is missing, denied, malformed, or excludes a
URL returned by package metadata. URLs must be credential-free HTTPS without query strings or
fragments; redirects, localhost, IP literals, and private/special local hostnames are rejected.

An existing verified lock may be reused after a genuine transport rejection only when the
manifest still matches, `previousLockNetworkScope` equals the current source/bundle identity, and
every locked payload passes cache verification. HTTP errors, malformed metadata, integrity
failures, byte-limit failures, and stream failures do not fall back to cache. Explicit offline mode
uses `offline: true` and never invokes a resolver network transport.

The current Judge product does not invent repository context or placeholder approval. A dependency
UI must derive the real source key and verified bundle digest from the loaded collection, enumerate
the complete host set, show it to the user, and only then call `resolveDependencies()`.

Official Submit accepts canonical source inputs only. Judge Containers have no public dependency
network access.
