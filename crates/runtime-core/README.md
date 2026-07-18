# wasm-oj-forge-runtime-core

Portable deterministic WASI/WASIX execution core for WASM OJ Forge.

The crate exposes `run(RunRequest) -> Result<RunResult, RunError>` and the serialization-friendly `run_response(RunRequest) -> RunResponse`. Both native and `wasm32-unknown-unknown` builds apply the same module transforms, deterministic imports, filesystem construction, metering model, and result contract.

```rust
use wasm_oj_forge_runtime_core::{
    run, DeterminismConfig, ResourcePolicy, RunRequest,
};
use std::collections::BTreeMap;

let result = run(RunRequest {
    wasm,
    args: vec![],
    env: BTreeMap::new(),
    stdin: b"1 2\n".to_vec(),
    files: BTreeMap::new(),
    output_paths: Vec::new(),
    cwd: None,
    startup_entropy_bytes: 0,
    determinism: DeterminismConfig {
        random_seed: 0x5eed_1234,
        realtime_epoch_ms: 946_684_800_000,
        clock_step_ns: 1_000_000,
    },
    resources: ResourcePolicy {
        instruction_budget: 10_000_000_000,
        logical_time_limit_ms: 60_000,
        memory_limit_bytes: 256 * 1024 * 1024,
        output_limit_bytes: 4 * 1024 * 1024,
        filesystem_write_limit_bytes: 64 * 1024 * 1024,
        filesystem_entry_limit: 4_096,
    },
})?;
```

Instruction, logical-time, memory, output, and filesystem limits are enforced inside the core. Sleep and clock polling fast-forward a shared virtual clock and never wait for host time. A hard emergency wall deadline must live outside an in-process Wasmer call; `ServerForgeRunner` therefore invokes the native runner binary as a killable child process, while the browser adapter invokes the WebAssembly build in a replaceable Worker.

Build targets:

```bash
pnpm run runtime:build-native
pnpm run runtime:build
```

The native CLI accepts Forge contract 1 `wasm-oj-forge-v1/run-request` JSON on stdin or through `--request REQUEST.json`, with binary fields encoded as base64. The browser binding uses the same logical `RunRequest` and `RunResult` fields through its JavaScript interface, with binary values transferred as typed arrays; the transports are intentionally host-specific.
