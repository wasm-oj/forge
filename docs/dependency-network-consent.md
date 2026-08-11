# Browser dependency network consent

Forge never grants dependency resolvers implicit network access. Online resolution requires both:

1. a `DependencyNetworkAuthorizer` supplied when the browser `Forge` instance or dependency manager is created; and
2. `networkAccess` on each resolution containing the normalized repository source key, immutable problem-bundle SHA-256, and the complete public DNS host set.

`BrowserDependencyNetworkConsent` stores approval under the source key plus bundle digest. The first request prompts with the complete host set; adding a host or changing the bundle prompts again. Resolution fails before `fetch` when approval is missing, denied, malformed, or does not contain a URL returned by package metadata. URLs must be credential-free HTTPS without query strings or fragments; redirects, localhost, IP literals, and private/special local hostnames are rejected.

An existing verified lock is reused automatically only when `fetch` itself rejects before returning an HTTP response, the manifest still matches, the caller supplies an identical `previousLockNetworkScope` and current `networkAccess` source/bundle identity, and every locked payload passes content-cache verification. HTTP errors, malformed metadata, integrity failures, byte-limit failures, and reader failures never fall back to cache. Explicit offline use remains available through `offline: true`.

The current Judge Studio does not resolve package dependencies and therefore does not invent repository context or show a placeholder prompt. A future dependency UI must derive the real source key and verified bundle digest from the loaded collection, enumerate the complete host set, show it to the user, and only then call `resolveDependencies`. It must not download when any of these values is unavailable.

Official Submit accepts canonical source inputs only, and judge Containers have no public dependency network access.
