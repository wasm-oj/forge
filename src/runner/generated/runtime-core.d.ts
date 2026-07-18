/* tslint:disable */
/* eslint-disable */

export function compile_pipeline_forge(request: any): Promise<any>;

export function interact_forge(request: any): Promise<any>;

export function run_forge(request: any): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly compile_pipeline_forge: (a: any) => any;
    readonly interact_forge: (a: any) => any;
    readonly run_forge: (a: any) => [number, number, number];
    readonly canonical_abi_free: (a: number, b: number, c: number) => void;
    readonly canonical_abi_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbg_trap_free: (a: number, b: number) => void;
    readonly trap___wbg_wasmer_trap: () => void;
    readonly wasm_bindgen_168d549d119b7916___convert__closures_____invoke___wasm_bindgen_168d549d119b7916___JsValue__core_9b3796e30d99ddb7___result__Result_____wasm_bindgen_168d549d119b7916___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_168d549d119b7916___convert__closures________invoke___js_sys_ebfc9f1583139cfd___Array__core_9b3796e30d99ddb7___result__Result_js_sys_ebfc9f1583139cfd___Array__wasm_bindgen_168d549d119b7916___JsValue___true_: (a: number, b: number, c: any) => [number, number, number];
    readonly wasm_bindgen_168d549d119b7916___convert__closures________invoke___js_sys_ebfc9f1583139cfd___Array__core_9b3796e30d99ddb7___result__Result_js_sys_ebfc9f1583139cfd___Array__wasm_bindgen_168d549d119b7916___JsValue___true__2: (a: number, b: number, c: any) => [number, number, number];
    readonly wasm_bindgen_168d549d119b7916___convert__closures________invoke___js_sys_ebfc9f1583139cfd___Array__core_9b3796e30d99ddb7___result__Result_____wasm_bindgen_168d549d119b7916___JsValue___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_168d549d119b7916___convert__closures_____invoke___js_sys_ebfc9f1583139cfd___Function_fn_wasm_bindgen_168d549d119b7916___JsValue_____wasm_bindgen_168d549d119b7916___sys__Undefined___js_sys_ebfc9f1583139cfd___Function_fn_wasm_bindgen_168d549d119b7916___JsValue_____wasm_bindgen_168d549d119b7916___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export: WebAssembly.Table;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
