import { describe, expect, it, vi } from "vitest";
import {
  FORGE_MONACO_THEMES,
  forgeMonacoTheme,
  registerForgeMonacoThemes,
} from "./forge-monaco-theme";

describe("Forge Monaco Nord themes", () => {
  it("selects the exact theme that matches the product theme", () => {
    expect(forgeMonacoTheme("light")).toBe("forge-nord-light");
    expect(forgeMonacoTheme("dark")).toBe("forge-nord-dark");
  });

  it("defines Snow Storm light and Polar Night dark editor surfaces", () => {
    expect(FORGE_MONACO_THEMES["forge-nord-light"]).toMatchObject({
      base: "vs",
      colors: {
        "editor.background": "#ECEFF4",
        "editor.foreground": "#2E3440",
        "editorCursor.foreground": "#5E81AC",
      },
    });
    expect(FORGE_MONACO_THEMES["forge-nord-dark"]).toMatchObject({
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
    registerForgeMonacoThemes({ editor: { defineTheme } } as never);
    expect(defineTheme.mock.calls.map(([name]) => name)).toEqual([
      "forge-nord-light",
      "forge-nord-dark",
    ]);
  });

  it("does not retain the legacy brown or fluorescent-green palette", () => {
    const serialized = JSON.stringify(FORGE_MONACO_THEMES).toLowerCase();
    for (const legacy of ["#151411", "#e8e5de", "#c9f27b", "#39472d"]) {
      expect(serialized).not.toContain(legacy);
    }
  });
});
