import { init as initializeModuleLexer, ImportType, parse } from "es-module-lexer";
import { sha256Hex } from "../core/hash";
import type { BrowserRuntimeDriverPlugin } from "../core/types";
import type { RuntimeDriver } from "../runner/artifact";

export type { BrowserRuntimeDriverPlugin } from "../core/types";

export const BROWSER_RUNTIME_PLUGIN_LIMITS = Object.freeze({
  count: 16,
  sourceBytes: 1024 * 1024,
});

const DEFAULT_FACTORY_EXPORT = "createRuntimeDriver";
const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function validateBrowserRuntimeDriverPlugins(
  plugins: readonly BrowserRuntimeDriverPlugin[],
  baseUrl: string,
): BrowserRuntimeDriverPlugin[] {
  if (!Array.isArray(plugins)) throw new TypeError("Browser runtime-driver plug-ins must be an array.");
  if (plugins.length > BROWSER_RUNTIME_PLUGIN_LIMITS.count) {
    throw new RangeError(`At most ${BROWSER_RUNTIME_PLUGIN_LIMITS.count} browser runtime-driver plug-ins are allowed.`);
  }
  if (plugins.length === 0) return [];

  const base = validHttpUrl(baseUrl, "Browser runtime-driver plug-in base URL");
  const ids = new Set<string>();
  return plugins.map((plugin, index) => {
    if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) {
      throw new TypeError(`Browser runtime-driver plug-in ${index} must be an object.`);
    }
    const id = canonicalIdentifier(plugin.id, `Browser runtime-driver plug-in ${index} ID`);
    if (ids.has(id)) throw new Error(`Browser runtime-driver plug-in '${id}' is declared more than once.`);
    ids.add(id);
    if (typeof plugin.moduleUrl !== "string" || !plugin.moduleUrl || plugin.moduleUrl !== plugin.moduleUrl.trim()) {
      throw new TypeError(`Browser runtime-driver plug-in '${id}' moduleUrl must be a non-empty trimmed string.`);
    }
    const moduleUrl = validHttpUrl(new URL(plugin.moduleUrl, base).href, `Browser runtime-driver plug-in '${id}' module URL`);
    if (moduleUrl.origin !== base.origin) {
      throw new Error(`Browser runtime-driver plug-in '${id}' must be loaded from ${base.origin}.`);
    }
    if (moduleUrl.username || moduleUrl.password || moduleUrl.hash) {
      throw new Error(`Browser runtime-driver plug-in '${id}' URL cannot contain credentials or a fragment.`);
    }
    if (typeof plugin.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(plugin.sha256)) {
      throw new Error(`Browser runtime-driver plug-in '${id}' SHA-256 must be lowercase hexadecimal.`);
    }
    const exportName = canonicalExportName(plugin.exportName ?? DEFAULT_FACTORY_EXPORT, id);
    return Object.freeze({
      id,
      moduleUrl: moduleUrl.href,
      sha256: plugin.sha256,
      ...(exportName === DEFAULT_FACTORY_EXPORT ? {} : { exportName }),
    });
  });
}

/** Load trusted, content-pinned host extensions inside the runner Worker. */
export async function loadBrowserRuntimeDriverPlugins(
  plugins: readonly BrowserRuntimeDriverPlugin[],
  baseUrl: string,
): Promise<RuntimeDriver[]> {
  const validated = validateBrowserRuntimeDriverPlugins(plugins, baseUrl);
  await initializeModuleLexer;
  const drivers: RuntimeDriver[] = [];
  for (const plugin of validated) drivers.push(await loadPlugin(plugin));
  return drivers;
}

async function loadPlugin(plugin: BrowserRuntimeDriverPlugin): Promise<RuntimeDriver> {
  const response = await fetch(plugin.moduleUrl, {
    cache: "force-cache",
    credentials: "same-origin",
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Unable to load browser runtime-driver plug-in '${plugin.id}' (${response.status}).`);
  }
  const sourceBytes = await readBoundedSource(response, plugin.id);
  const digest = await sha256Hex(sourceBytes);
  if (digest !== plugin.sha256) {
    throw new Error(
      `Browser runtime-driver plug-in '${plugin.id}' has digest ${digest}; expected ${plugin.sha256}.`,
    );
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  assertSelfContainedModule(source, plugin.id);

  const moduleBytes = new Uint8Array(sourceBytes.byteLength);
  moduleBytes.set(sourceBytes);
  const objectUrl = URL.createObjectURL(new Blob([moduleBytes.buffer], { type: "text/javascript" }));
  try {
    const namespace = await import(/* @vite-ignore */ objectUrl) as Record<string, unknown>;
    const exportName = plugin.exportName ?? DEFAULT_FACTORY_EXPORT;
    const factory = namespace[exportName];
    if (typeof factory !== "function") {
      throw new TypeError(`Browser runtime-driver plug-in '${plugin.id}' must export function '${exportName}'.`);
    }
    const driver = await (factory as () => RuntimeDriver | Promise<RuntimeDriver>)();
    assertPluginDriver(driver, plugin.id);
    return driver;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function readBoundedSource(response: Response, id: string): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > BROWSER_RUNTIME_PLUGIN_LIMITS.sourceBytes)) {
    throw new RangeError(
      `Browser runtime-driver plug-in '${id}' exceeds ${BROWSER_RUNTIME_PLUGIN_LIMITS.sourceBytes} source bytes.`,
    );
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertSourceSize(bytes.byteLength, id);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      assertSourceSize(total, id);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertSourceSize(size: number, id: string): void {
  if (size > BROWSER_RUNTIME_PLUGIN_LIMITS.sourceBytes) {
    throw new RangeError(
      `Browser runtime-driver plug-in '${id}' exceeds ${BROWSER_RUNTIME_PLUGIN_LIMITS.sourceBytes} source bytes.`,
    );
  }
}

function assertSelfContainedModule(source: string, id: string): void {
  const [imports] = parse(source, id);
  const externalImport = imports.find((specifier) => specifier.t !== ImportType.ImportMeta);
  if (externalImport) {
    throw new Error(
      `Browser runtime-driver plug-in '${id}' must be self-contained and cannot import another module.`,
    );
  }
}

function assertPluginDriver(driver: unknown, id: string): asserts driver is RuntimeDriver {
  if (!driver || typeof driver !== "object" || Array.isArray(driver)) {
    throw new TypeError(`Browser runtime-driver plug-in '${id}' factory must return a RuntimeDriver object.`);
  }
  const candidate = driver as Partial<RuntimeDriver>;
  if (candidate.id !== id) {
    throw new Error(`Browser runtime-driver plug-in '${id}' returned driver ID '${String(candidate.id)}'.`);
  }
  if (typeof candidate.supports !== "function" || typeof candidate.prepare !== "function") {
    throw new TypeError(`Browser runtime-driver plug-in '${id}' must implement supports() and prepare().`);
  }
  if (candidate.interactive !== undefined && candidate.interactive !== "streaming") {
    throw new Error(`Browser runtime-driver plug-in '${id}' has an invalid interactive capability.`);
  }
}

function canonicalIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 128) {
    throw new Error(`${label} must be non-empty, trimmed, and at most 128 characters.`);
  }
  return value;
}

function canonicalExportName(value: unknown, id: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value) || value.length > 128) {
    throw new Error(`Browser runtime-driver plug-in '${id}' exportName must be an ASCII JavaScript identifier.`);
  }
  return value;
}

function validHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  return url;
}
