export const TRUSTED_JUDGE_WASM_MAX_BYTES = 8 * 1024 * 1024;

const WASM_PAGE_BYTES = 65_536;
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00] as const;
const VALUE_TYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f]);
const RESERVED_EXPORTS = new Set(["gas_counter", "__wasm_oj_deferred_start"]);
const I32 = 0x7f;
const I64 = 0x7e;

interface WasiSignature { readonly parameters: readonly number[]; readonly results: readonly number[] }
const errno = (parameters: readonly number[]): WasiSignature => ({ parameters, results: [I32] });
const WASIP1_SIGNATURES: Readonly<Record<string, WasiSignature>> = Object.freeze({
  args_get: errno([I32, I32]), args_sizes_get: errno([I32, I32]),
  clock_res_get: errno([I32, I32]), clock_time_get: errno([I32, I64, I32]),
  environ_get: errno([I32, I32]), environ_sizes_get: errno([I32, I32]),
  fd_advise: errno([I32, I64, I64, I32]), fd_allocate: errno([I32, I64, I64]),
  fd_close: errno([I32]), fd_datasync: errno([I32]), fd_fdstat_get: errno([I32, I32]),
  fd_fdstat_set_flags: errno([I32, I32]), fd_fdstat_set_rights: errno([I32, I64, I64]),
  fd_filestat_get: errno([I32, I32]), fd_filestat_set_size: errno([I32, I64]),
  fd_filestat_set_times: errno([I32, I64, I64, I32]),
  fd_pread: errno([I32, I32, I32, I64, I32]), fd_prestat_dir_name: errno([I32, I32, I32]),
  fd_prestat_get: errno([I32, I32]), fd_pwrite: errno([I32, I32, I32, I64, I32]),
  fd_read: errno([I32, I32, I32, I32]), fd_readdir: errno([I32, I32, I32, I64, I32]),
  fd_renumber: errno([I32, I32]), fd_seek: errno([I32, I64, I32, I32]),
  fd_sync: errno([I32]), fd_tell: errno([I32, I32]), fd_write: errno([I32, I32, I32, I32]),
  path_create_directory: errno([I32, I32, I32]),
  path_filestat_get: errno([I32, I32, I32, I32, I32]),
  path_filestat_set_times: errno([I32, I32, I32, I32, I64, I64, I32]),
  path_link: errno([I32, I32, I32, I32, I32, I32, I32]),
  path_open: errno([I32, I32, I32, I32, I32, I64, I64, I32, I32]),
  path_readlink: errno([I32, I32, I32, I32, I32, I32]),
  path_remove_directory: errno([I32, I32, I32]),
  path_rename: errno([I32, I32, I32, I32, I32, I32]),
  path_symlink: errno([I32, I32, I32, I32, I32]), path_unlink_file: errno([I32, I32, I32]),
  poll_oneoff: errno([I32, I32, I32, I32]), proc_exit: { parameters: [I32], results: [] },
  proc_raise: errno([I32]), random_get: errno([I32, I32]), sched_yield: errno([]),
});

/** Exact deterministic WASI Preview 1 surface admitted for trusted judge commands. */
export const TRUSTED_JUDGE_WASIP1_IMPORTS = Object.freeze(new Set([
  "args_get", "args_sizes_get", "clock_res_get", "clock_time_get",
  "environ_get", "environ_sizes_get", "fd_advise", "fd_allocate", "fd_close",
  "fd_datasync", "fd_fdstat_get", "fd_fdstat_set_flags", "fd_fdstat_set_rights",
  "fd_filestat_get", "fd_filestat_set_size", "fd_filestat_set_times", "fd_pread",
  "fd_prestat_dir_name", "fd_prestat_get", "fd_pwrite", "fd_read", "fd_readdir",
  "fd_renumber", "fd_seek", "fd_sync", "fd_tell", "fd_write",
  "path_create_directory", "path_filestat_get", "path_filestat_set_times",
  "path_link", "path_open", "path_readlink", "path_remove_directory", "path_rename",
  "path_symlink", "path_unlink_file", "poll_oneoff", "proc_exit", "proc_raise",
  "random_get", "sched_yield",
]));

export type TrustedJudgeRuntimeProfile =
  | "c-wasip1-release"
  | "cpp-wasip1-release"
  | "rust-wasip1-release"
  | "go-wasip1-release";

export const TRUSTED_JUDGE_RUNTIME_PROFILES = Object.freeze(new Set<TrustedJudgeRuntimeProfile>([
  "c-wasip1-release",
  "cpp-wasip1-release",
  "rust-wasip1-release",
  "go-wasip1-release",
]));

/** Runtime-owned executable identity. This is deliberately not a compiler BuildArtifact. */
export interface TrustedJudgeProgram {
  readonly runtimeProfile: TrustedJudgeRuntimeProfile;
  readonly wasm: Uint8Array;
}

