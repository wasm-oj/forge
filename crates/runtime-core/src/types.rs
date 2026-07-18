use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::RunErrorCode;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeterminismConfig {
    pub random_seed: u64,
    pub realtime_epoch_ms: u64,
    pub clock_step_ns: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResourcePolicy {
    pub instruction_budget: u64,
    pub logical_time_limit_ms: u64,
    pub memory_limit_bytes: u64,
    pub output_limit_bytes: u64,
    pub filesystem_write_limit_bytes: u64,
    pub filesystem_entry_limit: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunRequest {
    #[serde(with = "serde_bytes")]
    pub wasm: Vec<u8>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default, with = "serde_bytes")]
    pub stdin: Vec<u8>,
    #[serde(default)]
    pub files: BTreeMap<String, serde_bytes::ByteBuf>,
    #[serde(default)]
    pub output_paths: Vec<String>,
    pub cwd: Option<String>,
    /// Fixed host entropy consumed before the caller-seeded stream.
    pub startup_entropy_bytes: u64,
    pub determinism: DeterminismConfig,
    pub resources: ResourcePolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionTermination {
    Exited,
    InstructionLimit,
    LogicalTimeLimit,
    MemoryLimit,
    OutputLimit,
    FilesystemLimit,
    Trap,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionMetrics {
    pub cost: u64,
    pub cost_model: String,
    pub operations: BTreeMap<String, u64>,
    pub memory_bytes: u64,
    pub logical_time_ns: u64,
    pub filesystem_bytes: u64,
    pub filesystem_entries: u64,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub code: i32,
    #[serde(with = "serde_bytes")]
    pub stdout: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub stderr: Vec<u8>,
    pub files: BTreeMap<String, serde_bytes::ByteBuf>,
    pub termination: ExecutionTermination,
    pub trap_message: Option<String>,
    pub metrics: ExecutionMetrics,
    pub determinism: DeterminismConfig,
    pub resources: ResourcePolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunFailure {
    pub code: RunErrorCode,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunResponse {
    pub ok: bool,
    pub result: Option<RunResult>,
    pub error: Option<RunFailure>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompilerToolchainConfig {
    #[serde(with = "serde_bytes")]
    pub package: Vec<u8>,
    pub memory_limit_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompileRequest {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default, with = "serde_bytes")]
    pub stdin: Vec<u8>,
    #[serde(default)]
    pub files: BTreeMap<String, serde_bytes::ByteBuf>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub output_paths: Vec<String>,
    pub output_limit_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub code: i32,
    #[serde(with = "serde_bytes")]
    pub stdout: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub stderr: Vec<u8>,
    pub output_files: BTreeMap<String, serde_bytes::ByteBuf>,
    pub termination: ExecutionTermination,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompileResponse {
    pub ok: bool,
    pub result: Option<CompileResult>,
    pub error: Option<RunFailure>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompilePipelineRequest {
    pub toolchain: CompilerToolchainConfig,
    #[serde(default)]
    pub files: BTreeMap<String, serde_bytes::ByteBuf>,
    pub stages: Vec<CompileRequest>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompilePipelineResult {
    pub stages: Vec<CompileResult>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompilePipelineResponse {
    pub ok: bool,
    pub result: Option<CompilePipelineResult>,
    pub error: Option<RunFailure>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InteractiveProgram {
    #[serde(with = "serde_bytes")]
    pub wasm: Vec<u8>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub files: BTreeMap<String, serde_bytes::ByteBuf>,
    pub cwd: Option<String>,
    pub startup_entropy_bytes: u64,
    pub resources: ResourcePolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InteractiveRequest {
    pub contestant: InteractiveProgram,
    pub interactor: InteractiveProgram,
    pub determinism: DeterminismConfig,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveMetrics {
    pub cost: u64,
    pub operations: BTreeMap<String, u64>,
    pub logical_time_ns: u64,
    pub filesystem_bytes: u64,
    pub filesystem_entries: u64,
    pub protocol_bytes: u64,
    pub stderr_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveProcessResult {
    pub code: i32,
    #[serde(with = "serde_bytes")]
    pub stderr: Vec<u8>,
    pub termination: ExecutionTermination,
    pub metrics: InteractiveMetrics,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveResult {
    pub contestant: InteractiveProcessResult,
    pub interactor: InteractiveProcessResult,
    #[serde(with = "serde_bytes")]
    pub contestant_to_interactor: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub interactor_to_contestant: Vec<u8>,
    pub determinism: DeterminismConfig,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveResponse {
    pub ok: bool,
    pub result: Option<InteractiveResult>,
    pub error: Option<RunFailure>,
}
