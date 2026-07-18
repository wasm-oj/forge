use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, Read};
use std::path::PathBuf;
use wasm_oj_forge_runtime_core::{
    CompileRequest, CompileResponse, CompilerToolchain, CompilerToolchainConfig,
    ExecutionTermination, FORGE_COMPILE_BATCH_SCHEMA, RunFailure,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CliCompileBatch {
    schema: String,
    /// Path to the compiler WebC package on the host filesystem.
    package_path: Option<String>,
    /// Inline base64 alternative for small packages.
    package_base64: Option<String>,
    memory_limit_bytes: u64,
    shared_files_base64: Option<BTreeMap<String, String>>,
    requests: Vec<CliCompileRequest>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CliCompileRequest {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    stdin_base64: String,
    #[serde(default)]
    files_base64: BTreeMap<String, String>,
    cwd: Option<String>,
    #[serde(default)]
    output_paths: Vec<String>,
    output_limit_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliCompileResult {
    code: i32,
    stdout_base64: String,
    stderr_base64: String,
    output_files_base64: BTreeMap<String, String>,
    termination: ExecutionTermination,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliCompileResponse {
    ok: bool,
    result: Option<CliCompileResult>,
    error: Option<RunFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliCompileBatchResponse {
    ok: bool,
    responses: Vec<CliCompileResponse>,
}

fn main() {
    match execute() {
        Ok(true) => {}
        Ok(false) => std::process::exit(1),
        Err(error) => {
            eprintln!("forge-compiler: {error}");
            std::process::exit(2);
        }
    }
}

fn execute() -> Result<bool, String> {
    let input = read_input()?;
    let batch: CliCompileBatch =
        serde_json::from_slice(&input).map_err(|error| format!("invalid request JSON: {error}"))?;
    if batch.schema != FORGE_COMPILE_BATCH_SCHEMA {
        return Err(format!(
            "unsupported request schema '{}'; expected '{FORGE_COMPILE_BATCH_SCHEMA}'",
            batch.schema
        ));
    }
    let package = match (&batch.package_path, &batch.package_base64) {
        (Some(path), None) => std::fs::read(path)
            .map_err(|error| format!("failed to read compiler package '{path}': {error}"))?,
        (None, Some(encoded)) => STANDARD
            .decode(encoded)
            .map_err(|error| format!("invalid packageBase64: {error}"))?,
        _ => return Err("exactly one of packagePath or packageBase64 is required".to_string()),
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()
        .map_err(|error| format!("failed to initialize Tokio: {error}"))?;
    let _guard = runtime.enter();
    let toolchain = CompilerToolchain::new(CompilerToolchainConfig {
        package,
        memory_limit_bytes: batch.memory_limit_bytes,
    })
    .map_err(|error| format!("failed to load compiler toolchain: {error}"))?;

    let requests = batch
        .requests
        .into_iter()
        .map(decode_request)
        .collect::<Result<Vec<_>, _>>()?;
    let (ok, responses) = if let Some(shared) = batch.shared_files_base64 {
        let files = decode_files(shared)?;
        match runtime.block_on(toolchain.compile_pipeline(files, requests)) {
            Ok(result) => {
                let ok = result.stages.iter().all(|stage| stage.code == 0);
                let responses = result
                    .stages
                    .into_iter()
                    .map(|result| encode_response(RunResponseLike::success(result)))
                    .collect();
                (ok, responses)
            }
            Err(error) => (
                false,
                vec![encode_response(RunResponseLike::failure(error))],
            ),
        }
    } else {
        let mut responses = Vec::with_capacity(requests.len());
        let mut ok = true;
        for request in requests {
            let response = runtime.block_on(toolchain.compile_response(request));
            ok = ok && response.ok;
            responses.push(encode_response(response));
        }
        (ok, responses)
    };
    let batch_response = CliCompileBatchResponse { ok, responses };
    serde_json::to_writer(io::stdout().lock(), &batch_response)
        .map_err(|error| format!("failed to serialize response: {error}"))?;
    Ok(batch_response.ok)
}

fn decode_request(encoded: CliCompileRequest) -> Result<CompileRequest, String> {
    let files = decode_files(encoded.files_base64)?;
    Ok(CompileRequest {
        command: encoded.command,
        args: encoded.args,
        env: encoded.env,
        stdin: STANDARD
            .decode(encoded.stdin_base64)
            .map_err(|error| format!("invalid stdinBase64: {error}"))?,
        files,
        cwd: encoded.cwd,
        output_paths: encoded.output_paths,
        output_limit_bytes: encoded.output_limit_bytes,
    })
}

fn decode_files(
    encoded: BTreeMap<String, String>,
) -> Result<BTreeMap<String, serde_bytes::ByteBuf>, String> {
    encoded
        .into_iter()
        .map(|(path, contents)| {
            let bytes = STANDARD
                .decode(contents)
                .map_err(|error| format!("invalid base64 for guest file '{path}': {error}"))?;
            Ok((path, serde_bytes::ByteBuf::from(bytes)))
        })
        .collect()
}

struct RunResponseLike;

impl RunResponseLike {
    fn success(result: wasm_oj_forge_runtime_core::CompileResult) -> CompileResponse {
        CompileResponse {
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn failure(error: wasm_oj_forge_runtime_core::RunError) -> CompileResponse {
        CompileResponse {
            ok: false,
            result: None,
            error: Some(RunFailure {
                code: error.code(),
                message: error.to_string(),
            }),
        }
    }
}

fn encode_response(response: CompileResponse) -> CliCompileResponse {
    CliCompileResponse {
        ok: response.ok,
        result: response.result.map(|result| CliCompileResult {
            code: result.code,
            stdout_base64: STANDARD.encode(result.stdout),
            stderr_base64: STANDARD.encode(result.stderr),
            output_files_base64: result
                .output_files
                .into_iter()
                .map(|(path, bytes)| (path, STANDARD.encode(bytes)))
                .collect(),
            termination: result.termination,
        }),
        error: response.error,
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
        _ => Err("usage: forge-compiler [--request REQUEST.json]".to_string()),
    }
}
