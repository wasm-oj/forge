import { describe, expect, it } from "vitest";
import { HttpRemoteClient } from "./http";
import { MemoryTokenStore } from "./keychain";

const LIMIT = 8 * 1024 * 1024;

function oversizedStream(fill: number): ReadableStream<Uint8Array> {
  let emitted = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted > LIMIT) { controller.close(); return; }
      const bytes = new Uint8Array(64 * 1024).fill(fill);
      emitted += bytes.byteLength;
      controller.enqueue(bytes);
    },
  });
}

describe("woj bounded HTTP responses", () => {
  it("cancels chunked JSON immediately above the limit", async () => {
    const stream = oversizedStream(0x20);
    const client = new HttpRemoteClient("https://judge.example", new MemoryTokenStore(), async () => new Response(stream, {
      headers: { "content-type": "application/json" },
    }));
    await expect(client.request("/api/problems", { authenticated: false })).rejects.toMatchObject({ exitCode: 6, code: "response-too-large" });
  });

  it("cancels chunked problem bytes immediately above the limit", async () => {
    const stream = oversizedStream(0x61);
    const client = new HttpRemoteClient("https://judge.example", new MemoryTokenStore(), async () => new Response(stream));
    await expect(client.requestBytes("/api/problems/content", { authenticated: false })).rejects.toMatchObject({ exitCode: 4, code: "response-too-large" });
  });
});
