import { afterEach, describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "../../worker/env";
import {
  githubInstallationToken,
  githubReadOnlyInstallationAuthorization,
  githubReadOnlyPermissionsJson,
  setGithubAppInstallationSuspension,
} from "../../worker/github";

class InstallationAuthorityDatabase {
  status: "active" | "suspended" | "removed" = "active";
  permissionsJson = JSON.stringify({ contents: "read", metadata: "read" });
  repositorySelection = "selected";
  authorityGeneration = 0;
  reads = 0;

  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<{ readonly meta: { readonly changes: number } }>;
    };
  } {
    return {
      bind: () => ({
        first: async <T>() => {
          this.reads += 1;
          if (!sql.includes("FROM github_installations") || this.status !== "active") return null;
          return {
            permissions_json: this.permissionsJson,
            repository_selection: this.repositorySelection,
            status: this.status,
            authority_generation: this.authorityGeneration,
          } as T;
        },
        run: async () => {
          if (!sql.includes("SET status='suspended'") || this.status !== "active") return { meta: { changes: 0 } };
          this.status = "suspended";
          this.authorityGeneration += 1;
          return { meta: { changes: 1 } };
        },
      }),
    };
  }
}

async function githubAppPrivateKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const base64 = Buffer.from(bytes).toString("base64").match(/.{1,64}/g)?.join("\n");
  if (!base64) throw new Error("Failed to encode test GitHub App key.");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

async function tokenEnvironment(database: InstallationAuthorityDatabase): Promise<WasmOjWorkerEnv> {
  return {
    DB: database as unknown as D1Database,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: await githubAppPrivateKey(),
  } as WasmOjWorkerEnv;
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    token: `ghs_${"a".repeat(36)}`,
    expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    permissions: { metadata: "read", contents: "read" },
    repository_selection: "selected",
    ...overrides,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("GitHub installation token boundary", () => {
  it("canonicalizes only the exact selected-repository read-only permission policy", () => {
    expect(githubReadOnlyPermissionsJson({ metadata: "read", contents: "read", issues: "none" }))
      .toBe('{"contents":"read","issues":"none","metadata":"read"}');
    expect(githubReadOnlyInstallationAuthorization({ contents: "read" }, "selected"))
      .toEqual({ permissionsJson: '{"contents":"read"}', repositorySelection: "selected" });
    expect(() => githubReadOnlyPermissionsJson({ contents: "write", metadata: "read" }))
      .toThrow(expect.objectContaining({ code: "github-permissions-excessive" }));
    expect(() => githubReadOnlyPermissionsJson({ contents: "read", actions: "read" }))
      .toThrow(expect.objectContaining({ code: "github-permissions-excessive" }));
    expect(() => githubReadOnlyInstallationAuthorization({ contents: "read" }, "all"))
      .toThrow(expect.objectContaining({ code: "github-repository-selection" }));
  });

  it("does not contact GitHub after an installation is locally revoked", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({ first: async () => null }),
        }),
      },
    } as unknown as WasmOjWorkerEnv;

    await expect(githubInstallationToken(env, 42)).rejects.toMatchObject({
      status: 403,
      code: "github-installation-inactive",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a token only after exact response permissions and a post-mint authority recheck", async () => {
    const database = new InstallationAuthorityDatabase();
    vi.stubGlobal("fetch", vi.fn(async () => tokenResponse()));

    await expect(githubInstallationToken(await tokenEnvironment(database), 42)).resolves.toMatch(/^ghs_/);
    expect(database.reads).toBe(2);
    expect(database.status).toBe("active");
  });

  it("suspends the installation and discards a token carrying write permission", async () => {
    const database = new InstallationAuthorityDatabase();
    vi.stubGlobal("fetch", vi.fn(async () => tokenResponse({ permissions: { contents: "write", metadata: "read" } })));

    await expect(githubInstallationToken(await tokenEnvironment(database), 42)).rejects.toMatchObject({
      status: 409,
      code: "github-installation-permissions-drift",
    });
    expect(database.status).toBe("suspended");
    expect(database.reads).toBe(1);
  });

  it("discards the token when local authorization changes while GitHub is minting it", async () => {
    const database = new InstallationAuthorityDatabase();
    vi.stubGlobal("fetch", vi.fn(async () => {
      database.status = "suspended";
      return tokenResponse();
    }));

    await expect(githubInstallationToken(await tokenEnvironment(database), 42)).rejects.toMatchObject({
      status: 403,
      code: "github-installation-inactive",
    });
    expect(database.reads).toBe(2);
  });

  it("discards the token when a same-status authorization event advances the durable generation", async () => {
    const database = new InstallationAuthorityDatabase();
    vi.stubGlobal("fetch", vi.fn(async () => {
      database.authorityGeneration += 1;
      return tokenResponse();
    }));

    await expect(githubInstallationToken(await tokenEnvironment(database), 42)).rejects.toMatchObject({
      status: 403,
      code: "github-installation-inactive",
    });
    expect(database.status).toBe("active");
    expect(database.reads).toBe(2);
  });

  it("converges remote suspension through authenticated-app read-back after a lost mutation response", async () => {
    const env = await tokenEnvironment(new InstallationAuthorityDatabase());
    let suspendedAt: string | null = null;
    let mutationAttempts = 0;
    const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      expect(url).toBe(`https://api.github.com/app/installations/42${init?.method ? "/suspended" : ""}`);
      if (init?.method === "PUT") {
        mutationAttempts += 1;
        suspendedAt = "2026-08-09T03:00:00Z";
        throw new TypeError("simulated response loss");
      }
      return Response.json({ id: 42, suspended_at: suspendedAt });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(setGithubAppInstallationSuspension(env, 42, true)).resolves.toBe("2026-08-09T03:00:00Z");
    expect(mutationAttempts).toBe(1);
    expect(fetcher.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "PUT", "GET"]);
  });

  it("unsuspends only after the remote installation read-back proves access is enabled", async () => {
    const env = await tokenEnvironment(new InstallationAuthorityDatabase());
    let suspendedAt: string | null = "2026-08-09T03:00:00Z";
    const fetcher = vi.fn(async (_request: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        suspendedAt = null;
        return new Response(null, { status: 204 });
      }
      return Response.json({ id: 42, suspended_at: suspendedAt });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(setGithubAppInstallationSuspension(env, 42, false)).resolves.toBeNull();
    expect(fetcher.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "DELETE", "GET"]);
  });
});
