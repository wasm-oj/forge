import { describe, expect, it } from "vitest";
import {
  isWasmerThreadInitMessage,
  WASMER_THREAD_STACK_SIZE_BYTES,
} from "./wasmer-thread-policy";

const EMPTY_WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

describe("Wasmer secondary-worker policy", () => {
  it("pins a positive WebAssembly-page-aligned stack", () => {
    expect(WASMER_THREAD_STACK_SIZE_BYTES).toBe(1_048_576);
    expect(WASMER_THREAD_STACK_SIZE_BYTES % 65_536).toBe(0);
  });

  it("accepts only a complete SDK initialization message", () => {
    const message = {
      type: "init",
      id: 1,
      memory: new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }),
      module: new WebAssembly.Module(EMPTY_WASM),
      sdkUrl: "https://forge.example/assets/wasmer-sdk.js",
    };
    expect(isWasmerThreadInitMessage(message)).toBe(true);
    expect(isWasmerThreadInitMessage({ ...message, id: -1 })).toBe(false);
    expect(isWasmerThreadInitMessage({ ...message, id: 1.5 })).toBe(false);
    expect(isWasmerThreadInitMessage({ ...message, id: 0x1_0000_0000 })).toBe(false);
    expect(isWasmerThreadInitMessage({ ...message, memory: new ArrayBuffer(8) })).toBe(false);
    expect(isWasmerThreadInitMessage({ ...message, module: EMPTY_WASM })).toBe(false);
    expect(isWasmerThreadInitMessage({ ...message, sdkUrl: "" })).toBe(false);
  });
});
