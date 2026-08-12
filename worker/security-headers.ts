import type { WasmOjWorkerEnv } from "./env";

function cspNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export async function withSecurityHeaders(response: Response, env: WasmOjWorkerEnv, nonce = cspNonce()): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("X-Frame-Options", "DENY");
  if (headers.get("content-type")?.toLowerCase().startsWith("text/html")) {
    if (!/^[A-Za-z0-9+/]{32}$/.test(nonce)) throw new TypeError("HTML CSP nonce is invalid.");
    const source = await response.text();
    if (/<script\b[^>]*\bnonce\s*=/iu.test(source)) throw new TypeError("Rendered HTML already contains a script nonce.");
    const html = source.replace(/<script(?=[\s>])/giu, `<script nonce="${nonce}"`);
    headers.set("Content-Security-Policy", [
      "default-src 'self'", "base-uri 'none'", "connect-src 'self' https:", "font-src 'self' data:", "form-action 'self'",
      "frame-src 'self'", "frame-ancestors 'none'", "img-src 'self' data: https://avatars.githubusercontent.com",
      "manifest-src 'self'", "media-src 'none'", "object-src 'none'",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
      "style-src 'self' 'unsafe-inline'", "worker-src 'self' blob:",
    ].join("; "));
    headers.set("Cache-Control", "private, no-store");
    headers.delete("Content-Length");
    headers.delete("ETag");
    return new Response(html, { status: response.status, statusText: response.statusText, headers });
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    ...(response.webSocket ? { webSocket: response.webSocket } : {}),
  });
}
