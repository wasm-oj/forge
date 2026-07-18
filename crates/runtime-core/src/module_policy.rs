use std::fmt;
use wasm_encoder::reencode::{Error, Reencode, RoundtripReencoder};

pub(crate) const INTERACTIVE_WASIP1_DETERMINISTIC_NAMESPACE: &str =
    "forge_interactive_wasi_snapshot_preview1";
pub(crate) const INTERACTIVE_WASIX32_DETERMINISTIC_NAMESPACE: &str = "forge_interactive_wasix_32v1";
pub(crate) const INTERACTIVE_WASIX64_DETERMINISTIC_NAMESPACE: &str = "forge_interactive_wasix_64v1";

const WASM_PAGE_BYTES: u64 = 65_536;
pub(crate) const DEFERRED_START_EXPORT: &str = "__wasm_oj_forge_deferred_start";
const WASIP1_FUNCTIONS: &[&str] = &[
    "args_get",
    "args_sizes_get",
    "clock_res_get",
    "clock_time_get",
    "environ_get",
    "environ_sizes_get",
    "fd_advise",
    "fd_allocate",
    "fd_close",
    "fd_datasync",
    "fd_fdstat_get",
    "fd_fdstat_set_flags",
    "fd_fdstat_set_rights",
    "fd_filestat_get",
    "fd_filestat_set_size",
    "fd_filestat_set_times",
    "fd_pread",
    "fd_prestat_dir_name",
    "fd_prestat_get",
    "fd_pwrite",
    "fd_read",
    "fd_readdir",
    "fd_renumber",
    "fd_seek",
    "fd_sync",
    "fd_tell",
    "fd_write",
    "path_create_directory",
    "path_filestat_get",
    "path_filestat_set_times",
    "path_link",
    "path_open",
    "path_readlink",
    "path_remove_directory",
    "path_rename",
    "path_symlink",
    "path_unlink_file",
    "poll_oneoff",
    "proc_exit",
    "proc_raise",
    "random_get",
    "sched_yield",
    "sock_accept",
    "sock_recv",
    "sock_send",
    "sock_shutdown",
    "thread-spawn",
];

