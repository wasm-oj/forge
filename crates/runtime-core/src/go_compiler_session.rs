use crate::filesystem::immutable_compiler_files;
use crate::{
    CompilePipelineResponse, CompilerToolchain, GoCompilerSessionConfig, GoCompilerSessionRequest,
    GoCompilerSessionResponse, GoCompilerSourceDelta, RunError, RunFailure,
};
use serde_bytes::ByteBuf;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use virtual_fs::FileSystem;

#[derive(Debug, Default)]
struct SourceState {
    generation: u32,
    files: BTreeMap<String, ByteBuf>,
    in_flight: bool,
}

/// A digest-bound, process-local Go compiler handle.
///
/// The WebC package and Go standard library cross the JS/Wasm boundary once at
/// construction. Each later request carries only a monotonic `/work` source
/// delta and stage argv. The immutable filesystem is shared by copy-on-write
/// build overlays, while stores, instances, process state, outputs, and source
/// snapshots remain isolated per build.
pub struct GoCompilerSession {
    digest: String,
    toolchain: CompilerToolchain,
    standard_library: Arc<dyn FileSystem + Send + Sync>,
    source: Mutex<SourceState>,
}

impl GoCompilerSession {
    pub fn new(config: GoCompilerSessionConfig) -> Result<Self, RunError> {
        validate_digest(&config.digest)?;
        if config.standard_library_files.is_empty() {
            return Err(RunError::InvalidRequest(
                "Go compiler session requires a non-empty standard library".to_string(),
            ));
        }
        crate::run::validate_mounted_files(&config.standard_library_files, "Go standard library")?;
        for path in config.standard_library_files.keys() {
            validate_standard_library_path(path)?;
        }
        let standard_library = immutable_compiler_files(config.standard_library_files)?;
        let toolchain = CompilerToolchain::new(config.toolchain)?;
        Ok(Self {
            digest: config.digest,
            toolchain,
            standard_library,
            source: Mutex::new(SourceState::default()),
        })
    }

    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn generation(&self) -> Result<u32, RunError> {
        Ok(self
            .source
            .lock()
            .map_err(|error| RunError::Runtime(error.to_string()))?
            .generation)
    }

    pub async fn compile_pipeline_response(
        &self,
        request: GoCompilerSessionRequest,
    ) -> Result<GoCompilerSessionResponse, RunError> {
        if request.digest != self.digest {
            return Err(RunError::InvalidRequest(
                "Go compiler request digest does not match its hydrated session".to_string(),
            ));
        }
        let generation = request.source_delta.generation;
        let next_files = self.prepare_source_delta(request.source_delta)?;
        let result = self
            .toolchain
            .compile_pipeline_with_base(
                next_files.clone(),
                request.stages,
                self.standard_library.clone(),
            )
            .await;
        let response = match result {
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
        };
        self.commit_source_delta(generation, next_files)?;
        Ok(GoCompilerSessionResponse {
            digest: self.digest.clone(),
            generation,
            response,
        })
    }

    fn prepare_source_delta(
        &self,
        delta: GoCompilerSourceDelta,
    ) -> Result<BTreeMap<String, ByteBuf>, RunError> {
        let mut state = self
            .source
            .lock()
            .map_err(|error| RunError::Runtime(error.to_string()))?;
        if state.in_flight {
            return Err(RunError::InvalidRequest(
                "Go compiler session accepts one build at a time".to_string(),
            ));
        }
        let next = apply_source_delta(&state, delta)?;
        state.in_flight = true;
        Ok(next)
    }

    fn commit_source_delta(
        &self,
        generation: u32,
        files: BTreeMap<String, ByteBuf>,
    ) -> Result<(), RunError> {
        let mut state = self
            .source
            .lock()
            .map_err(|error| RunError::Runtime(error.to_string()))?;
        if !state.in_flight || generation != state.generation.saturating_add(1) {
            return Err(RunError::Runtime(
                "Go compiler session source state changed during a build".to_string(),
            ));
        }
        state.generation = generation;
        state.files = files;
        state.in_flight = false;
        Ok(())
    }
}

