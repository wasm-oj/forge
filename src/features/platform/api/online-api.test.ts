import { afterEach, describe, expect, it, vi } from "vitest";
import { wasmOjMutation } from "./online-api";

describe("authenticated mutations", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the existing same-origin session and CSRF token for an admin Container check", async () => {
    vi.stubGlobal("document", { cookie: "other=value; wasm_oj_csrf=csrf-value=; preference=en" });
    const response = { ready: true, buildId: "a".repeat(40), contract: 2, protocol: "wasm-oj-container-v2", workerVersionId: "worker-version" };
    const fetch = vi.fn().mockResolvedValue(Response.json(response));
    vi.stubGlobal("fetch", fetch);

    await expect(wasmOjMutation("/api/admin/container-probe", {})).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/admin/container-probe", {
      credentials: "same-origin",
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-wasm-oj-csrf": "csrf-value=",
      },
      body: "{}",
    });
  });

  it("does not send a mutation when the CSRF cookie is missing", async () => {
    vi.stubGlobal("document", { cookie: "other=value" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(wasmOjMutation("/api/admin/container-probe", {})).rejects.toThrow("CSRF token is missing");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces the server's authorization failure", async () => {
    vi.stubGlobal("document", { cookie: "wasm_oj_csrf=csrf-value" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      error: { code: "admin-required", message: "An Admin role is required." },
    }, { status: 403 })));

    await expect(wasmOjMutation("/api/admin/container-probe", {})).rejects.toThrow("An Admin role is required.");
  });
});