export interface TrustedJudgeWasmInfo {
  readonly bytes: number;
  readonly initialMemoryPages: number;
  readonly maximumMemoryPages?: number;
  readonly imports: readonly string[];
}

export interface TrustedJudgeWasmValidationOptions {
  /** Problem-level memory ceiling used to reject an impossible initial memory. */
  readonly memoryLimitBytes?: number;
}

interface FunctionType {
  readonly parameters: readonly number[];
  readonly results: readonly number[];
}

interface ExportEntry {
  readonly name: string;
  readonly kind: number;
  readonly index: number;
}

class WasmReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array, private readonly label: string) {}

  get remaining(): number { return this.bytes.byteLength - this.offset; }

  done(): boolean { return this.offset === this.bytes.byteLength; }

  requireDone(): void {
    if (!this.done()) throw new TypeError(`${this.label} has trailing bytes.`);
  }

  byte(): number {
    if (this.offset >= this.bytes.byteLength) throw new TypeError(`${this.label} is truncated.`);
    return this.bytes[this.offset++]!;
  }

  u32(): number {
    let value = 0;
    let shift = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.byte();
      if (index === 4 && (byte & 0xf0) !== 0) throw new TypeError(`${this.label} contains an overflowing varuint32.`);
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value >>> 0;
      shift += 7;
    }
    throw new TypeError(`${this.label} contains an invalid varuint32.`);
  }

  vector<T>(read: (reader: WasmReader, index: number) => T): T[] {
    const count = this.u32();
    const result: T[] = [];
    for (let index = 0; index < count; index += 1) result.push(read(this, index));
    return result;
  }

  name(): string {
    const length = this.u32();
    if (length > 4_096 || length > this.remaining) throw new TypeError(`${this.label} contains an invalid name length.`);
    const bytes = this.take(length);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new TypeError(`${this.label} contains a non-UTF-8 name.`, { cause: error });
    }
  }

  take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) throw new TypeError(`${this.label} is truncated.`);
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  section(length: number, label: string): WasmReader {
    return new WasmReader(this.take(length), label);
  }
}

function valueType(reader: WasmReader): number {
  const type = reader.byte();
  if (!VALUE_TYPES.has(type)) {
    throw new TypeError("Trusted judge Wasm uses a type outside the admitted core value-type surface.");
  }
  return type;
}

function parseTypes(section: WasmReader): FunctionType[] {
  const result = section.vector((reader) => {
    if (reader.byte() !== 0x60) throw new TypeError("Trusted judge Wasm may declare only core function types.");
    const parameters = reader.vector((item) => valueType(item));
    const results = reader.vector((item) => valueType(item));
    return { parameters, results };
  });
  section.requireDone();
  return result;
}

function parseImports(section: WasmReader): { readonly typeIndices: number[]; readonly names: string[] } {
  const typeIndices: number[] = [];
  const names: string[] = [];
  section.vector((reader) => {
    const namespace = reader.name();
    const name = reader.name();
    const kind = reader.byte();
    if (kind !== 0) throw new TypeError(`Trusted judge import '${namespace}.${name}' must be a function.`);
    if (namespace !== "wasi_snapshot_preview1" || !TRUSTED_JUDGE_WASIP1_IMPORTS.has(name)) {
      throw new TypeError(`Trusted judge import '${namespace}.${name}' is outside the admitted WASI Preview 1 surface.`);
    }
    typeIndices.push(reader.u32());
    names.push(`${namespace}.${name}`);
  });
  section.requireDone();
  return { typeIndices, names };
}

function parseFunctions(section: WasmReader): number[] {
  const result = section.vector((reader) => reader.u32());
  section.requireDone();
  return result;
}

function parseMemory(section: WasmReader): { readonly initial: number; readonly maximum?: number } {
  const memories = section.vector((reader) => {
    const flags = reader.u32();
    if (flags !== 0 && flags !== 1) {
      throw new TypeError("Trusted judge memory must be 32-bit, unshared, and use the default page size.");
    }
    const initial = reader.u32();
    const maximum = flags === 1 ? reader.u32() : undefined;
    if (maximum !== undefined && maximum < initial) throw new TypeError("Trusted judge memory maximum is below its initial size.");
    return { initial, ...(maximum === undefined ? {} : { maximum }) };
  });
  section.requireDone();
  if (memories.length !== 1) throw new TypeError("Trusted judge Wasm must define exactly one linear memory.");
  return memories[0]!;
}

function parseExports(section: WasmReader): ExportEntry[] {
  const result = section.vector((reader) => ({ name: reader.name(), kind: reader.byte(), index: reader.u32() }));
  section.requireDone();
  return result;
}

function assertHeader(bytes: Uint8Array): void {
  if (bytes.byteLength < WASM_MAGIC.length || WASM_MAGIC.some((byte, index) => bytes[index] !== byte)) {
    throw new TypeError("Trusted judge artifact is not a core WebAssembly v1 module.");
  }
}

