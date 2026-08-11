import { operationalLog } from "./structured-log";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  if (!responseHeaders.has("cache-control")) responseHeaders.set("cache-control", "no-store");
  return new Response(`${JSON.stringify(value)}\n`, { status, headers: responseHeaders });
}

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonResponse({
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
    }, error.status);
  }
  operationalLog("error", {
    event: "api.unhandled-error",
    outcome: "failure",
    code: error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : "UnknownError",
  });
  return jsonResponse({ error: { code: "internal-error", message: "The service could not complete the request." } }, 500);
}

function declaredBodyLength(headers: Headers, maximumBytes: number): number | undefined {
  const value = headers.get("content-length");
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
    throw new RangeError("Body exceeds its size limit.");
  }
  return parsed;
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  declaredLength: number | undefined,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError("Body limit is invalid.");
  if (declaredLength !== undefined && declaredLength > maximumBytes) throw new RangeError("Body exceeds its size limit.");
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("body exceeds its size limit");
        throw new RangeError("Body exceeds its size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== undefined && declaredLength !== length) throw new TypeError("Body length does not match Content-Length.");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedRequestBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  let declaredLength: number | undefined;
  try {
    declaredLength = declaredBodyLength(request.headers, maximumBytes);
  } catch {
    throw new ApiError(413, "request-too-large", "Request body exceeds its size limit.");
  }
  try {
    return await readBoundedBody(request.body, declaredLength, maximumBytes);
  } catch (error) {
    if (error instanceof RangeError) throw new ApiError(413, "request-too-large", "Request body exceeds its size limit.");
    throw new ApiError(400, "request-body-invalid", "Request body is incomplete or malformed.");
  }
}

export async function readBoundedResponseJson(response: Response, maximumBytes: number): Promise<unknown> {
  const bytes = await readBoundedResponseBytes(response, maximumBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    bytes.fill(0);
  }
}

export async function readBoundedResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  return readBoundedBody(response.body, declaredBodyLength(response.headers, maximumBytes), maximumBytes);
}

export async function readJsonBody(request: Request, maximumBytes = 2 * 1024 * 1024): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new ApiError(415, "unsupported-media-type", "Expected application/json.");
  const bytes = await readBoundedRequestBytes(request, maximumBytes);
  if (bytes.byteLength === 0) throw new ApiError(400, "empty-body", "A JSON request body is required.");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new ApiError(400, "invalid-json", "Request body is not valid UTF-8 JSON.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    bytes.fill(0);
  }
}

export function parseCookies(request: Request): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

export function cookieHeader(
  name: string,
  value: string,
  options: { readonly httpOnly?: boolean; readonly maxAge: number; readonly sameSite?: "Lax" | "Strict" },
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || /[;\r\n]/.test(value)) throw new TypeError("Invalid cookie.");
  return `${name}=${value}; Path=/; Max-Age=${options.maxAge}; Secure; SameSite=${options.sameSite ?? "Lax"}${options.httpOnly ? "; HttpOnly" : ""}`;
}

export function assertSameOrigin(request: Request, publicOrigin: string): void {
  const origin = request.headers.get("origin");
  if (origin !== publicOrigin) throw new ApiError(403, "origin-rejected", "Mutation request origin is not allowed.");
}

export function routeUuid(pathname: string, prefix: string, suffix = ""): string | undefined {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  const value = pathname.slice(prefix.length, suffix ? -suffix.length : undefined);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    ? value
    : undefined;
}
