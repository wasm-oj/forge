import { CliError, unavailableError } from "./errors";
import { isWojAccessToken, type TokenStore } from "./keychain";

const MAX_JSON_BYTES = 8 * 1024 * 1024;

export class ApiError extends CliError {
  readonly status: number;
  readonly details?: unknown;
  readonly verificationUrl?: string;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message, { exitCode: exitForApiError(status, code), code });
    this.name = "ApiError";
    this.status = status;
    this.details = details;
    this.verificationUrl = verificationUrlFrom(details);
  }
}

function exitForApiError(status: number, code: string): 3 | 4 | 5 | 6 {
  if (status === 401 || status === 403 || code.includes("auth") || code.includes("role")) return 3;
  if (status === 400 || code.includes("schema") || code.includes("digest") || code.includes("validation")) return 4;
  if (status === 404 || status === 409 || status === 410 || status === 422) return 5;
  return 6;
}

function verificationUrlFrom(details: unknown): string | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const candidate = (details as Record<string, unknown>).verificationUrl;
  return typeof candidate === "string" ? candidate : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function boundedBytes(response: Response, maximum: number, label: string): Promise<Uint8Array> {
  if (!response.body) throw unavailableError(`Server ${label} response has no body.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel(`${label} response exceeds CLI limit`).catch(() => undefined);
        throw new CliError(`Server ${label} response exceeds the CLI limit.`, { exitCode: label === "JSON" ? 6 : 4, code: "response-too-large" });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) throw unavailableError(`Server returned non-JSON content (HTTP ${response.status}).`);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) {
    throw unavailableError("Server JSON response exceeds the CLI limit.");
  }
  const bytes = await boundedBytes(response, MAX_JSON_BYTES, "JSON");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw unavailableError("Server JSON response is not valid UTF-8.", error); }
  try { return text ? JSON.parse(text) as unknown : null; }
  catch (error) { throw unavailableError("Server response is not valid JSON.", error); }
}

export interface ApiRequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly authenticated?: boolean | "optional";
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RemoteClient {
  readonly origin: string;
  request(path: string, options?: ApiRequestOptions): Promise<unknown>;
  requestBytes(path: string, options?: Omit<ApiRequestOptions, "body">): Promise<Uint8Array>;
}

export class HttpRemoteClient implements RemoteClient {
  readonly origin: string;

  constructor(
    origin: string,
    private readonly tokenStore: TokenStore,
    private readonly fetchImplementation: typeof fetch = globalThis.fetch,
  ) {
    this.origin = new URL(origin).origin;
  }

  async request(apiPath: string, options: ApiRequestOptions = {}): Promise<unknown> {
    if (!apiPath.startsWith("/api/") || apiPath.includes("\\") || apiPath.includes("\0")) throw new CliError("Remote API path is invalid.", { exitCode: 4, code: "api-path-invalid" });
    const headers = new Headers({ accept: "application/json", ...options.headers });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.authenticated !== false) {
      const token = await this.tokenStore.get(this.origin);
      if (!token && options.authenticated !== "optional") throw new CliError(`Not signed in to ${this.origin}. Run 'woj auth login'.`, { exitCode: 3, code: "authentication-required" });
      if (token && !isWojAccessToken(token)) throw new CliError("The OS keychain contains a malformed woj credential.", { exitCode: 7, code: "access-token-invalid" });
      if (token) headers.set("authorization", `Bearer ${token}`);
    }
    let response: Response;
    try {
      response = await this.fetchImplementation(new URL(apiPath, this.origin), {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers,
        redirect: "error",
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      throw unavailableError(`Could not reach ${this.origin}.`, error);
    }
    const value = await boundedJson(response);
    if (!response.ok) {
      const envelope = record(value);
      const error = record(envelope?.error);
      const code = typeof error?.code === "string" ? error.code : `http-${response.status}`;
      const message = typeof error?.message === "string" ? error.message : `Server request failed with HTTP ${response.status}.`;
      throw new ApiError(response.status, code, message, error?.details ?? envelope?.details);
    }
    return value;
  }

  async requestBytes(apiPath: string, options: Omit<ApiRequestOptions, "body"> = {}): Promise<Uint8Array> {
    if (!apiPath.startsWith("/api/") || apiPath.includes("\\") || apiPath.includes("\0")) throw new CliError("Remote API path is invalid.", { exitCode: 4, code: "api-path-invalid" });
    const headers = new Headers({ accept: "application/json", ...options.headers });
    if (options.authenticated !== false) {
      const token = await this.tokenStore.get(this.origin);
      if (!token && options.authenticated !== "optional") throw new CliError(`Not signed in to ${this.origin}. Run 'woj auth login'.`, { exitCode: 3, code: "authentication-required" });
      if (token && !isWojAccessToken(token)) throw new CliError("The OS keychain contains a malformed woj credential.", { exitCode: 7, code: "access-token-invalid" });
      if (token) headers.set("authorization", `Bearer ${token}`);
    }
    let response: Response;
    try { response = await this.fetchImplementation(new URL(apiPath, this.origin), { method: options.method ?? "GET", headers, redirect: "error" }); }
    catch (error) { throw unavailableError(`Could not reach ${this.origin}.`, error); }
    if (!response.ok) {
      const value = await boundedJson(response);
      const envelope = record(value);
      const error = record(envelope?.error);
      throw new ApiError(
        response.status,
        typeof error?.code === "string" ? error.code : `http-${response.status}`,
        typeof error?.message === "string" ? error.message : `Server request failed with HTTP ${response.status}.`,
        error?.details ?? envelope?.details,
      );
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) throw new CliError("Problem content exceeds the CLI limit.", { exitCode: 4 });
    const bytes = await boundedBytes(response, MAX_JSON_BYTES, "problem content");
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_JSON_BYTES) throw new CliError("Problem content is outside the CLI limit.", { exitCode: 4 });
    return bytes;
  }
}