// Exact function surface exported by pinned wasmer-wasix 0.702.0 for both
// wasix_32v1 and wasix_64v1. Updating Wasmer requires an explicit ABI and
// capability review before new host functions become reachable.
const WASIX_V1_FUNCTIONS: &[&str] = &[
    "args_get",
    "args_sizes_get",
    "call_dynamic",
    "callback_signal",
    "chdir",
    "clock_res_get",
    "clock_time_get",
    "clock_time_set",
    "closure_allocate",
    "closure_free",
    "closure_prepare",
    "context_create",
    "context_destroy",
    "context_switch",
    "dl_invalid_handle",
    "dlopen",
    "dlsym",
    "environ_get",
    "environ_sizes_get",
    "epoll_create",
    "epoll_ctl",
    "epoll_wait",
    "fd_advise",
    "fd_allocate",
    "fd_close",
    "fd_datasync",
    "fd_dup",
    "fd_dup2",
    "fd_event",
    "fd_fdflags_get",
    "fd_fdflags_set",
    "fd_fdstat_get",
    "fd_fdstat_set_flags",
    "fd_fdstat_set_rights",
    "fd_filestat_get",
    "fd_filestat_set_size",
    "fd_filestat_set_times",
    "fd_pipe",
    "fd_pread",
    "fd_prestat_dir_name",
    "fd_prestat_get",
    "fd_pwrite",
    "fd_read",
    "fd_readdir",
    "fd_renumber",
    "fd_seek",
    "fd_sync",
    "fd_tell",
    "fd_write",
    "futex_wait",
    "futex_wake",
    "futex_wake_all",
    "getcwd",
    "path_create_directory",
    "path_filestat_get",
    "path_filestat_set_times",
    "path_link",
    "path_open",
    "path_open2",
    "path_readlink",
    "path_remove_directory",
    "path_rename",
    "path_symlink",
    "path_unlink_file",
    "poll_oneoff",
    "port_addr_add",
    "port_addr_clear",
    "port_addr_list",
    "port_addr_remove",
    "port_bridge",
    "port_dhcp_acquire",
    "port_gateway_set",
    "port_mac",
    "port_route_add",
    "port_route_clear",
    "port_route_list",
    "port_route_remove",
    "port_unbridge",
    "proc_exec",
    "proc_exec2",
    "proc_exec3",
    "proc_exec4",
    "proc_exit",
    "proc_exit2",
    "proc_fork",
    "proc_fork_env",
    "proc_id",
    "proc_join",
    "proc_parent",
    "proc_raise",
    "proc_raise_interval",
    "proc_signal",
    "proc_signals_get",
    "proc_signals_sizes_get",
    "proc_snapshot",
    "proc_spawn",
    "proc_spawn2",
    "proc_spawn3",
    "random_get",
    "reflect_signature",
    "resolve",
    "sched_yield",
    "sock_accept",
    "sock_accept_v2",
    "sock_addr_local",
    "sock_addr_peer",
    "sock_bind",
    "sock_connect",
    "sock_get_opt_flag",
    "sock_get_opt_size",
    "sock_get_opt_time",
    "sock_join_multicast_v4",
    "sock_join_multicast_v6",
    "sock_leave_multicast_v4",
    "sock_leave_multicast_v6",
    "sock_listen",
    "sock_open",
    "sock_pair",
    "sock_recv",
    "sock_recv_from",
    "sock_send",
    "sock_send_file",
    "sock_send_to",
    "sock_set_opt_flag",
    "sock_set_opt_size",
    "sock_set_opt_time",
    "sock_shutdown",
    "sock_status",
    "stack_checkpoint",
    "stack_restore",
    "thread_exit",
    "thread_id",
    "thread_join",
    "thread_parallelism",
    "thread_signal",
    "thread_sleep",
    "thread_spawn",
    "thread_spawn_v2",
    "tty_get",
    "tty_set",
];

#[derive(Debug)]
pub(crate) struct DeferredStartModule {
    pub(crate) wasm: Vec<u8>,
    pub(crate) has_deferred_start: bool,
}

#[derive(Debug)]
struct MemoryPolicyError(String);

impl fmt::Display for MemoryPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for MemoryPolicyError {}

struct MemoryLimiter {
    limit_pages: u64,
}

struct InteractiveDeterministicImports;

impl Reencode for InteractiveDeterministicImports {
    type Error = std::convert::Infallible;

    fn parse_import_section(
        &mut self,
        imports: &mut wasm_encoder::ImportSection,
        section: wasmparser::ImportSectionReader<'_>,
    ) -> Result<(), Error<Self::Error>> {
        for import in section.into_imports() {
            let import = import?;
            let namespace = interactive_deterministic_namespace(import.module, import.name)
                .unwrap_or(import.module);
            imports.import(namespace, import.name, self.entity_type(import.ty)?);
        }
        Ok(())
    }
}

fn interactive_deterministic_namespace(module: &str, name: &str) -> Option<&'static str> {
    let common = matches!(
        name,
        "clock_res_get"
            | "clock_time_get"
            | "fd_filestat_set_times"
            | "path_filestat_set_times"
            | "poll_oneoff"
            | "random_get"
    );
    match module {
        "wasi_snapshot_preview1" if common => Some(INTERACTIVE_WASIP1_DETERMINISTIC_NAMESPACE),
        "wasix_32v1"
            if common || matches!(name, "thread_id" | "thread_parallelism" | "thread_sleep") =>
        {
            Some(INTERACTIVE_WASIX32_DETERMINISTIC_NAMESPACE)
        }
        "wasix_64v1"
            if common || matches!(name, "thread_id" | "thread_parallelism" | "thread_sleep") =>
        {
            Some(INTERACTIVE_WASIX64_DETERMINISTIC_NAMESPACE)
        }
        _ => None,
    }
}

