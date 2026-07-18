const ALLOCATOR_BITCODE_BASENAME = /^main\.[a-z0-9]+\.rcgu\.bc$/i;

export function selectRustAllocatorBitcodeName(names: readonly string[]): string | undefined {
  const matches = names.filter((name) => ALLOCATOR_BITCODE_BASENAME.test(name)).sort();
  if (matches.length > 1) {
    throw new Error(`rustc emitted multiple allocator bitcode modules: ${matches.join(", ")}.`);
  }
  return matches[0];
}

export function isLlvmBitcode(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const rawBitcode = bytes[0] === 0x42 && bytes[1] === 0x43 && bytes[2] === 0xc0 && bytes[3] === 0xde;
  const bitcodeWrapper = bytes[0] === 0xde && bytes[1] === 0xc0 && bytes[2] === 0x17 && bytes[3] === 0x0b;
  return rawBitcode || bitcodeWrapper;
}
