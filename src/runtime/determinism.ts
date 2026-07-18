import { resolveDeterminism } from "../core/determinism.ts";
import type { DeterminismConfig } from "../core/types.ts";

export const DETERMINISTIC_NATIVE_SOURCE_PATH = ".forge/determinism.c";
export const PYTHON_RUNNER_PATH = ".forge/deterministic_runner.py";

const RESERVED_ENVIRONMENT = new Set([
  "FORGE_RANDOM_SEED",
  "FORGE_REALTIME_EPOCH_MS",
  "FORGE_CLOCK_STEP_NS",
  "PYTHONHASHSEED",
  "TZ",
  "LC_ALL",
]);

export function deterministicEnvironment(
  environment: Readonly<Record<string, string>>,
  config: DeterminismConfig,
): Record<string, string> {
  const determinism = resolveDeterminism(config);
  const conflict = Object.keys(environment).find((name) => RESERVED_ENVIRONMENT.has(name));
  if (conflict) throw new Error(`Environment variable '${conflict}' is reserved by the deterministic runner.`);
  return {
    ...environment,
    FORGE_RANDOM_SEED: String(determinism.randomSeed).padStart(10, "0"),
    FORGE_REALTIME_EPOCH_MS: String(determinism.realtimeEpochMs).padStart(14, "0"),
    FORGE_CLOCK_STEP_NS: String(determinism.clockStepNs).padStart(10, "0"),
    // Hash randomization affects interpreter bootstrap cost. Disable it so the
    // user entropy seed controls public random APIs without changing overhead.
    PYTHONHASHSEED: "0",
    TZ: "UTC",
    LC_ALL: "C",
  };
}

export const DETERMINISTIC_NATIVE_RUNTIME = String.raw`
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

static uint32_t forge_random_state;
static int forge_initialized;

static uint64_t forge_parse_u64(const char *value) {
    if (!value || !*value) abort();
    uint64_t result = 0;
    for (const unsigned char *cursor = (const unsigned char *)value; *cursor; ++cursor) {
        if (*cursor < '0' || *cursor > '9') abort();
        uint64_t digit = (uint64_t)(*cursor - '0');
        if (result > (UINT64_MAX - digit) / 10) abort();
        result = result * 10 + digit;
    }
    return result;
}

static void forge_initialize(void) {
    if (forge_initialized) return;
    uint64_t seed = forge_parse_u64(getenv("FORGE_RANDOM_SEED"));
    forge_random_state = (uint32_t)seed;
    forge_initialized = 1;
}

static uint32_t forge_next_u32(void) {
    forge_random_state += 0x9e3779b9u;
    uint32_t value = forge_random_state;
    value ^= value >> 16;
    value *= 0x21f0aaadu;
    value ^= value >> 15;
    value *= 0x735a2d97u;
    value ^= value >> 15;
    return value;
}

uint32_t __imported_wasi_snapshot_preview1_random_get(uint8_t *buffer, size_t length) {
    forge_initialize();
    uint32_t word = 0;
    for (size_t index = 0; index < length; ++index) {
        if ((index & 3u) == 0) word = forge_next_u32();
        buffer[index] = (uint8_t)(word >> ((index & 3u) * 8u));
    }
    return 0;
}

#ifdef __cplusplus
}
#endif
`;

export const PYTHON_DETERMINISTIC_RUNNER = String.raw`
import os as _os
import runpy as _runpy
import sys as _sys

_random_state = None

def _random_seed():
    global _random_state
    if _random_state is None:
        _random_state = int(_os.environ["FORGE_RANDOM_SEED"]) & 0xffffffff
    return _random_state

def _next_u32():
    global _random_state
    _random_seed()
    _random_state = (_random_state + 0x9e3779b9) & 0xffffffff
    value = _random_state
    value ^= value >> 16
    value = (value * 0x21f0aaad) & 0xffffffff
    value ^= value >> 15
    value = (value * 0x735a2d97) & 0xffffffff
    value ^= value >> 15
    return value & 0xffffffff

def _urandom(length):
    if not isinstance(length, int) or length < 0:
        raise ValueError("negative argument not allowed")
    output = bytearray(length)
    word = 0
    for index in range(length):
        if index % 4 == 0:
            word = _next_u32()
        output[index] = (word >> ((index % 4) * 8)) & 0xff
    return bytes(output)

_os.urandom = _urandom
if hasattr(_os, "getrandom"):
    _os.getrandom = lambda size, flags=0: _urandom(size)

_entry = _sys.argv[1]
_sys.argv = [_entry, *_sys.argv[2:]]
_runpy.run_path(_entry, run_name="__main__")
`;

export function quickJsDeterminismPrelude(config: DeterminismConfig): string {
  resolveDeterminism(config);
  return String.raw`
const __forgeDeterminism = (() => {
  const readSeed = globalThis.__forge_determinism_seed;
  const readEpochMs = globalThis.__forge_determinism_epoch_ms;
  const readStepNs = globalThis.__forge_determinism_step_ns;
  delete globalThis.__forge_determinism_seed;
  delete globalThis.__forge_determinism_epoch_ms;
  delete globalThis.__forge_determinism_step_ns;
  let parsedConfig;
  const config = () => parsedConfig ??= Object.freeze({
    seed: readSeed(),
    epochMs: readEpochMs(),
    stepNs: readStepNs(),
  });
  let randomState;
  const NativeDate = Date;
  const nextU32 = () => {
    if (randomState === undefined) randomState = config().seed >>> 0;
    randomState = (randomState + 0x9e3779b9) >>> 0;
    let value = randomState;
    value ^= value >>> 16;
    value = Math.imul(value, 0x21f0aaad);
    value ^= value >>> 15;
    value = Math.imul(value, 0x735a2d97);
    value ^= value >>> 15;
    return value >>> 0;
  };
  Math.random = () => nextU32() / 4294967296;
  Object.defineProperty(globalThis, "performance", {
    value: Object.freeze({ now: () => NativeDate.now() - config().epochMs, get timeOrigin() { return config().epochMs; } }),
    configurable: true,
  });
  const getRandomValues = (view) => {
    const tag = Object.prototype.toString.call(view);
    const integerTypedArrays = [
      "[object Int8Array]", "[object Uint8Array]", "[object Uint8ClampedArray]",
      "[object Int16Array]", "[object Uint16Array]", "[object Int32Array]", "[object Uint32Array]",
      "[object BigInt64Array]", "[object BigUint64Array]",
    ];
    if (!integerTypedArrays.includes(tag)) throw new TypeError("Expected an integer TypedArray");
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    let word = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (index % 4 === 0) word = nextU32();
      bytes[index] = (word >>> ((index % 4) * 8)) & 0xff;
    }
    return view;
  };
  const randomUUID = () => {
    const bytes = getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
    return hex.slice(0, 4).join("") + "-" + hex.slice(4, 6).join("") + "-" + hex.slice(6, 8).join("") + "-" + hex.slice(8, 10).join("") + "-" + hex.slice(10).join("");
  };
  Object.defineProperty(globalThis, "crypto", {
    value: Object.freeze({ getRandomValues, randomUUID }),
    configurable: true,
  });
  return Object.freeze({ get seed() { return config().seed; }, get epochMs() { return config().epochMs; }, get stepNs() { return config().stepNs; } });
})();
`;
}
