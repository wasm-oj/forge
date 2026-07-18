use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RunErrorCode {
    InvalidRequest,
    CompileError,
    InstructionLimitExceeded,
    MemoryLimitExceeded,
    OutputLimitExceeded,
    Trap,
    WasiExit,
    WasiUnsupported,
    IoError,
    RuntimeError,
}

#[derive(Debug, Error)]
pub enum RunError {
    #[error("invalid run request: {0}")]
    InvalidRequest(String),
    #[error("module compilation failed: {0}")]
    Compile(String),
    #[error("instruction budget {0} exceeded")]
    InstructionLimit(u64),
    #[error("memory limit {0} bytes exceeded")]
    MemoryLimit(u64),
    #[error("output limit {0} bytes exceeded")]
    OutputLimit(u64),
    #[error("guest trapped: {0}")]
    Trap(String),
    #[error("guest exited with WASI errno {0}")]
    WasiExit(String),
    #[error("unsupported WASI behavior: {0}")]
    WasiUnsupported(String),
    #[error("I/O failed: {0}")]
    Io(String),
    #[error("runtime failed: {0}")]
    Runtime(String),
}

impl RunError {
    pub const fn code(&self) -> RunErrorCode {
        match self {
            Self::InvalidRequest(_) => RunErrorCode::InvalidRequest,
            Self::Compile(_) => RunErrorCode::CompileError,
            Self::InstructionLimit(_) => RunErrorCode::InstructionLimitExceeded,
            Self::MemoryLimit(_) => RunErrorCode::MemoryLimitExceeded,
            Self::OutputLimit(_) => RunErrorCode::OutputLimitExceeded,
            Self::Trap(_) => RunErrorCode::Trap,
            Self::WasiExit(_) => RunErrorCode::WasiExit,
            Self::WasiUnsupported(_) => RunErrorCode::WasiUnsupported,
            Self::Io(_) => RunErrorCode::IoError,
            Self::Runtime(_) => RunErrorCode::RuntimeError,
        }
    }
}
