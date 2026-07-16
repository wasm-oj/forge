export async function registerToolchainCache(): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in navigator)) return undefined;
  const registration = await navigator.serviceWorker.register("/toolchain-cache-sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  return registration;
}

export async function clearToolchainResponseCache(): Promise<void> {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((name) => name.startsWith("localwasi-toolchains-"))
      .map((name) => caches.delete(name)),
  );
}
