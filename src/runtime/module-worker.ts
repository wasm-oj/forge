export type ModuleWorkerOptions = Omit<WorkerOptions, "type">;

interface ModuleWorkerGlobal {
  __wasmOjForgeModuleWorkerBaseUrl?: unknown;
}

/**
 * Starts an emitted module Worker through a same-origin blob bootstrap.
 *
 * Some production hosts apply COOP/COEP to application responses but serve
 * immutable assets outside that response pipeline. Loading the emitted asset
 * directly as a Worker is then blocked before its module fetch can use CORS.
 * A blob bootstrap keeps the Worker entry same-origin while its module import
 * loads the content-addressed entry with the normal module-script policy.
 */
export function createModuleWorker(
  scriptUrl: string | URL,
  options: ModuleWorkerOptions = {},
): Worker {
  const baseUrl = moduleWorkerBaseUrl();
  const absoluteScriptUrl = resolveModuleWorkerUrl(scriptUrl);
  const bootstrap = new Blob(
    [
      "const pendingMessages = [];\n",
      "const queueMessage = (event) => { event.stopImmediatePropagation(); pendingMessages.push(event.data); };\n",
      'globalThis.addEventListener("message", queueMessage);\n',
      `Object.defineProperty(globalThis, "__wasmOjForgeModuleWorkerBaseUrl", { value: ${JSON.stringify(baseUrl.href)} });\n`,
      `try { await import(${JSON.stringify(absoluteScriptUrl)}); } finally { globalThis.removeEventListener("message", queueMessage); }\n`,
      'for (const data of pendingMessages) globalThis.dispatchEvent(new MessageEvent("message", { data }));\n',
    ],
    { type: "text/javascript" },
  );
  const bootstrapUrl = URL.createObjectURL(bootstrap);
  try {
    return new Worker(bootstrapUrl, { ...options, type: "module" });
  } finally {
    URL.revokeObjectURL(bootstrapUrl);
  }
}

export function moduleWorkerBaseUrl(): URL {
  const locationHref = globalThis.location?.href;
  if (locationHref) {
    const locationUrl = new URL(locationHref);
    if (locationUrl.protocol === "http:" || locationUrl.protocol === "https:") return locationUrl;
    if (locationUrl.protocol !== "blob:") {
      throw new Error("A module Worker requires an HTTP(S) browser base URL.");
    }
  }

  const injected = (globalThis as ModuleWorkerGlobal).__wasmOjForgeModuleWorkerBaseUrl;
  if (typeof injected !== "string") throw new Error("A module Worker requires a browser base URL.");

  const baseUrl = new URL(injected);
  if (baseUrl.origin === "null" || (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")) {
    throw new Error("A module Worker requires an HTTP(S) browser base URL.");
  }
  return baseUrl;
}

function resolveModuleWorkerUrl(scriptUrl: string | URL): string {
  if (scriptUrl instanceof URL) return scriptUrl.href;
  try {
    return new URL(scriptUrl).href;
  } catch {
    return new URL(scriptUrl, moduleWorkerBaseUrl()).href;
  }
}
