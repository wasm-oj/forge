export function assertBuildStackSize(language: string, value: unknown): asserts value is number {
  if (language !== "c" && language !== "cpp") {
    throw new Error("stackSizeBytes is supported only for C/C++ builds.");
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < 16 || value > 0xfffffff0 || value % 16 !== 0) {
    throw new Error("stackSizeBytes must be a multiple of 16 between 16 and 4294967280 bytes.");
  }
}
