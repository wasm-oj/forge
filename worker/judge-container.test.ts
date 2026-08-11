import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
}));

import { cleanupOneShotContainer } from "./judge-container";

interface CleanupStorage {
  readonly entries: Map<string, unknown>;
  readonly list: DurableObjectStorage["list"];
  readonly delete: DurableObjectStorage["delete"];
  markDestroyed(): void;
}

function cleanupStorage(
  keys: readonly string[],
  order: string[],
  failure?: "output" | "authorization",
): CleanupStorage {
  const entries = new Map(keys.map((key) => [key, true] as const));
  let destroyed = false;
  const list = vi.fn(async (options?: DurableObjectListOptions) => {
    if (destroyed) throw new Error("storage used after destroy");
    order.push("list");
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? Number.POSITIVE_INFINITY;
    return new Map([...entries].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
  }) as DurableObjectStorage["list"];
  const deleteKeys = vi.fn(async (keyOrKeys: string | string[]) => {
    if (destroyed) throw new Error("storage used after destroy");
    const batch = typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys;
    const phase = batch[0]?.startsWith("output:") ? "output" : "authorization";
    order.push(`delete:${phase}:${batch.length}`);
    if (batch.length > 128) throw new Error("Durable Object delete batch exceeded 128 keys");
    if (failure === phase) throw new Error(`${phase} cleanup failed`);
    let deleted = 0;
    for (const key of batch) {
      if (entries.delete(key)) deleted += 1;
    }
    return deleted;
  }) as unknown as DurableObjectStorage["delete"];
  return {
    entries,
    list,
    delete: deleteKeys,
    markDestroyed: () => { destroyed = true; },
  };
}

describe("one-shot judge Container cleanup", () => {
  it("deletes more than 128 outputs in bounded batches before destroying without losing the response", async () => {
    const order: string[] = [];
    const outputKeys = Array.from({ length: 257 }, (_, index) => `output:${index.toString().padStart(3, "0")}`);
    const storage = cleanupStorage(["authorization", "identity-fence", ...outputKeys], order);
    const response = new Response(JSON.stringify({ status: "valid" }), { status: 200 });

    await expect(cleanupOneShotContainer(storage, async () => {
      order.push("destroy");
      storage.markDestroyed();
    })).resolves.toBeUndefined();

    expect(await response.json()).toEqual({ status: "valid" });
    expect(order.filter((entry) => entry.startsWith("delete:output"))).toEqual([
      "delete:output:128",
      "delete:output:128",
      "delete:output:1",
    ]);
    expect(order.at(-2)).toBe("delete:authorization:2");
    expect(order.at(-1)).toBe("destroy");
    expect(storage.entries.size).toBe(0);
  });

  it.each(["output", "authorization", "destroy"] as const)(
    "destroys last and reports a %s cleanup failure",
    async (failure) => {
      const order: string[] = [];
      const storage = cleanupStorage(
        ["authorization", "identity-fence", "output:one"],
        order,
        failure === "destroy" ? undefined : failure,
      );

      const cleanup = cleanupOneShotContainer(storage, async () => {
        order.push("destroy");
        storage.markDestroyed();
        if (failure === "destroy") throw new Error("destroy failed");
      });

      await expect(cleanup).rejects.toMatchObject({
        status: 500,
        code: "container-cleanup",
      });
      expect(order.at(-1)).toBe("destroy");
    },
  );
});
