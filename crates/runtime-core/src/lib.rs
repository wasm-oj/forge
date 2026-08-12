//! One execution contract for browser and server hosts.

mod capabilities;
mod compiler;
mod contract;
mod deterministic;
mod error;
mod filesystem;
mod filesystem_quota;
mod go_compiler_session;
mod interactive;
mod judge_package;
mod memory;
mod meter;
mod module_imports;
mod module_policy;
mod output;
mod run;
mod types;

pub use compiler::CompilerToolchain;
pub use contract::{
    WASM_OJ_COMPILE_BATCH_SCHEMA, WASM_OJ_CONTRACT_ID, WASM_OJ_CONTRACT_VERSION,
    WASM_OJ_INTERACTIVE_REQUEST_SCHEMA, WASM_OJ_RUN_REQUEST_SCHEMA,
};
pub use error::{RunError, RunErrorCode};
pub use go_compiler_session::GoCompilerSession;
pub use interactive::interact;
pub use judge_package::{
    JudgePackageError, JudgePackageManifest, JudgePackageValidationOptions,
    TRUSTED_JUDGE_WASM_MAX_BYTES, TrustedJudgeWasmInfo, ValidatedJudgePackage,
    WASM_OJ_JUDGE_PACKAGE_MAGIC, WASM_OJ_JUDGE_PACKAGE_MAX_BYTES, WASM_OJ_JUDGE_PACKAGE_SCHEMA,
    validate_judge_package, validate_judge_package_with_options, validate_trusted_judge_wasm,
};
pub use meter::{METER_MODEL, instrument_wasm};
pub use module_policy::enforce_memory_limit;
pub use run::run;
pub use types::{
    CompilePipelineResponse, CompilePipelineResult, CompileRequest, CompileResponse, CompileResult,
    CompilerToolchainConfig, DeterminismConfig, ExecutionMetrics, ExecutionTermination,
    GoCompilerSessionConfig, GoCompilerSessionRequest, GoCompilerSessionResponse,
    GoCompilerSourceDelta, InteractiveMetrics, InteractiveProcessResult, InteractiveProgram,
    InteractiveRequest, InteractiveResponse, InteractiveResult, ResourcePolicy, RunFailure,
    RunRequest, RunResponse, RunResult,
};

pub fn run_response(request: RunRequest) -> RunResponse {
    match run(request) {
        Ok(result) => RunResponse {
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => RunResponse {
            ok: false,
            result: None,
            error: Some(RunFailure {
                code: error.code(),
                message: error.to_string(),
            }),
        },
    }
}

pub async fn interactive_response(request: InteractiveRequest) -> InteractiveResponse {
    match interact(request).await {
        Ok(result) => InteractiveResponse {
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => InteractiveResponse {
            ok: false,
            result: None,
            error: Some(RunFailure {
                code: error.code(),
                message: error.to_string(),
            }),
        },
    }
}

pub(crate) fn wasi_error(error: &wasmer::RuntimeError) -> Option<&wasmer_wasix::WasiError> {
    let mut current = error;
    loop {
        if let Some(wasi) = current.downcast_ref::<wasmer_wasix::WasiError>() {
            return Some(wasi);
        }
        let nested = current.downcast_ref::<wasmer::RuntimeError>()?;
        if std::ptr::eq(current, nested) {
            return None;
        }
        current = nested;
    }
}

#[cfg(all(feature = "web", target_arch = "wasm32"))]
mod web;
