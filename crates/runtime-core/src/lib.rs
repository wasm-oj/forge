//! One execution contract for browser and server hosts.

mod capabilities;
mod compiler;
mod contract;
mod deterministic;
mod error;
mod filesystem;
mod filesystem_quota;
mod interactive;
mod memory;
mod meter;
mod module_imports;
mod module_policy;
mod output;
mod run;
mod types;

pub use compiler::CompilerToolchain;
pub use contract::{
    FORGE_COMPILE_BATCH_SCHEMA, FORGE_CONTRACT_VERSION, FORGE_INTERACTIVE_REQUEST_SCHEMA,
    FORGE_RUN_REQUEST_SCHEMA,
};
pub use error::{RunError, RunErrorCode};
pub use interactive::interact;
pub use meter::{METER_MODEL, instrument_wasm};
pub use module_policy::enforce_memory_limit;
pub use run::run;
pub use types::{
    CompilePipelineRequest, CompilePipelineResponse, CompilePipelineResult, CompileRequest,
    CompileResponse, CompileResult, CompilerToolchainConfig, DeterminismConfig, ExecutionMetrics,
    ExecutionTermination, InteractiveMetrics, InteractiveProcessResult, InteractiveProgram,
    InteractiveRequest, InteractiveResponse, InteractiveResult, ResourcePolicy, RunFailure,
    RunRequest, RunResponse, RunResult,
};

pub async fn compile_pipeline_response(request: CompilePipelineRequest) -> CompilePipelineResponse {
    let result = async {
        let toolchain = CompilerToolchain::new(request.toolchain)?;
        toolchain
            .compile_pipeline(request.files, request.stages)
            .await
    }
    .await;
    match result {
        Ok(result) => CompilePipelineResponse {
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => CompilePipelineResponse {
            ok: false,
            result: None,
            error: Some(RunFailure {
                code: error.code(),
                message: error.to_string(),
            }),
        },
    }
}

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
