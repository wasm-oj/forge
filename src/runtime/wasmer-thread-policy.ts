export interface WasmerThreadInitMessage {
  type: "init";
  id: number;
  memory: WebAssembly.Memory;
  module: WebAssembly.Module;
  sdkUrl: string;
}

// wasm-bindgen 0.2.101 defaults secondary instances to 2 MiB stacks. rustc
// schedules enough blocking WASIX tasks for those concurrent allocations to
// race memory growth in the SDK glue. One MiB is page-aligned and is the
// verified bound for Forge's pinned compiler/runtime workloads.
export const WASMER_THREAD_STACK_SIZE_BYTES = 1 << 20;

export function isWasmerThreadInitMessage(value: unknown): value is WasmerThreadInitMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return message.type === "init"
    && Number.isSafeInteger(message.id)
    && (message.id as number) >= 0
    && (message.id as number) <= 0xffff_ffff
    && message.memory instanceof WebAssembly.Memory
    && message.module instanceof WebAssembly.Module
    && typeof message.sdkUrl === "string"
    && message.sdkUrl.length > 0;
}
