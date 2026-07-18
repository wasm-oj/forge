use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn native_cli_uses_the_library_wire_contract() {
    let wasm = wat::parse_str(
        "(module (memory (export \"memory\") 1) (func (export \"_start\") i32.const 1 drop))",
    )
    .unwrap();
    let request = serde_json::json!({
        "schema": wasm_oj_forge_runtime_core::FORGE_RUN_REQUEST_SCHEMA,
        "wasmBase64": STANDARD.encode(wasm),
        "args": [],
        "env": {},
        "stdinBase64": "",
        "filesBase64": {},
        "cwd": null,
        "startupEntropyBytes": 0,
        "determinism": {
            "randomSeed": 7,
            "realtimeEpochMs": 946_684_800_000_u64,
            "clockStepNs": 1_000_000,
        },
        "resources": {
            "instructionBudget": 1_000_000,
            "logicalTimeLimitMs": 60_000,
            "memoryLimitBytes": 2 * 65_536,
            "outputLimitBytes": 1_024,
            "filesystemWriteLimitBytes": 64 * 1024 * 1024,
            "filesystemEntryLimit": 4_096,
        },
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_forge-runner"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    serde_json::to_writer(child.stdin.as_mut().unwrap(), &request).unwrap();
    child.stdin.take().unwrap().flush().unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["metrics"]["costModel"], "weighted");
}

#[test]
fn compiler_cli_rejects_removed_request_determinism() {
    let request = serde_json::json!({
        "schema": wasm_oj_forge_runtime_core::FORGE_COMPILE_BATCH_SCHEMA,
        "packageBase64": "",
        "memoryLimitBytes": 65_536,
        "requests": [{
            "command": "clang",
            "args": [],
            "env": {},
            "stdinBase64": "",
            "filesBase64": {},
            "cwd": null,
            "outputPaths": [],
            "outputLimitBytes": 1_024,
            "determinism": {
                "randomSeed": 7,
                "realtimeEpochMs": 946_684_800_000_u64,
                "clockStepNs": 1_000_000,
            },
        }],
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_forge-compiler"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    serde_json::to_writer(child.stdin.as_mut().unwrap(), &request).unwrap();
    child.stdin.take().unwrap().flush().unwrap();
    let output = child.wait_with_output().unwrap();

    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("unknown field `determinism`"), "{stderr}");
}
