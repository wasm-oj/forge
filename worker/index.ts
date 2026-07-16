import handler from "vinext/server/app-router-entry";

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface Env {
  ASSETS: Fetcher;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const STATIC_FILES = new Set(["/favicon.svg", "/og.png", "/toolchain-cache-sw.js"]);

function isStaticAsset(pathname: string): boolean {
  return pathname.startsWith("/assets/") || pathname.startsWith("/toolchains/") || STATIC_FILES.has(pathname);
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const response = isStaticAsset(pathname)
      ? await env.ASSETS.fetch(request)
      : await handler.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Embedder-Policy", "credentialless");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

export default worker;
