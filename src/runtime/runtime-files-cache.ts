import { verifyAndDecodeRuntimeFiles } from "../runner/runtime-files";

export type RuntimeFilesCacheIssueReporter = (message: string, error: unknown) => void;

interface RuntimeFilesCacheRequest {
  cacheRequest: Request;
  cacheKey: string;
  expectedSha256: string;
}

const defaultIssueReporter: RuntimeFilesCacheIssueReporter = (message, error) => {
  console.warn(`[ForgeRunner] ${message}`, error);
};

export async function openOptionalRuntimeFilesCache(
  storage: CacheStorage,
  cacheName: string,
  reportIssue: RuntimeFilesCacheIssueReporter = defaultIssueReporter,
): Promise<Cache | undefined> {
  try {
    return await storage.open(cacheName);
  } catch (error) {
    reportIssue("Unable to open the optional runtime-files cache; continuing without it.", error);
    return undefined;
  }
}

export async function restoreOrExportRuntimeFiles(
  cache: Cache | undefined,
  request: RuntimeFilesCacheRequest,
  exportArchive: () => Promise<Uint8Array>,
  reportIssue: RuntimeFilesCacheIssueReporter = defaultIssueReporter,
): Promise<Record<string, Uint8Array>> {
  if (cache) {
    const restored = await restoreRuntimeFiles(cache, request, reportIssue);
    if (restored) return restored;
  }

  const archive = await exportArchive();
  const files = await verifyAndDecodeRuntimeFiles(archive, request.expectedSha256);
  if (cache) await persistRuntimeFiles(cache, request, archive, reportIssue);
  return files;
}

async function restoreRuntimeFiles(
  cache: Cache,
  request: RuntimeFilesCacheRequest,
  reportIssue: RuntimeFilesCacheIssueReporter,
): Promise<Record<string, Uint8Array> | undefined> {
  let cached: Response | undefined;
  try {
    cached = await cache.match(request.cacheRequest);
  } catch (error) {
    reportIssue("Unable to read the optional runtime-files cache; exporting a fresh archive.", error);
    return undefined;
  }
  if (!cached) return undefined;

  try {
    const archive = new Uint8Array(await cached.arrayBuffer());
    const files = await verifyAndDecodeRuntimeFiles(archive, request.expectedSha256);
    await persistRuntimeFiles(cache, request, archive, reportIssue);
    return files;
  } catch (error) {
    reportIssue("Ignoring an invalid runtime-files cache archive; exporting a fresh archive.", error);
    try {
      await cache.delete(request.cacheRequest);
    } catch (deleteError) {
      reportIssue("Unable to delete the invalid runtime-files cache archive.", deleteError);
    }
    return undefined;
  }
}

async function persistRuntimeFiles(
  cache: Cache,
  request: RuntimeFilesCacheRequest,
  archive: Uint8Array,
  reportIssue: RuntimeFilesCacheIssueReporter,
): Promise<void> {
  try {
    await cache.put(
      request.cacheRequest,
      new Response(Uint8Array.from(archive).buffer, {
        headers: {
          "Content-Type": "application/vnd.wasm-oj.forge.runtime-files",
          "X-WASM-OJ-Forge-Cache-Key": request.cacheKey,
          "X-WASM-OJ-Forge-Byte-Length": String(archive.byteLength),
          "X-WASM-OJ-Forge-Cached-At": String(Date.now()),
        },
      }),
    );
  } catch (error) {
    reportIssue("Unable to persist the verified runtime-files archive; continuing without cache persistence.", error);
  }
}
