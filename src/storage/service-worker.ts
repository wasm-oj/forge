export interface ToolchainCacheRegistrationOptions {
  /** Same-origin URL where the package's exported service-worker asset is served. */
  scriptUrl?: string | URL;
  /** Service-worker scope covering the configured Forge toolchain asset base URL. */
  scope?: string;
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
  const registration = await navigator.serviceWorker.register(scriptUrl, { scope });
  await waitForActiveWorker(registration);
  return registration;
}

function waitForActiveWorker(registration: ServiceWorkerRegistration): Promise<void> {
  if (registration.active?.state === "activated") return Promise.resolve();
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) {
    return Promise.reject(new Error("Forge toolchain cache registration has no service-worker instance."));
  }
  return new Promise((resolve, reject) => {
    const onStateChange = () => {
      if (worker.state === "activated") {
        worker.removeEventListener("statechange", onStateChange);
        resolve();
      } else if (worker.state === "redundant") {
        worker.removeEventListener("statechange", onStateChange);
        reject(new Error("Forge toolchain cache service worker became redundant before activation."));
      }
    };
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
}
