import { describe, expect, it, vi } from "vitest";
import { LanguageDriverRegistry } from "./language-driver";

describe("LanguageDriverRegistry", () => {
  it("supports independently registered compiler plugins", () => {
    const registry = new LanguageDriverRegistry();
    const driver = { id: "native", languages: ["c", "cpp"] as const, build: vi.fn() };
    registry.register(driver);
    expect(registry.driver("c")).toBe(driver);
    expect(registry.languages()).toEqual(["c", "cpp"]);
  });

  it("rejects ambiguous language ownership", () => {
    const registry = new LanguageDriverRegistry();
    registry.register({ id: "one", languages: ["c"], build: vi.fn() });
    expect(() => registry.register({ id: "two", languages: ["c"], build: vi.fn() })).toThrow("already owned");
  });

  it("validates a registration transaction before committing any language", () => {
    const registry = new LanguageDriverRegistry();
    const existing = { id: "existing", languages: ["c"], build: vi.fn() };
    registry.register(existing);

    expect(() => registry.register({ id: "partial", languages: ["zig", "c"], build: vi.fn() }))
      .toThrow("already owned");
    expect(registry.languages()).toEqual(["c"]);
    expect(() => registry.driver("zig")).toThrow("No language driver");
  });

  it("requires canonical unique driver and language identifiers", () => {
    const registry = new LanguageDriverRegistry();
    registry.register({ id: "native", languages: ["c"], build: vi.fn() });

    expect(() => registry.register({ id: "native", languages: ["cpp"], build: vi.fn() }))
      .toThrow("already registered");
    expect(() => registry.register({ id: " padded", languages: ["cpp"], build: vi.fn() }))
      .toThrow("trimmed");
    expect(() => registry.register({ id: "other", languages: [" cpp"], build: vi.fn() }))
      .toThrow("Language identifiers");
    expect(() => registry.register({ id: "duplicate", languages: ["zig", "zig"], build: vi.fn() }))
      .toThrow("duplicated");
    expect(registry.languages()).toEqual(["c"]);
  });
});