/**
 * Pure static admission for prebuilt checker/interactor modules. It validates
 * structure and ABI only; it never compiles, instantiates, or executes guest code.
 */
export function validateTrustedJudgeWasm(
  bytes: Uint8Array,
  options: TrustedJudgeWasmValidationOptions = {},
): TrustedJudgeWasmInfo {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < WASM_MAGIC.length || bytes.byteLength > TRUSTED_JUDGE_WASM_MAX_BYTES) {
    throw new TypeError("Trusted judge Wasm is outside the 8 MiB artifact limit.");
  }
  assertHeader(bytes);
  if (!WebAssembly.validate(bytes.slice().buffer)) throw new TypeError("Trusted judge artifact is not valid WebAssembly for the active runtime.");
  if (options.memoryLimitBytes !== undefined && (
    !Number.isSafeInteger(options.memoryLimitBytes)
    || options.memoryLimitBytes < WASM_PAGE_BYTES
    || options.memoryLimitBytes % WASM_PAGE_BYTES !== 0
  )) throw new TypeError("Trusted judge memory limit must be a positive multiple of 64 KiB.");

  const reader = new WasmReader(bytes.subarray(WASM_MAGIC.length), "trusted judge module");
  let types: FunctionType[] = [];
  let importedTypes: number[] = [];
  let importNames: string[] = [];
  let definedTypes: number[] = [];
  let memory: { readonly initial: number; readonly maximum?: number } | undefined;
  let exports: ExportEntry[] = [];
  while (!reader.done()) {
    const id = reader.byte();
    const length = reader.u32();
    const section = reader.section(length, `trusted judge section ${id}`);
    if (id === 0) continue;
    if (id === 1) types = parseTypes(section);
    else if (id === 2) ({ typeIndices: importedTypes, names: importNames } = parseImports(section));
    else if (id === 3) definedTypes = parseFunctions(section);
    else if (id === 5) memory = parseMemory(section);
    else if (id === 7) exports = parseExports(section);
    else if (id === 8) throw new TypeError("Trusted judge Wasm must not declare a start section; '_start' is the only entrypoint.");
  }
  if (!memory) throw new TypeError("Trusted judge Wasm must define exactly one linear memory.");
  if (options.memoryLimitBytes !== undefined && memory.initial * WASM_PAGE_BYTES > options.memoryLimitBytes) {
    throw new TypeError("Trusted judge initial memory exceeds the problem memory limit.");
  }
  for (const entry of exports) {
    if (RESERVED_EXPORTS.has(entry.name) || entry.name.startsWith("__wasm_oj_")) {
      throw new TypeError(`Trusted judge export '${entry.name}' is reserved by WASM-OJ.`);
    }
    if (entry.name !== "memory" && entry.name !== "_start") {
      throw new TypeError(`Trusted judge export '${entry.name}' is outside the admitted command ABI.`);
    }
  }
  const memoryExport = exports.filter((entry) => entry.name === "memory");
  if (memoryExport.length !== 1 || memoryExport[0]!.kind !== 2 || memoryExport[0]!.index !== 0) {
    throw new TypeError("Trusted judge Wasm must export its sole linear memory as 'memory'.");
  }
  const startExports = exports.filter((entry) => entry.name === "_start");
  if (startExports.length !== 1 || startExports[0]!.kind !== 0) {
    throw new TypeError("Trusted judge Wasm must export exactly one '_start' function.");
  }
  const startIndex = startExports[0]!.index;
  if (startIndex < importedTypes.length) throw new TypeError("Trusted judge '_start' must be defined by the module.");
  const typeIndex = definedTypes[startIndex - importedTypes.length];
  const type = typeIndex === undefined ? undefined : types[typeIndex];
  if (!type || type.parameters.length !== 0 || type.results.length !== 0) {
    throw new TypeError("Trusted judge '_start' must have the signature () -> ().");
  }
  for (const typeIndexValue of [...importedTypes, ...definedTypes]) {
    if (!types[typeIndexValue]) throw new TypeError("Trusted judge function refers to a missing type.");
  }
  if (new Set(importNames).size !== importNames.length) throw new TypeError("Trusted judge Wasm repeats a WASI import.");
  for (const [index, qualifiedName] of importNames.entries()) {
    const name = qualifiedName.slice("wasi_snapshot_preview1.".length);
    const expected = WASIP1_SIGNATURES[name]!;
    const actual = types[importedTypes[index]!]!;
    if (
      JSON.stringify(actual.parameters) !== JSON.stringify(expected.parameters)
      || JSON.stringify(actual.results) !== JSON.stringify(expected.results)
    ) throw new TypeError(`Trusted judge import '${qualifiedName}' has an invalid WASI ABI signature.`);
  }
  return {
    bytes: bytes.byteLength,
    initialMemoryPages: memory.initial,
    ...(memory.maximum === undefined ? {} : { maximumMemoryPages: memory.maximum }),
    imports: [...importNames],
  };
}