pub(crate) fn rewrite_interactive_deterministic_imports(wasm: &[u8]) -> Result<Vec<u8>, String> {
    let mut module = wasm_encoder::Module::new();
    InteractiveDeterministicImports
        .parse_core_module(&mut module, wasmparser::Parser::new(0), wasm)
        .map_err(|error| format!("failed to isolate interactive deterministic imports: {error}"))?;
    Ok(module.finish())
}

impl Reencode for MemoryLimiter {
    type Error = MemoryPolicyError;

    fn memory_type(
        &mut self,
        memory: wasmparser::MemoryType,
    ) -> Result<wasm_encoder::MemoryType, Error<Self::Error>> {
        if memory.memory64 {
            return Err(Error::UserError(MemoryPolicyError(
                "memory64 modules are unsupported by the pinned Forge runtime".to_string(),
            )));
        }
        if memory.initial > self.limit_pages {
            return Err(Error::UserError(MemoryPolicyError(format!(
                "module requires {} memory pages, limit is {}",
                memory.initial, self.limit_pages
            ))));
        }
        let mut encoded = wasm_encoder::reencode::utils::memory_type(self, memory);
        encoded.maximum = Some(
            encoded
                .maximum
                .map_or(self.limit_pages, |maximum| maximum.min(self.limit_pages)),
        );
        Ok(encoded)
    }
}

/// Re-encodes every defined or imported memory with a strict maximum.
/// The WebAssembly engine therefore rejects growth beyond the policy on both
/// native and browser hosts.
pub fn enforce_memory_limit(wasm: &[u8], memory_limit_bytes: u64) -> Result<Vec<u8>, String> {
    if memory_limit_bytes == 0 || !memory_limit_bytes.is_multiple_of(WASM_PAGE_BYTES) {
        return Err("memory limit must be a positive multiple of 64 KiB".to_string());
    }
    validate_runtime_import_namespaces(wasm)?;
    let mut module = wasm_encoder::Module::new();
    MemoryLimiter {
        limit_pages: memory_limit_bytes / WASM_PAGE_BYTES,
    }
    .parse_core_module(&mut module, wasmparser::Parser::new(0), wasm)
    .map_err(|error| format!("failed to apply memory policy: {error}"))?;
    Ok(module.finish())
}

fn validate_runtime_import_namespaces(wasm: &[u8]) -> Result<(), String> {
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        let payload =
            payload.map_err(|error| format!("failed to inspect module imports: {error}"))?;
        let wasmparser::Payload::ImportSection(section) = payload else {
            continue;
        };
        for import in section.into_imports() {
            let import =
                import.map_err(|error| format!("failed to inspect module import: {error}"))?;
            validate_runtime_import(import.module, import.name, import.ty)?;
        }
    }
    Ok(())
}

fn validate_runtime_import(
    namespace: &str,
    name: &str,
    import_type: wasmparser::TypeRef,
) -> Result<(), String> {
    let is_function = matches!(import_type, wasmparser::TypeRef::Func(_));
    match namespace {
        "env" if name == "memory" && matches!(import_type, wasmparser::TypeRef::Memory(_)) => {
            Ok(())
        }
        "env" => Err(format!(
            "unsupported runtime import env.{name}; Forge admits only env.memory"
        )),
        "wasi" if name == "thread-spawn" && is_function => Ok(()),
        "wasi" => Err(format!(
            "unsupported generic WASI import wasi.{name}; only the pinned WASIX thread-spawn declaration is recognized"
        )),
        "wasi_snapshot_preview1" if is_function && WASIP1_FUNCTIONS.contains(&name) => Ok(()),
        "wasi_snapshot_preview1" => Err(format!(
            "unsupported wasip1 import wasi_snapshot_preview1.{name}"
        )),
        "wasix_32v1" | "wasix_64v1" if is_function && WASIX_V1_FUNCTIONS.contains(&name) => Ok(()),
        "wasix_32v1" | "wasix_64v1" if is_function => Err(format!(
            "unsupported WASIX import {namespace}.{name}; the function is outside the pinned WASIX v1 ABI"
        )),
        "wasix_32v1" | "wasix_64v1" => Err(format!(
            "unsupported non-function WASIX import {namespace}.{name}"
        )),
        _ => Err(format!(
            "unsupported runtime import namespace '{namespace}'; Forge accepts only wasip1 and WASIX modules"
        )),
    }
}