fn apply_source_delta(
    state: &SourceState,
    delta: GoCompilerSourceDelta,
) -> Result<BTreeMap<String, ByteBuf>, RunError> {
    let expected = state.generation.checked_add(1).ok_or_else(|| {
        RunError::InvalidRequest("Go compiler session generation is exhausted".to_string())
    })?;
    if delta.generation != expected {
        return Err(RunError::InvalidRequest(format!(
            "Go compiler source delta generation {} does not follow {}",
            delta.generation, state.generation
        )));
    }
    crate::run::validate_mounted_files(&delta.upsert_files, "Go source delta")?;
    for path in delta.upsert_files.keys() {
        validate_source_path(path)?;
    }
    let mut previous_remove = None;
    for path in &delta.remove_paths {
        validate_source_path(path)?;
        if previous_remove.is_some_and(|previous: &String| previous >= path) {
            return Err(RunError::InvalidRequest(
                "Go compiler source removals must be strictly sorted and unique".to_string(),
            ));
        }
        if delta.upsert_files.contains_key(path) {
            return Err(RunError::InvalidRequest(format!(
                "Go compiler source delta both removes and upserts '{path}'"
            )));
        }
        previous_remove = Some(path);
    }
    let mut next = state.files.clone();
    for path in delta.remove_paths {
        next.remove(&path);
    }
    next.extend(delta.upsert_files);
    crate::run::validate_mounted_files(&next, "Go source snapshot")?;
    Ok(next)
}

fn validate_digest(digest: &str) -> Result<(), RunError> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(RunError::InvalidRequest(
            "Go compiler session digest must be a lowercase SHA-256".to_string(),
        ));
    }
    Ok(())
}

fn validate_standard_library_path(path: &str) -> Result<(), RunError> {
    if !crate::filesystem::is_normalized_guest_path(path) || !path.starts_with("/go/") {
        return Err(RunError::InvalidRequest(format!(
            "Go standard-library file must be under /go: {path}"
        )));
    }
    Ok(())
}

fn validate_source_path(path: &str) -> Result<(), RunError> {
    if !crate::filesystem::is_normalized_guest_path(path) || !path.starts_with("/work/") {
        return Err(RunError::InvalidRequest(format!(
            "Go compiler mutable file must be under /work: {path}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        SourceState, apply_source_delta, validate_digest, validate_source_path,
        validate_standard_library_path,
    };
    use crate::{GoCompilerSourceDelta, RunError};
    use serde_bytes::ByteBuf;
    use std::collections::BTreeMap;

    #[test]
    fn validates_digest_and_filesystem_boundaries() {
        assert!(validate_digest(&"a".repeat(64)).is_ok());
        assert!(validate_digest(&"A".repeat(64)).is_err());
        assert!(validate_digest("short").is_err());
        assert!(validate_standard_library_path("/go/pkg/fmt.a").is_ok());
        assert!(validate_standard_library_path("/work/fmt.a").is_err());
        assert!(validate_source_path("/work/main.go").is_ok());
        assert!(validate_source_path("/go/pkg/fmt.a").is_err());
    }

    #[test]
    fn source_state_starts_empty_and_generation_zero() {
        let state = SourceState::default();
        assert_eq!(state.generation, 0);
        assert!(state.files.is_empty());
        assert!(!state.in_flight);
    }

    #[test]
    fn source_delta_applies_upserts_and_sorted_removals_monotonically() {
        let state = SourceState {
            generation: 1,
            files: BTreeMap::from([
                ("/work/main.go".to_string(), ByteBuf::from(vec![1])),
                ("/work/old.go".to_string(), ByteBuf::from(vec![2])),
            ]),
            in_flight: false,
        };
        let delta = GoCompilerSourceDelta {
            generation: 2,
            upsert_files: BTreeMap::from([
                ("/work/main.go".to_string(), ByteBuf::from(vec![3])),
                ("/work/new.go".to_string(), ByteBuf::from(vec![4])),
            ]),
            remove_paths: vec!["/work/old.go".to_string()],
        };
        let next = apply_source_delta(&state, delta).unwrap();
        assert_eq!(
            next.keys().map(String::as_str).collect::<Vec<_>>(),
            ["/work/main.go", "/work/new.go"]
        );
        assert_eq!(next["/work/main.go"].as_ref(), &[3]);
    }

    #[test]
    fn source_delta_rejects_stale_generations_and_ambiguous_updates() {
        let state = SourceState::default();
        let stale = GoCompilerSourceDelta {
            generation: 2,
            upsert_files: BTreeMap::new(),
            remove_paths: Vec::new(),
        };
        assert!(apply_source_delta(&state, stale).is_err());

        let ambiguous = GoCompilerSourceDelta {
            generation: 1,
            upsert_files: BTreeMap::from([("/work/main.go".to_string(), ByteBuf::from(vec![1]))]),
            remove_paths: vec!["/work/main.go".to_string()],
        };
        assert!(apply_source_delta(&state, ambiguous).is_err());
    }

    #[test]
    fn invalid_request_error_code_remains_stable() {
        let error = validate_source_path("../main.go").unwrap_err();
        assert!(matches!(error, RunError::InvalidRequest(_)));
    }
}
