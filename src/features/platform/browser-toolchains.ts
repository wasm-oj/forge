import { browserSource as clangSource } from "@wasm-oj/toolchain-clang";
import { browserSource as goSource } from "@wasm-oj/toolchain-go";
import { browserSource as javascriptSource } from "@wasm-oj/toolchain-javascript";
import { browserSource as javaSource } from "@wasm-oj/toolchain-java";
import { browserSource as pythonSource } from "@wasm-oj/toolchain-python";
import { browserSource as rustSource } from "@wasm-oj/toolchain-rust";
import type { BrowserToolchainSource } from "../../core/types";

/** Explicit toolchain installation selected by the platform deployment. */
export const PLATFORM_BROWSER_TOOLCHAINS: readonly BrowserToolchainSource[] = Object.freeze([
  clangSource("/toolchains/"),
  rustSource("/toolchains/"),
  pythonSource("/toolchains/"),
  javascriptSource("/toolchains/"),
  goSource("/toolchains/"),
  javaSource("/toolchains/"),
]);