/// Converts the WebAssembly start section into a private host-invoked export.
///
/// A native start section runs inside `Instance::new`, before Forge can attach
/// guest memory to deterministic clock/random functions or initialize WASI
/// instance handles. Deferring it keeps the same instrumented function body
/// and function index while allowing the runner to invoke it immediately after
/// those prerequisites are ready.
pub(crate) fn defer_start_section(wasm: &[u8]) -> Result<DeferredStartModule, String> {
    let mut start_function = None;
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        match payload.map_err(|error| format!("failed to inspect start section: {error}"))? {
            wasmparser::Payload::StartSection { func, .. } => start_function = Some(func),
            wasmparser::Payload::ExportSection(section) => {
                for export in section {
                    let export = export
                        .map_err(|error| format!("failed to inspect module export: {error}"))?;
                    if export.name == DEFERRED_START_EXPORT {
                        return Err(format!(
                            "module export name {DEFERRED_START_EXPORT} is reserved by Forge"
                        ));
                    }
                }
            }
            _ => {}
        }
    }

    let Some(start_function) = start_function else {
        return Ok(DeferredStartModule {
            wasm: wasm.to_vec(),
            has_deferred_start: false,
        });
    };

    let mut module = wasm_encoder::Module::new();
    let mut added_export = false;
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        let payload = payload.map_err(|error| format!("failed to defer start section: {error}"))?;
        match payload {
            wasmparser::Payload::Version { .. }
            | wasmparser::Payload::CodeSectionEntry(_)
            | wasmparser::Payload::End(_) => {}
            wasmparser::Payload::ExportSection(section) => {
                let mut exports = wasm_encoder::ExportSection::new();
                RoundtripReencoder
                    .parse_export_section(&mut exports, section)
                    .map_err(|error| format!("failed to re-encode module exports: {error}"))?;
                exports.export(
                    DEFERRED_START_EXPORT,
                    wasm_encoder::ExportKind::Func,
                    start_function,
                );
                module.section(&exports);
                added_export = true;
            }
            wasmparser::Payload::StartSection { .. } => {}
            other => {
                let Some((section_id, range)) = other.as_section() else {
                    continue;
                };
                if !added_export
                    && section_id != 0
                    && section_id > wasm_encoder::SectionId::Export as u8
                {
                    append_deferred_start_export(&mut module, start_function);
                    added_export = true;
                }
                module.section(&wasm_encoder::RawSection {
                    id: section_id,
                    data: &wasm[range],
                });
            }
        }
    }
    if !added_export {
        append_deferred_start_export(&mut module, start_function);
    }

    Ok(DeferredStartModule {
        wasm: module.finish(),
        has_deferred_start: true,
    })
}

fn append_deferred_start_export(module: &mut wasm_encoder::Module, start_function: u32) {
    let mut exports = wasm_encoder::ExportSection::new();
    exports.export(
        DEFERRED_START_EXPORT,
        wasm_encoder::ExportKind::Func,
        start_function,
    );
    module.section(&exports);
}

