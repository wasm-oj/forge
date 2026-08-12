import { describe, expect, it, vi } from "vitest";
import {
  WASM_OJ_MONACO_THEMES,
  wasmOjMonacoTheme,
  registerWasmOjMonacoThemes,
} from "./wasm-oj-monaco-theme";

describe("WASM-OJ Monaco Nord themes", () => {
  it("selects the exact theme that matches the product theme", () => {
    expect(wasmOjMonacoTheme("light")).toBe("wasm-oj-nord-light");
    expect(wasmOjMonacoTheme("dark")).toBe("wasm-oj-nord-dark");
  });

  it("defines Snow Storm light and Polar Night dark editor surfaces", () => {
    expect(WASM_OJ_MONACO_THEMES["wasm-oj-nord-light"]).toMatchObject({
      base: "vs",
      colors: {
        "editor.background": "#ECEFF4",
        "editor.foreground": "#2E3440",
        "editorCursor.foreground": "#5E81AC",
      },
    });
    expect(WASM_OJ_MONACO_THEMES["wasm-oj-nord-dark"]).toMatchObject({
      base: "vs-dark",
      colors: {
        "editor.background": "#2E3440",
        "editor.foreground": "#D8DEE9",
        "editorCursor.foreground": "#88C0D0",
      },
    });
  });

  it("registers only the two supported themes", () => {
    const defineTheme = vi.fn();
    registerWasmOjMonacoThemes({ editor: { defineTheme } } as never);
    expect(defineTheme.mock.calls.map(([name]) => name)).toEqual([
      "wasm-oj-nord-light",
      "wasm-oj-nord-dark",
    ]);
  });

  it("does not retain the legacy brown or fluorescent-green palette", () => {
    const serialized = JSON.stringify(WASM_OJ_MONACO_THEMES).toLowerCase();
    for (const legacy of ["#151411", "#e8e5de", "#c9f27b", "#39472d"]) {
      expect(serialized).not.toContain(legacy);
    }
  });
});
