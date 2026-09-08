export function compileJavaModule(bytes: Uint8Array): Promise<WebAssembly.Module>;
export function hasStringBuiltins(): Promise<boolean>;
export function defaults(
  imports: WebAssembly.Imports,
  exports: Record<string, unknown>,
  options: { jsBodyFactories: unknown },
  module: WebAssembly.Module,
  stringBuiltins: boolean,
): { supplyExports(exports: WebAssembly.Exports): void };
