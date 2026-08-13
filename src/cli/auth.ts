import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { ApiError, type RemoteClient } from "./http";
import { isWojAccessToken, type TokenStore } from "./keychain";
import { CliError } from "./errors";

export interface BrowserOpener { open(url: string): Promise<void>; }

export class SystemBrowserOpener implements BrowserOpener {
  open(url: string): Promise<void> {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
    const arguments_ = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    return new Promise((resolve, reject) => {
      const child = spawn(command, arguments_, { detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  }
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError(`${label} response has an invalid shape.`, { exitCode: 6 });
  return value as Record<string, unknown>;
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const result = object(value, label);
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...keys].sort())) {
    throw new CliError(`${label} response has an invalid shape.`, { exitCode: 6, code: "server-response-invalid" });
  }
  return result;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new CliError(`${label} response field is invalid.`, { exitCode: 6 });
  return value;
}

function exactBrowserUrl(origin: string, candidate: string, pathname: string, parameter: string, expected: string): string {
  let url: URL;
  try { url = new URL(candidate); }
  catch (error) { throw new CliError("Server browser verification URL is invalid.", { exitCode: 6, code: "verification-url-invalid", cause: error }); }
  const entries = [...url.searchParams.entries()];
  if (
    url.origin !== new URL(origin).origin
    || url.username || url.password || url.hash
    || url.pathname !== pathname
    || entries.length !== 1
    || entries[0]?.[0] !== parameter
    || entries[0]?.[1] !== expected
  ) throw new CliError("Server browser verification URL failed origin or request binding.", { exitCode: 6, code: "verification-url-invalid" });
  return url.toString();
}

export function turnstileVerificationUrl(clientOrigin: string, details: unknown): string {
  const values = exactObject(details, ["requestKey", "verificationUrl"], "Turnstile verification");
  const requestKey = requiredString(values.requestKey, "requestKey");
  if (!/^[0-9a-f]{64}$/.test(requestKey)) throw new CliError("Turnstile request key is invalid.", { exitCode: 6, code: "verification-url-invalid" });
  return exactBrowserUrl(
    clientOrigin,
    requiredString(values.verificationUrl, "verificationUrl"),
    "/auth/cli/turnstile",
    "requestKey",
    requestKey,
  );
}

export interface DeviceLoginOptions {
  readonly deviceName: string;
  readonly onVerification: (verificationUrl: string) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export async function deviceLogin(
  client: RemoteClient,
  tokenStore: TokenStore,
  opener: BrowserOpener,
  options: DeviceLoginOptions,
): Promise<Record<string, unknown>> {
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  const started = exactObject(await client.request("/api/auth/cli/start", {
    method: "POST",
    authenticated: false,
    body: { codeChallenge, deviceName: options.deviceName },
  }), ["flowId", "verificationUrl", "expiresAt", "pollIntervalSeconds"], "CLI login start");
  const flowId = requiredString(started.flowId, "flowId");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(flowId)) {
    throw new CliError("CLI login flow ID is invalid.", { exitCode: 6, code: "server-response-invalid" });
  }
  const verificationUrl = exactBrowserUrl(
    client.origin,
    requiredString(started.verificationUrl, "verificationUrl"),
    "/auth/cli",
    "flow",
    flowId,
  );
  const expiresAt = Date.parse(requiredString(started.expiresAt, "expiresAt"));
  const interval = Number(started.pollIntervalSeconds);
  if (!Number.isFinite(expiresAt) || !Number.isInteger(interval) || interval < 1 || interval > 30) throw new CliError("CLI login timing response is invalid.", { exitCode: 6 });
  options.onVerification(verificationUrl);
  try { await opener.open(verificationUrl); }
  catch (error) { throw new CliError(`Could not open the browser. Visit ${verificationUrl}`, { exitCode: 6, cause: error }); }
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  while (Date.now() < expiresAt) {
    await sleep(interval * 1_000);
    try {
      const exchanged = exactObject(await client.request("/api/auth/cli/token", {
        method: "POST",
        authenticated: false,
        body: { flowId, codeVerifier },
      }), ["accessToken", "tokenType", "expiresAt"], "CLI login token");
      const token = requiredString(exchanged.accessToken, "accessToken");
      if (!isWojAccessToken(token)) throw new CliError("CLI login returned a malformed access token.", { exitCode: 6, code: "server-response-invalid" });
      if (exchanged.tokenType !== "Bearer") throw new CliError("CLI login token type is unsupported.", { exitCode: 6 });
      const tokenExpiresAt = requiredString(exchanged.expiresAt, "expiresAt");
      if (Number.isNaN(Date.parse(tokenExpiresAt)) || new Date(tokenExpiresAt).toISOString() !== tokenExpiresAt) {
        throw new CliError("CLI login token expiry is invalid.", { exitCode: 6 });
      }
      await tokenStore.set(client.origin, token);
      return { authenticated: true, server: client.origin, expiresAt: tokenExpiresAt };
    } catch (error) {
      if (error instanceof ApiError && error.status === 428 && error.code === "cli-login-pending") {
        const details = object(error.details, "CLI login pending");
        if (details.retryAfterSeconds !== interval) throw new CliError("CLI login retry interval changed unexpectedly.", { exitCode: 6, code: "server-response-invalid" });
        continue;
      }
      throw error;
    }
  }
  throw new CliError("CLI login expired before browser approval.", { exitCode: 3, code: "login-expired" });
}