/// Rejects modules whose declared memory range exceeds the hard policy.
/// Package commands are content-addressed and cannot be rewritten without
/// invalidating their identity, so compiler packages use validation rather
/// than re-encoding.
pub fn validate_memory_limit(wasm: &[u8], memory_limit_bytes: u64) -> Result<(), String> {
    if memory_limit_bytes == 0 || !memory_limit_bytes.is_multiple_of(WASM_PAGE_BYTES) {
        return Err("memory limit must be a positive multiple of 64 KiB".to_string());
    }
    let limit_pages = memory_limit_bytes / WASM_PAGE_BYTES;
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        match payload.map_err(|error| format!("failed to inspect module memory: {error}"))? {
            wasmparser::Payload::ImportSection(section) => {
                for import in section.into_imports() {
                    let import = import.map_err(|error| {
                        format!("failed to inspect imported module memory: {error}")
                    })?;
                    if let wasmparser::TypeRef::Memory(memory) = import.ty {
                        validate_memory_type(memory, limit_pages)?;
                    }
                }
            }
            wasmparser::Payload::MemorySection(section) => {
                for memory in section {
                    validate_memory_type(
                        memory.map_err(|error| {
                            format!("failed to inspect defined module memory: {error}")
                        })?,
                        limit_pages,
                    )?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_memory_type(memory: wasmparser::MemoryType, limit_pages: u64) -> Result<(), String> {
    if memory.memory64 {
        return Err("memory64 modules are unsupported by the pinned Forge runtime".to_string());
    }
    if memory.initial > limit_pages || memory.maximum.is_none_or(|maximum| maximum > limit_pages) {
        return Err(format!(
            "module memory range {}..={} exceeds the configured limit of {} pages",
            memory.initial,
            memory
                .maximum
                .map_or_else(|| "unbounded".to_string(), |value| value.to_string()),
            limit_pages,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        DEFERRED_START_EXPORT, defer_start_section, enforce_memory_limit, validate_memory_limit,
    };
    use wasmparser::{Parser, Payload};

    #[test]
    fn clamps_an_unbounded_memory() {
        let wasm = wat::parse_str("(module (memory (export \"memory\") 1))").unwrap();
        let limited = enforce_memory_limit(&wasm, 2 * 65_536).unwrap();
        let maximum = Parser::new(0).parse_all(&limited).find_map(|payload| {
            let Payload::MemorySection(section) = payload.ok()? else {
                return None;
            };
            section.into_iter().next()?.ok()?.maximum
        });
        assert_eq!(maximum, Some(2));
    }

    #[test]
    fn rejects_a_minimum_above_the_limit() {
        let wasm = wat::parse_str("(module (memory 3))").unwrap();
        assert!(
            enforce_memory_limit(&wasm, 2 * 65_536)
                .unwrap_err()
                .contains("requires 3")
        );
    }

    #[test]
    fn rejects_memory64_before_engine_compilation() {
        for source in [
            "(module (memory i64 1))",
            r#"(module (import "env" "memory" (memory i64 1 2)))"#,
        ] {
            let wasm = wat::parse_str(source).unwrap();
            let error = enforce_memory_limit(&wasm, 2 * 65_536).unwrap_err();
            assert!(
                error.contains("memory64 modules are unsupported"),
                "{error}"
            );
        }
    }

    #[test]
    fn rejects_preview0_imports() {
        let wasm = wat::parse_str(
            r#"(module
              (import "wasi_unstable" "clock_time_get" (func (param i32 i64 i32) (result i32)))
              (memory (export "memory") 1)
              (func (export "_start")))"#,
        )
        .unwrap();
        let error = enforce_memory_limit(&wasm, 2 * 65_536).unwrap_err();
        assert!(error.contains("unsupported runtime import namespace 'wasi_unstable'"));
    }

    #[test]
    fn rejects_unknown_wasip1_symbols() {
        let wasm = wat::parse_str(
            r#"(module
              (import "wasi_snapshot_preview1" "future_extension" (func))
              (memory (export "memory") 1)
              (func (export "_start")))"#,
        )
        .unwrap();
        let error = enforce_memory_limit(&wasm, 2 * 65_536).unwrap_err();
        assert!(error.contains("unsupported wasip1 import"));
    }

    #[test]
    fn rejects_non_memory_env_imports() {
        let wasm = wat::parse_str(
            r#"(module
              (import "env" "host_callback" (func))
              (memory (export "memory") 1)
              (func (export "_start")))"#,
        )
        .unwrap();
        let error = enforce_memory_limit(&wasm, 2 * 65_536).unwrap_err();
        assert!(error.contains("Forge admits only env.memory"));
    }

    #[test]
    fn rejects_unknown_wasix_functions_for_both_memory_models() {
        for namespace in ["wasix_32v1", "wasix_64v1"] {
            let wasm = wat::parse_str(format!(
                r#"(module
                  (import "{namespace}" "future_network_api" (func))
                  (memory (export "memory") 1)
                  (func (export "_start")))"#,
            ))
            .unwrap();
            let error = enforce_memory_limit(&wasm, 2 * 65_536).unwrap_err();
            assert!(
                error.contains("outside the pinned WASIX v1 ABI"),
                "unexpected {namespace} error: {error}"
            );
        }
    }

    #[test]
    fn clamps_shared_runtime_memory_without_enabling_parallel_execution() {
        let wasm = wat::parse_str("(module (memory 1 10 shared))").unwrap();
        let limited = enforce_memory_limit(&wasm, 2 * 65_536).unwrap();
        let memory = Parser::new(0)
            .parse_all(&limited)
            .find_map(|payload| {
                let Payload::MemorySection(section) = payload.ok()? else {
                    return None;
                };
                section.into_iter().next()?.ok()
            })
            .unwrap();
        assert!(memory.shared);
        assert_eq!(memory.maximum, Some(2));
    }

    #[test]
    fn validation_accepts_a_memory_bounded_by_the_limit() {
        let wasm = wat::parse_str("(module (memory 1 2))").unwrap();
        validate_memory_limit(&wasm, 2 * 65_536).unwrap();
    }

    #[test]
    fn validation_rejects_unbounded_memory() {
        let wasm = wat::parse_str("(module (memory 1))").unwrap();
        assert!(
            validate_memory_limit(&wasm, 2 * 65_536)
                .unwrap_err()
                .contains("unbounded")
        );
    }

    #[test]
    fn validation_rejects_memory64() {
        let wasm = wat::parse_str("(module (memory i64 1 2))").unwrap();
        let error = validate_memory_limit(&wasm, 2 * 65_536).unwrap_err();
        assert!(
            error.contains("memory64 modules are unsupported"),
            "{error}"
        );
    }

    #[test]
    fn converts_a_start_section_to_a_reserved_export_without_reindexing_it() {
        let wasm = wat::parse_str(
            r#"(module
              (func $initialize)
              (start $initialize)
              (memory (export "memory") 1)
              (func (export "_start")))"#,
        )
        .unwrap();
        let deferred = defer_start_section(&wasm).unwrap();
        assert!(deferred.has_deferred_start);

        let mut saw_start = false;
        let mut deferred_export = None;
        for payload in Parser::new(0).parse_all(&deferred.wasm) {
            match payload.unwrap() {
                Payload::StartSection { .. } => saw_start = true,
                Payload::ExportSection(section) => {
                    for export in section {
                        let export = export.unwrap();
                        if export.name == DEFERRED_START_EXPORT {
                            deferred_export = Some((export.kind, export.index));
                        }
                    }
                }
                _ => {}
            }
        }
        assert!(!saw_start);
        assert_eq!(deferred_export, Some((wasmparser::ExternalKind::Func, 0)));
    }

    #[test]
    fn rejects_the_private_deferred_start_export() {
        let wasm = wat::parse_str(format!(
            "(module (func (export \"{DEFERRED_START_EXPORT}\")))"
        ))
        .unwrap();
        let error = defer_start_section(&wasm).unwrap_err();
        assert!(error.contains("reserved by Forge"));
    }
}
