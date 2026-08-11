import { describe, expect, it } from "vitest";
import { readBoundedResponseBytes } from "./http";

describe("bounded response bytes", () => {
  it("materializes an unknown-length stream for APIs that require fixed-length bodies", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    expect([...await readBoundedResponseBytes(new Response(stream), 3)]).toEqual([1, 2, 3]);
  });

  it("cancels and rejects an unknown-length stream that crosses the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    });
    await expect(readBoundedResponseBytes(new Response(stream), 3)).rejects.toThrow("size limit");
  });
});
