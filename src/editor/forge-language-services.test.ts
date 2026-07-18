import type * as Monaco from "monaco-editor";
import { describe, expect, it, vi } from "vitest";
import { QUICKJS_STD_MODULE_DECLARATION } from "../core/quickjs-runtime";
import {
  configureForgeLanguageServices,
  QUICKJS_STD_TYPES_URI,
} from "./forge-language-services";

describe("Forge Monaco language services", () => {
  it("registers the QuickJS runtime contract for JavaScript and TypeScript", () => {
    const javascriptExtraLib = vi.fn();
    const typescriptExtraLib = vi.fn();
    const monaco = {
      languages: {
        typescript: {
          javascriptDefaults: { addExtraLib: javascriptExtraLib },
          typescriptDefaults: { addExtraLib: typescriptExtraLib },
        },
      },
    } as unknown as typeof Monaco;

    configureForgeLanguageServices(monaco);

    const expected = [QUICKJS_STD_MODULE_DECLARATION, QUICKJS_STD_TYPES_URI];
    expect(javascriptExtraLib).toHaveBeenCalledOnce();
    expect(javascriptExtraLib).toHaveBeenCalledWith(...expected);
    expect(typescriptExtraLib).toHaveBeenCalledOnce();
    expect(typescriptExtraLib).toHaveBeenCalledWith(...expected);
  });
});
