import { describe, expect, it, vi } from "vitest";
import { DEPENDENCY_RESOLUTION_LIMITS } from "./limits.ts";
import { BrowserDependencyNetworkConsent, normalizeDependencyNetworkAccess } from "./network-consent.ts";

const sourceKey = "github:wasm-oj/fixture@main:collection/index.json";
const bundleDigest = "a".repeat(64);

describe("BrowserDependencyNetworkConsent", () => {
  it("isolates approval by source, bundle, and the cumulative host set", async () => {
    const storage = new MemoryStorage();
    const prompt = vi.fn(async () => true);
    const consent = new BrowserDependencyNetworkConsent(
      storage,
      prompt,
      () => new Date("2026-08-09T00:00:00.000Z"),
    );

    await consent.authorize(access(bundleDigest, ["registry.npmjs.org"]));
    await consent.authorize(access(bundleDigest, ["registry.npmjs.org"]));
    expect(prompt).toHaveBeenCalledTimes(1);

    await consent.authorize(access(bundleDigest, ["static.crates.io", "registry.npmjs.org"]));
    expect(prompt).toHaveBeenLastCalledWith({
      sourceKey,
      bundleDigest,
      hosts: ["registry.npmjs.org", "static.crates.io"],
    });

    const nextDigest = "b".repeat(64);
    await consent.authorize(access(nextDigest, ["registry.npmjs.org"]));
    expect(prompt).toHaveBeenCalledTimes(3);

    await consent.authorize({
      ...access(bundleDigest, ["registry.npmjs.org"]),
      sourceKey: "github:other/fork@main:collection/index.json",
    });
    expect(prompt).toHaveBeenCalledTimes(4);
  });

  it("fails closed when consent is denied and does not persist approval", async () => {
    const storage = new MemoryStorage();
    const consent = new BrowserDependencyNetworkConsent(storage, async () => false);
    await expect(consent.authorize(access(bundleDigest, ["registry.npmjs.org"])))
      .rejects.toThrow("not approved");
    expect(storage.size).toBe(0);
  });

  it.each([
    "localhost",
    "packages.localhost",
    "127.0.0.1",
    "[::1]",
    "metadata.google.internal",
    "packages.lan",
  ])("rejects local, IP, or private host %s before prompting", async (host) => {
    const prompt = vi.fn(async () => true);
    const consent = new BrowserDependencyNetworkConsent(new MemoryStorage(), prompt);
    await expect(consent.authorize(access(bundleDigest, [host]))).rejects.toThrow(/IP literal|private-network/);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("revokes a single source and bundle approval", async () => {
    const prompt = vi.fn(async () => true);
    const consent = new BrowserDependencyNetworkConsent(new MemoryStorage(), prompt);
    await consent.authorize(access(bundleDigest, ["registry.npmjs.org"]));
    await consent.revoke(sourceKey, bundleDigest);
    await consent.authorize(access(bundleDigest, ["registry.npmjs.org"]));
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("discards a malformed consent record and prompts again", async () => {
    const storage = new MemoryStorage();
    const prompt = vi.fn(async () => true);
    const consent = new BrowserDependencyNetworkConsent(storage, prompt);
    await consent.authorize(access(bundleDigest, ["registry.npmjs.org"]));
    storage.setItem(storage.key(0)!, "{not-json");

    await consent.authorize(access(bundleDigest, ["registry.npmjs.org"]));
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("accepts the exact host boundary and rejects an oversized host set before prompting", async () => {
    const exactHosts = Array.from(
      { length: DEPENDENCY_RESOLUTION_LIMITS.hosts },
      (_, index) => `registry-${index}.example.com`,
    );
    expect(normalizeDependencyNetworkAccess(access(bundleDigest, exactHosts)).hosts).toHaveLength(
      DEPENDENCY_RESOLUTION_LIMITS.hosts,
    );

    const prompt = vi.fn(async () => true);
    const consent = new BrowserDependencyNetworkConsent(new MemoryStorage(), prompt);
    await expect(consent.authorize(access(bundleDigest, [...exactHosts, "overflow.example.com"])))
      .rejects.toThrow(`${DEPENDENCY_RESOLUTION_LIMITS.hosts}-item limit`);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("allows a cumulative overlapping host set to reach the exact boundary", async () => {
    const storage = new MemoryStorage();
    const prompt = vi.fn(async () => true);
    const consent = new BrowserDependencyNetworkConsent(storage, prompt);
    const existing = Array.from(
      { length: DEPENDENCY_RESOLUTION_LIMITS.hosts - 1 },
      (_, index) => `registry-${index}.example.com`,
    );
    await consent.authorize(access(bundleDigest, existing));
    await consent.authorize(access(bundleDigest, [...existing, "registry-final.example.com"]));

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenLastCalledWith(expect.objectContaining({
      hosts: [...existing, "registry-final.example.com"].sort(),
    }));

    await expect(consent.authorize(access(bundleDigest, ["overflow.example.com"])))
      .rejects.toThrow(`${DEPENDENCY_RESOLUTION_LIMITS.hosts}-item limit`);
    expect(prompt).toHaveBeenCalledTimes(2);
  });
});

function access(digest: string, hosts: readonly string[]) {
  return { sourceKey, bundleDigest: digest, hosts };
}

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number { return this.#values.size; }
  get size(): number { return this.#values.size; }
  clear(): void { this.#values.clear(); }
  getItem(key: string): string | null { return this.#values.get(key) ?? null; }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string): void { this.#values.delete(key); }
  setItem(key: string, value: string): void { this.#values.set(key, value); }
}
