import type * as Monaco from "monaco-editor";

export type WasmOjMonacoTheme = "wasm-oj-nord-light" | "wasm-oj-nord-dark";

const SHARED_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: "comment", foreground: "616E88", fontStyle: "italic" },
  { token: "keyword", foreground: "5E81AC" },
  { token: "keyword.control", foreground: "81A1C1" },
  { token: "type", foreground: "8FBCBB" },
  { token: "type.identifier", foreground: "8FBCBB" },
  { token: "function", foreground: "88C0D0" },
  { token: "string", foreground: "A3BE8C" },
  { token: "number", foreground: "B48EAD" },
  { token: "constant", foreground: "B48EAD" },
  { token: "operator", foreground: "81A1C1" },
  { token: "invalid", foreground: "BF616A", fontStyle: "underline" },
];

export const WASM_OJ_MONACO_THEMES = Object.freeze({
  "wasm-oj-nord-light": {
    base: "vs",
    inherit: true,
    rules: SHARED_RULES,
    colors: {
      "editor.background": "#ECEFF4",
      "editor.foreground": "#2E3440",
      "editorGutter.background": "#E5E9F0",
      "editorLineNumber.foreground": "#6D788C",
      "editorLineNumber.activeForeground": "#2E3440",
      "editor.lineHighlightBackground": "#E5E9F0",
      "editor.selectionBackground": "#88C0D066",
      "editor.inactiveSelectionBackground": "#81A1C133",
      "editor.selectionHighlightBackground": "#88C0D033",
      "editorCursor.foreground": "#5E81AC",
      "editorIndentGuide.background1": "#D8DEE9",
      "editorIndentGuide.activeBackground1": "#81A1C1",
      "editorWhitespace.foreground": "#C6CFDD",
      "editorBracketHighlight.foreground1": "#5E81AC",
      "editorBracketHighlight.foreground2": "#8FBCBB",
      "editorBracketHighlight.foreground3": "#B48EAD",
      "editor.findMatchBackground": "#EBCB8B88",
      "editor.findMatchBorder": "#D08770",
      "editor.findMatchHighlightBackground": "#EBCB8B44",
      "editorError.foreground": "#BF616A",
      "editorWarning.foreground": "#D08770",
      "editorInfo.foreground": "#5E81AC",
      "editorWidget.background": "#E5E9F0",
      "editorWidget.border": "#D8DEE9",
      "input.background": "#ECEFF4",
      "input.border": "#C6CFDD",
      "scrollbarSlider.background": "#4C566A22",
      "scrollbarSlider.hoverBackground": "#4C566A44",
      "scrollbarSlider.activeBackground": "#5E81AC66",
    },
  },
  "wasm-oj-nord-dark": {
    base: "vs-dark",
    inherit: true,
    rules: SHARED_RULES,
    colors: {
      "editor.background": "#2E3440",
      "editor.foreground": "#D8DEE9",
      "editorGutter.background": "#2E3440",
      "editorLineNumber.foreground": "#616E88",
      "editorLineNumber.activeForeground": "#ECEFF4",
      "editor.lineHighlightBackground": "#3B4252",
      "editor.selectionBackground": "#5E81AC77",
      "editor.inactiveSelectionBackground": "#4C566A66",
      "editor.selectionHighlightBackground": "#81A1C144",
      "editorCursor.foreground": "#88C0D0",
      "editorIndentGuide.background1": "#3B4252",
      "editorIndentGuide.activeBackground1": "#81A1C1",
      "editorWhitespace.foreground": "#434C5E",
      "editorBracketHighlight.foreground1": "#88C0D0",
      "editorBracketHighlight.foreground2": "#8FBCBB",
      "editorBracketHighlight.foreground3": "#B48EAD",
      "editor.findMatchBackground": "#EBCB8B55",
      "editor.findMatchBorder": "#D08770",
      "editor.findMatchHighlightBackground": "#EBCB8B33",
      "editorError.foreground": "#BF616A",
      "editorWarning.foreground": "#EBCB8B",
      "editorInfo.foreground": "#88C0D0",
      "editorWidget.background": "#3B4252",
      "editorWidget.border": "#4C566A",
      "input.background": "#2E3440",
      "input.border": "#4C566A",
      "scrollbarSlider.background": "#D8DEE922",
      "scrollbarSlider.hoverBackground": "#D8DEE944",
      "scrollbarSlider.activeBackground": "#88C0D066",
    },
  },
} satisfies Readonly<Record<WasmOjMonacoTheme, Monaco.editor.IStandaloneThemeData>>);

export function wasmOjMonacoTheme(productTheme: "light" | "dark"): WasmOjMonacoTheme {
  return productTheme === "dark" ? "wasm-oj-nord-dark" : "wasm-oj-nord-light";
}

export function registerWasmOjMonacoThemes(monaco: typeof Monaco): void {
  for (const [name, theme] of Object.entries(WASM_OJ_MONACO_THEMES)) {
    monaco.editor.defineTheme(name as WasmOjMonacoTheme, theme);
  }
}
