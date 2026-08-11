import type { ForgeWorkerEnv } from "./env";

type ForgeTurnstileAction = "official-submit" | "organizer-application";

export const TURNSTILE_CHALLENGE_PATH = "/turnstile/challenge";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIONS = new Set<ForgeTurnstileAction>(["official-submit", "organizer-application"]);

function exactApplicationOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || value !== url.origin
  ) {
    throw new TypeError("PUBLIC_ORIGIN must be an exact credential-free HTTP(S) origin.");
  }
  return url.origin;
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function baseHeaders(contentType: string): Headers {
  return new Headers({
    "cache-control": "no-store, max-age=0",
    "content-type": contentType,
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function errorResponse(status: number): Response {
  return new Response("Challenge request rejected.\n", { status, headers: baseHeaders("text/plain; charset=utf-8") });
}

function challengeDocument(appOrigin: string, siteKey: string, action: ForgeTurnstileAction, requestNonce: string): Response {
  const cspNonce = crypto.randomUUID().replaceAll("-", "");
  const headers = baseHeaders("text/html; charset=utf-8");
  headers.set("content-security-policy", [
    "default-src 'none'",
    `script-src 'nonce-${cspNonce}' 'strict-dynamic'`,
    `style-src 'nonce-${cspNonce}'`,
    "frame-src https://challenges.cloudflare.com",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    "object-src 'none'",
  ].join("; "));
  const configuration = JSON.stringify({ appOrigin, action, requestNonce }).replaceAll("<", "\\u003c");
  const document = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Forge verification</title>
  <style nonce="${cspNonce}">
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { align-items: center; display: grid; margin: 0; min-height: 100vh; padding: 24px; }
    main { margin: auto; max-width: 360px; text-align: center; }
    h1 { font-size: 1.15rem; }
    p { color: #737373; line-height: 1.5; }
    #forge-turnstile { display: flex; justify-content: center; min-height: 70px; }
  </style>
  <script nonce="${cspNonce}">
    "use strict";
    const configuration = ${configuration};
    const send = (value) => {
      if (window.parent !== window) window.parent.postMessage(value, configuration.appOrigin);
    };
    window.forgeTurnstileDone = (token) => {
      send({ type: "forge-turnstile-v1", action: configuration.action, nonce: configuration.requestNonce, token });
      window.setTimeout(() => window.close(), 150);
    };
    window.forgeTurnstileFailed = () => send({ type: "forge-turnstile-error-v1", action: configuration.action, nonce: configuration.requestNonce, code: "turnstile-failed" });
    window.forgeTurnstileExpired = () => send({ type: "forge-turnstile-error-v1", action: configuration.action, nonce: configuration.requestNonce, code: "turnstile-expired" });
  </script>
  <script nonce="${cspNonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>
</head>
<body>
  <main>
    <h1>Verify this Forge action</h1>
    <p>This window sends only a one-time challenge token back to Forge.</p>
    <div id="forge-turnstile" class="cf-turnstile" data-sitekey="${htmlEscape(siteKey)}" data-action="${action}" data-callback="forgeTurnstileDone" data-error-callback="forgeTurnstileFailed" data-expired-callback="forgeTurnstileExpired"></div>
  </main>
</body>
</html>
`;
  return new Response(document, { headers });
}

export function turnstileChallengeResponse(request: Request, env: ForgeWorkerEnv): Response {
  if (request.method !== "GET") return errorResponse(405);
  const url = new URL(request.url);
  if (
    url.pathname !== TURNSTILE_CHALLENGE_PATH
    || [...url.searchParams.keys()].some((key) => key !== "action" && key !== "nonce")
  ) return errorResponse(404);
  const action = url.searchParams.get("action") as ForgeTurnstileAction | null;
  const requestNonce = url.searchParams.get("nonce");
  if (!action || !ACTIONS.has(action) || !requestNonce || !UUID.test(requestNonce)) return errorResponse(400);
  const appOrigin = exactApplicationOrigin(env.PUBLIC_ORIGIN);
  if (url.origin !== appOrigin || !env.TURNSTILE_SITE_KEY || env.TURNSTILE_SITE_KEY.length > 256) return errorResponse(500);
  return challengeDocument(appOrigin, env.TURNSTILE_SITE_KEY, action, requestNonce);
}
