import { describe, expect, it } from "vitest";
import {
  readBoundedRequestBytes,
  readBoundedResponseJson,
  readJsonBody,
} from "../../worker/http";

function chunkedBody(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("Worker bounded HTTP bodies", () => {
  it("rejects a chunked request as soon as its aggregate size crosses the limit", async () => {
    const request = new Request("https://app.example.test/webhook", {
      method: "POST",
      body: chunkedBody("1234", "5678"),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedRequestBytes(request, 7)).rejects.toMatchObject({
      status: 413,
      code: "request-too-large",
    });
  });

  it("rejects a truncated declared body without exposing its contents", async () => {
    const request = new Request("https://app.example.test/webhook", {
      method: "POST",
      headers: { "content-length": "8" },
      body: chunkedBody("1234"),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedRequestBytes(request, 16)).rejects.toMatchObject({
      status: 400,
      code: "request-body-invalid",
    });
  });

  it("bounds and parses an upstream JSON response", async () => {
    const response = new Response(chunkedBody("{\"ok\":", "true}"), {
      headers: { "content-type": "application/json" },
    });
    await expect(readBoundedResponseJson(response, 32)).resolves.toEqual({ ok: true });
  });

  it("rejects oversized and malformed upstream JSON responses", async () => {
    await expect(readBoundedResponseJson(new Response(chunkedBody("1234", "5678")), 7)).rejects.toBeInstanceOf(RangeError);
    await expect(readBoundedResponseJson(new Response("not-json"), 32)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("keeps the existing JSON request media-type and empty-body contract", async () => {
    await expect(readJsonBody(new Request("https://app.example.test/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }))).rejects.toMatchObject({ status: 400, code: "empty-body" });
  });
});
