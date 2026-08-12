import { describe, expect, it } from "vitest";
import { isUnicodeScalarString } from "./unicode-scalar";

describe("Unicode scalar boundary", () => {
  it("accepts scalar values and rejects isolated UTF-16 surrogates", () => {
    expect(isUnicodeScalarString("plain 😀 text")).toBe(true);
    expect(isUnicodeScalarString("\ud800")).toBe(false);
    expect(isUnicodeScalarString("\udc00")).toBe(false);
    expect(isUnicodeScalarString("\ud800x")).toBe(false);
  });
});
