import { describe, expect, it } from "vitest";
import { isLlvmBitcode, selectRustAllocatorBitcodeName } from "./rust-allocator-bitcode";

describe("Rust allocator bitcode discovery", () => {
  it("selects only rustc's standalone allocator module", () => {
    expect(selectRustAllocatorBitcodeName([
      "main.forge_submission.abc-cgu.0.rcgu.bc",
      "main.bvtq9sido78cscc61kozca0r4.rcgu.bc",
      "main.o",
    ])).toBe("main.bvtq9sido78cscc61kozca0r4.rcgu.bc");
  });

  it("waits for a missing module and rejects ambiguous output", () => {
    expect(selectRustAllocatorBitcodeName(["main.o"])).toBeUndefined();
    expect(() => selectRustAllocatorBitcodeName([
      "main.allocator1.rcgu.bc",
      "main.allocator2.rcgu.bc",
    ])).toThrow(/multiple allocator bitcode/);
  });

  it("recognizes raw and wrapped LLVM bitcode magic", () => {
    expect(isLlvmBitcode(Uint8Array.of(0x42, 0x43, 0xc0, 0xde))).toBe(true);
    expect(isLlvmBitcode(Uint8Array.of(0xde, 0xc0, 0x17, 0x0b))).toBe(true);
    expect(isLlvmBitcode(Uint8Array.of(0, 97, 115, 109))).toBe(false);
  });
});
