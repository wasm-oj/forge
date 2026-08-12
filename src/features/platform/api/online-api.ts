"use client";

export interface ApiFailure {
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

const MAINTENANCE_SMOKE_HEADER = "x-wasm-oj-maintenance-smoke-token";
const MAINTENANCE_SMOKE_TOKEN = /^[\x21-\x7e]{32,256}$/;
let maintenanceSmokeToken: string | undefined;

/**
 * Arms the production maintenance smoke lane for this in-memory browser
 * session only. The token is deliberately never persisted to web storage.
 */
export function configureWasmOjMaintenanceSmokeToken(token?: string): void {
  if (token === undefined || token === "") {
    maintenanceSmokeToken = undefined;
    return;
  }
  if (!MAINTENANCE_SMOKE_TOKEN.test(token)) {
    throw new TypeError("Maintenance smoke token must contain 32–256 printable ASCII characters.");
  }
  maintenanceSmokeToken = token;
}

export function wasmOjMaintenanceSmokeArmed(): boolean {
  return maintenanceSmokeToken !== undefined;
}

export function wasmOjMaintenanceSmokeHeaders(): Readonly<Record<string, string>> {
  return maintenanceSmokeToken === undefined ? {} : { [MAINTENANCE_SMOKE_HEADER]: maintenanceSmokeToken };
}

export function wasmOjCsrfToken(): string | undefined {
  for (const item of document.cookie.split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (name === "wasm_oj_csrf") return value.join("=");
  }
  return undefined;
}

export async function wasmOjJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  let value: T & ApiFailure;
  try {
    value = await response.json() as T & ApiFailure;
  } catch {
    throw new Error(`WASM-OJ returned a non-JSON response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(typeof value.error?.message === "string" ? value.error.message : `Request failed with HTTP ${response.status}.`);
  }
  return value;
}

export async function wasmOjMutation<T>(input: RequestInfo | URL, body: unknown, method: "POST" | "PATCH" | "DELETE" = "POST"): Promise<T> {
  const token = wasmOjCsrfToken();
  if (!token) throw new Error("Sign in again: the CSRF token is missing.");
  return wasmOjJson<T>(input, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-wasm-oj-csrf": token,
      ...wasmOjMaintenanceSmokeHeaders(),
    },
    body: JSON.stringify(body),
  });
}
