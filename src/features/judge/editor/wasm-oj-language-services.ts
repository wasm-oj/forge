import type * as Monaco from "monaco-editor";
import { QUICKJS_STD_MODULE_DECLARATION } from "../../../core/quickjs-runtime";

export const QUICKJS_STD_TYPES_URI = "file:///__wasm_oj__/quickjs-std.d.ts";

export function configureWasmOjLanguageServices(monaco: typeof Monaco): void {
  const defaults = monaco.typescript;
  defaults.javascriptDefaults.addExtraLib(
    QUICKJS_STD_MODULE_DECLARATION,
    QUICKJS_STD_TYPES_URI,
  );
  defaults.typescriptDefaults.addExtraLib(
    QUICKJS_STD_MODULE_DECLARATION,
    QUICKJS_STD_TYPES_URI,
  );
}
