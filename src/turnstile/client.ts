export type TurnstileAction = "official-submit" | "organizer-application";

interface TurnstileSuccessMessage {
  readonly type: "wasm-oj-platform/turnstile/v1";
  readonly action: TurnstileAction;
  readonly nonce: string;
  readonly token: string;
}

interface TurnstileFailureMessage {
  readonly type: "wasm-oj-platform/turnstile-error/v1";
  readonly action: TurnstileAction;
  readonly nonce: string;
  readonly code: "turnstile-failed" | "turnstile-expired";
}

const TOKEN_MAXIMUM_BYTES = 2_048;
const CHALLENGE_TIMEOUT_MS = 270_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseTurnstileMessage(
  value: unknown,
  expectedAction: TurnstileAction,
  expectedNonce: string,
): TurnstileSuccessMessage | TurnstileFailureMessage | undefined {
  const message = record(value);
  if (!message || message.action !== expectedAction || message.nonce !== expectedNonce) return undefined;
  if (
    message.type === "wasm-oj-platform/turnstile/v1"
    && typeof message.token === "string"
    && message.token.length > 0
    && new TextEncoder().encode(message.token).byteLength <= TOKEN_MAXIMUM_BYTES
    && !/[\u0000-\u0020\u007f]/.test(message.token)
  ) {
    return message as unknown as TurnstileSuccessMessage;
  }
  if (
    message.type === "wasm-oj-platform/turnstile-error/v1"
    && (message.code === "turnstile-failed" || message.code === "turnstile-expired")
  ) {
    return message as unknown as TurnstileFailureMessage;
  }
  return undefined;
}

export async function requestWasmOjTurnstileToken(
  action: TurnstileAction,
): Promise<string> {
  const challengeOrigin = window.location.origin;
  const nonce = crypto.randomUUID();
  if (!UUID.test(nonce)) throw new Error("The browser did not produce a valid challenge nonce.");
  const challengeUrl = new URL("/turnstile/challenge", challengeOrigin);
  challengeUrl.searchParams.set("action", action);
  challengeUrl.searchParams.set("nonce", nonce);

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const overlay = document.createElement("div");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "WASM-OJ Turnstile verification");
  Object.assign(overlay.style, {
    alignItems: "center",
    background: "rgb(0 0 0 / 68%)",
    display: "flex",
    inset: "0",
    justifyContent: "center",
    padding: "16px",
    position: "fixed",
    zIndex: "2147483647",
  });
  const panel = document.createElement("div");
  Object.assign(panel.style, {
    background: "Canvas",
    border: "1px solid ButtonBorder",
    borderRadius: "12px",
    boxShadow: "0 20px 60px rgb(0 0 0 / 35%)",
    color: "CanvasText",
    maxWidth: "440px",
    overflow: "hidden",
    position: "relative",
    width: "100%",
  });
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close verification";
  close.setAttribute("aria-label", "Close Turnstile verification");
  Object.assign(close.style, {
    background: "ButtonFace",
    border: "1px solid ButtonBorder",
    borderRadius: "6px",
    color: "ButtonText",
    cursor: "pointer",
    insetInlineEnd: "10px",
    padding: "6px 9px",
    position: "absolute",
    top: "10px",
    zIndex: "1",
  });
  const frame = document.createElement("iframe");
  frame.src = challengeUrl.toString();
  frame.title = "Cloudflare Turnstile verification";
  frame.referrerPolicy = "no-referrer";
  frame.sandbox.add("allow-forms", "allow-same-origin", "allow-scripts");
  Object.assign(frame.style, { border: "0", display: "block", height: "540px", width: "100%" });
  panel.appendChild(close);
  panel.appendChild(frame);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  close.focus();

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (result: { readonly token: string } | { readonly error: Error }): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(timeout);
      overlay.remove();
      previousFocus?.focus();
      if ("token" in result) resolve(result.token);
      else reject(result.error);
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== challengeOrigin || event.source !== frame.contentWindow) return;
      const message = parseTurnstileMessage(event.data, action, nonce);
      if (!message) return;
      if (message.type === "wasm-oj-platform/turnstile/v1") finish({ token: message.token });
      else finish({ error: new Error(message.code === "turnstile-expired"
        ? "Turnstile expired before submission. Try again."
        : "Turnstile could not verify this request. Try again.") });
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") finish({ error: new Error("Turnstile was closed before verification completed.") });
    };
    close.addEventListener("click", () => finish({ error: new Error("Turnstile was closed before verification completed.") }), { once: true });
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKeyDown);
    const timeout = window.setTimeout(() => {
      finish({ error: new Error("Turnstile verification timed out. Try again.") });
    }, CHALLENGE_TIMEOUT_MS);
  });
}
