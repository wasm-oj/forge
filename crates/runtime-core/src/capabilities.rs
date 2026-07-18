use wasmer::{AsStoreMut, ExternType, Function, Imports, Module, RuntimeError};

/// Returns whether an import exposes host state that Forge deliberately keeps
/// outside the deterministic judge contract.
///
/// Denied imports that are part of an admitted ABI remain valid at module
/// validation time. Forge resolves each declared function with its exact
/// signature and replaces the Wasmer implementation with a fail-closed trap,
/// so no forbidden host implementation is reachable.
pub(crate) fn is_denied_capability(namespace: &str, name: &str) -> bool {
    match namespace {
        "wasi" => name == "thread-spawn",
        "wasi_snapshot_preview1" => name == "thread-spawn" || name.starts_with("sock_"),
        "wasix_32v1" | "wasix_64v1" => {
            matches!(
                name,
                "thread_spawn"
                    | "thread_spawn_v2"
                    | "thread_signal"
                    | "thread_join"
                    | "thread_exit"
                    | "futex_wait"
            ) || name.starts_with("sock_")
                || name.starts_with("port_")
                || name.starts_with("bus_")
                || name.starts_with("http_")
                || name.starts_with("net_")
                || matches!(name, "resolve" | "clock_time_set")
                || (name.starts_with("proc_")
                    && !matches!(name, "proc_exit" | "proc_id" | "proc_parent"))
        }
        _ => false,
    }
}

/// Replaces every denied WASI/WASIX function with a signature-preserving host
/// trap. This must run after Wasmer builds the normal WASI import object and
/// before instantiation so no forbidden implementation is ever reachable.
pub(crate) fn attach_capability_denials(
    store: &mut impl AsStoreMut,
    module: &Module,
    imports: &mut Imports,
) -> Result<(), String> {
    let denied = module
        .imports()
        .filter(|import| is_denied_capability(import.module(), import.name()))
        .map(|import| {
            let ExternType::Function(function_type) = import.ty() else {
                return Err(format!(
                    "denied capability import {}.{} must be a function",
                    import.module(),
                    import.name()
                ));
            };
            Ok((
                import.module().to_string(),
                import.name().to_string(),
                function_type.clone(),
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;

    for (namespace, name, function_type) in denied {
        let capability = format!("{namespace}.{name}");
        let error_message = format!("Forge denied nondeterministic capability {capability}");
        let denial = Function::new(store, function_type, move |_| {
            Err(RuntimeError::new(error_message.clone()))
        });
        imports.define(&namespace, &name, denial);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_denied_capability;

    #[test]
    fn denies_declared_thread_process_and_network_capabilities() {
        for (namespace, name) in [
            ("wasi", "thread-spawn"),
            ("wasi_snapshot_preview1", "sock_recv"),
            ("wasix_32v1", "thread_spawn"),
            ("wasix_32v1", "futex_wait"),
            ("wasix_32v1", "proc_fork"),
            ("wasix_32v1", "proc_exec"),
            ("wasix_32v1", "sock_open"),
            ("wasix_32v1", "resolve"),
            ("wasix_64v1", "port_bridge"),
        ] {
            assert!(
                is_denied_capability(namespace, name),
                "{namespace}.{name} must be denied"
            );
        }
    }

    #[test]
    fn preserves_deterministic_language_runtime_capabilities() {
        for (namespace, name) in [
            ("wasi_snapshot_preview1", "fd_write"),
            ("wasi_snapshot_preview1", "clock_time_get"),
            ("wasi_snapshot_preview1", "random_get"),
            ("wasix_32v1", "getcwd"),
            ("wasix_32v1", "callback_signal"),
            ("wasix_32v1", "futex_wake"),
            ("wasix_32v1", "thread_id"),
            ("wasix_32v1", "thread_parallelism"),
            ("wasix_32v1", "proc_id"),
            ("wasix_32v1", "proc_parent"),
        ] {
            assert!(
                !is_denied_capability(namespace, name),
                "{namespace}.{name} must remain available"
            );
        }
    }
}
