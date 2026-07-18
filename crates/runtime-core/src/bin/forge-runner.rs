use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, Read};
use std::path::PathBuf;
use wasm_oj_forge_runtime_core::{
    DeterminismConfig, ExecutionMetrics, ExecutionTermination, FORGE_INTERACTIVE_REQUEST_SCHEMA,
    FORGE_RUN_REQUEST_SCHEMA, InteractiveMetrics, InteractiveProcessResult, InteractiveProgram,
    InteractiveRequest, InteractiveResponse, InteractiveResult, ResourcePolicy, RunFailure,
    RunRequest, RunResponse, RunResult, interactive_response, run_response,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CliRunRequest {
    #[serde(rename = "schema")]
    _schema: String,
    wasm_base64: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    stdin_base64: String,
    #[serde(default)]
    files_base64: BTreeMap<String, String>,
    #[serde(default)]
    output_paths: Vec<String>,
    cwd: Option<String>,
    startup_entropy_bytes: u64,
    determinism: DeterminismConfig,
    resources: ResourcePolicy,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliRunResult {
    code: i32,
    stdout_base64: String,
    stderr_base64: String,
    files_base64: BTreeMap<String, String>,
    termination: ExecutionTermination,
    trap_message: Option<String>,
    metrics: ExecutionMetrics,
    determinism: DeterminismConfig,
    resources: ResourcePolicy,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliRunResponse {
    ok: bool,
    result: Option<CliRunResult>,
    error: Option<RunFailure>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CliInteractiveRequest {
    #[serde(rename = "schema")]
    _schema: String,
    contestant: CliInteractiveProgram,
    interactor: CliInteractiveProgram,
    determinism: DeterminismConfig,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CliInteractiveProgram {
    wasm_base64: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    files_base64: BTreeMap<String, String>,
    cwd: Option<String>,
    startup_entropy_bytes: u64,
    resources: ResourcePolicy,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliInteractiveProcessResult {
    code: i32,
    stderr_base64: String,
    termination: ExecutionTermination,
    metrics: InteractiveMetrics,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliInteractiveResult {
    contestant: CliInteractiveProcessResult,
    interactor: CliInteractiveProcessResult,
    contestant_to_interactor_base64: String,
    interactor_to_contestant_base64: String,
    determinism: DeterminismConfig,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliInteractiveResponse {
    ok: bool,
    result: Option<CliInteractiveResult>,
    error: Option<RunFailure>,
}

fn main() {
    match execute() {
        Ok(true) => {}
        Ok(false) => std::process::exit(1),
        Err(error) => {
            eprintln!("forge-runner: {error}");
            std::process::exit(2);
        }
    }
}

fn execute() -> Result<bool, String> {
    let input = read_input()?;
    let value: serde_json::Value =
        serde_json::from_slice(&input).map_err(|error| format!("invalid request JSON: {error}"))?;
    let schema = value
        .get("schema")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "request schema must be a string".to_string())?;
    match schema {
        FORGE_RUN_REQUEST_SCHEMA => execute_run(value),
        FORGE_INTERACTIVE_REQUEST_SCHEMA => execute_interactive(value),
        value => Err(format!("unsupported request schema '{value}'")),
    }
}

fn execute_run(value: serde_json::Value) -> Result<bool, String> {
    let encoded: CliRunRequest = serde_json::from_value(value)
        .map_err(|error| format!("invalid run request JSON: {error}"))?;
    let response = encode_response(run_response(decode_request(encoded)?));
    serde_json::to_writer(io::stdout().lock(), &response)
        .map_err(|error| format!("failed to serialize response: {error}"))?;
    Ok(response.ok)
}

fn execute_interactive(value: serde_json::Value) -> Result<bool, String> {
    let encoded: CliInteractiveRequest = serde_json::from_value(value)
        .map_err(|error| format!("invalid interactive request JSON: {error}"))?;
    let request = InteractiveRequest {
        contestant: decode_interactive_program(encoded.contestant, "contestant")?,
        interactor: decode_interactive_program(encoded.interactor, "interactor")?,
        determinism: encoded.determinism,
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("failed to initialize interactive runtime: {error}"))?;
    let response = encode_interactive_response(runtime.block_on(interactive_response(request)));
    serde_json::to_writer(io::stdout().lock(), &response)
        .map_err(|error| format!("failed to serialize response: {error}"))?;
    Ok(response.ok)
}

fn decode_request(encoded: CliRunRequest) -> Result<RunRequest, String> {
    let mut files = BTreeMap::new();
    for (path, contents) in encoded.files_base64 {
        files.insert(
            path.clone(),
            serde_bytes::ByteBuf::from(
                STANDARD
                    .decode(contents)
                    .map_err(|error| format!("invalid base64 for guest file '{path}': {error}"))?,
            ),
        );
    }
    Ok(RunRequest {
        wasm: STANDARD
            .decode(encoded.wasm_base64)
            .map_err(|error| format!("invalid wasmBase64: {error}"))?,
        args: encoded.args,
        env: encoded.env,
        stdin: STANDARD
            .decode(encoded.stdin_base64)
            .map_err(|error| format!("invalid stdinBase64: {error}"))?,
        files,
        output_paths: encoded.output_paths,
        cwd: encoded.cwd,
        startup_entropy_bytes: encoded.startup_entropy_bytes,
        determinism: encoded.determinism,
        resources: encoded.resources,
    })
}

fn decode_interactive_program(
    encoded: CliInteractiveProgram,
    label: &str,
) -> Result<InteractiveProgram, String> {
    let mut files = BTreeMap::new();
    for (path, contents) in encoded.files_base64 {
        files.insert(
            path.clone(),
            serde_bytes::ByteBuf::from(STANDARD.decode(contents).map_err(|error| {
                format!("invalid base64 for {label} guest file '{path}': {error}")
            })?),
        );
    }
    Ok(InteractiveProgram {
        wasm: STANDARD
            .decode(encoded.wasm_base64)
            .map_err(|error| format!("invalid {label} wasmBase64: {error}"))?,
        args: encoded.args,
        env: encoded.env,
        files,
        cwd: encoded.cwd,
        startup_entropy_bytes: encoded.startup_entropy_bytes,
        resources: encoded.resources,
    })
}

fn encode_response(response: RunResponse) -> CliRunResponse {
    CliRunResponse {
        ok: response.ok,
        result: response.result.map(encode_result),
        error: response.error,
    }
}

fn encode_result(result: RunResult) -> CliRunResult {
    CliRunResult {
        code: result.code,
        stdout_base64: STANDARD.encode(result.stdout),
        stderr_base64: STANDARD.encode(result.stderr),
        files_base64: result
            .files
            .into_iter()
            .map(|(path, contents)| (path, STANDARD.encode(contents)))
            .collect(),
        termination: result.termination,
        trap_message: result.trap_message,
        metrics: result.metrics,
        determinism: result.determinism,
        resources: result.resources,
    }
}

fn encode_interactive_response(response: InteractiveResponse) -> CliInteractiveResponse {
    CliInteractiveResponse {
        ok: response.ok,
        result: response.result.map(encode_interactive_result),
        error: response.error,
    }
}

fn encode_interactive_result(result: InteractiveResult) -> CliInteractiveResult {
    CliInteractiveResult {
        contestant: encode_interactive_process(result.contestant),
        interactor: encode_interactive_process(result.interactor),
        contestant_to_interactor_base64: STANDARD.encode(result.contestant_to_interactor),
        interactor_to_contestant_base64: STANDARD.encode(result.interactor_to_contestant),
        determinism: result.determinism,
    }
}

fn encode_interactive_process(result: InteractiveProcessResult) -> CliInteractiveProcessResult {
    CliInteractiveProcessResult {
        code: result.code,
        stderr_base64: STANDARD.encode(result.stderr),
        termination: result.termination,
        metrics: result.metrics,
    }
}

fn read_input() -> Result<Vec<u8>, String> {
    let mut arguments = std::env::args_os();
    let _program = arguments.next();
    let first = arguments.next();
    let second = arguments.next();
    let trailing = arguments.next();
    match (first, second, trailing) {
        (None, None, None) => {
            let mut input = Vec::new();
            io::stdin()
                .lock()
                .read_to_end(&mut input)
                .map_err(|error| format!("failed to read stdin: {error}"))?;
            Ok(input)
        }
        (Some(flag), Some(path), None) if flag == "--request" => {
            let path = PathBuf::from(path);
            std::fs::read(&path)
                .map_err(|error| format!("failed to read {}: {error}", path.display()))
        }
        _ => Err("usage: forge-runner [--request REQUEST.json]".to_string()),
    }
}
