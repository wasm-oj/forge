import { describe, expect, it } from "vitest";
import type { ForgeWorkerEnv } from "./env";
import { withSecurityHeaders } from "./security-headers";

const env = {
  ENVIRONMENT: "production",
} as ForgeWorkerEnv;

describe("HTML security headers", () => {
  it("nonce-binds every rendered script so client hydration works without unsafe-inline", async () => {
    const nonce = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const response = await withSecurityHeaders(new Response(
      '<!doctype html><script>self.__next_f=[]</script><script src="/app.js"></script>',
      { headers: { "content-type": "text/html; charset=utf-8", etag: "old" } },
    ), env, nonce);

    expect(await response.text()).toBe(
      `<!doctype html><script nonce="${nonce}">self.__next_f=[]</script><script nonce="${nonce}" src="/app.js"></script>`,
    );
    expect(response.headers.get("content-security-policy")).toContain(
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
    );
    expect(response.headers.get("content-security-policy")?.match(/script-src[^;]+/u)?.[0]).not.toContain("'unsafe-inline'");
    expect(response.headers.get("content-security-policy")).toContain("frame-src 'self'");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.has("etag")).toBe(false);
  });

  it("rejects pre-nonced HTML instead of mixing CSP authorities", async () => {
    await expect(withSecurityHeaders(new Response('<script nonce="foreign">x</script>', {
      headers: { "content-type": "text/html" },
    }), env, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).rejects.toThrow("already contains a script nonce");
  });
});
