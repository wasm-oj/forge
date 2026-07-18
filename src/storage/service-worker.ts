export interface ToolchainCacheRegistrationOptions {
  /** Same-origin URL where the package's exported service-worker asset is served. */
  scriptUrl?: string | URL;
  /** Service-worker scope covering the configured Forge toolchain asset base URL. */
  scope?: string;
  /** Build-generated, same-origin chunk manifest used only by size-limited static deployments. */
  chunkManifestUrl?: string | URL;
}

export async function registerToolchainCache(
  options: ToolchainCacheRegistrationOptions = {},
): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
  const scriptUrl = options.scriptUrl ?? "/toolchain-cache-sw.js";
  const scope = options.scope ?? "/";
  if (typeof scope !== "string" || !scope) {
    throw new TypeError("Forge toolchain cache service-worker scope must be a non-empty string.");
  }
  const registration = await navigator.serviceWorker.register(scriptUrl, {
    scope,
    updateViaCache: "none",
  });
  const worker = await waitForActiveWorker(registration);
  await configureChunkManifest(worker, options.chunkManifestUrl);
  return registration;
}

async function configureChunkManifest(
  worker: ServiceWorker,
  manifestUrl: string | URL | undefined,
): Promise<void> {
  let manifestPath: string | null = null;
  if (manifestUrl !== undefined) {
    const url = new URL(manifestUrl, location.href);
    if (url.origin !== location.origin || url.search || url.hash
      || url.pathname !== "/toolchains/forge-sites-chunks.json") {
      throw new Error("Forge toolchain chunk manifest must use the canonical same-origin deployment path.");
    }
    manifestPath = url.pathname;
  }
  const channel = new MessageChannel();
  const response = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Forge toolchain chunk configuration timed out.")), 5_000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      clearTimeout(timeout);
      channel.port1.close();
      if (event.data && typeof event.data === "object" && "ok" in event.data && event.data.ok === true) resolve();
      else reject(new Error("Forge toolchain cache service worker rejected its chunk manifest configuration."));
    };
  });
  worker.postMessage(
    { type: "configure-toolchain-chunks", path: manifestPath },
    [channel.port2],
  );
  await response;
}

function waitForActiveWorker(registration: ServiceWorkerRegistration): Promise<ServiceWorker> {
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) {
    return Promise.reject(new Error("Forge toolchain cache registration has no service-worker instance."));
  }
  if (worker.state === "activated") return Promise.resolve(worker);
  return new Promise<ServiceWorker>((resolve, reject) => {
    const onStateChange = () => {
      if (worker.state === "activated") {
        worker.removeEventListener("statechange", onStateChange);
        resolve(worker);
      } else if (worker.state === "redundant") {
        worker.removeEventListener("statechange", onStateChange);
        reject(new Error("Forge toolchain cache service worker became redundant before activation."));
      }
    };
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
}
