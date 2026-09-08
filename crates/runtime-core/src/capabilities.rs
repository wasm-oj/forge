use wasmer::{
    AsStoreMut, ExternType, Function, FunctionEnv, FunctionEnvMut, FunctionType, Imports, Instance,
    Module, RuntimeError, Type,
};

/// Returns whether an import exposes host state that WASM-OJ deliberately keeps
/// outside the deterministic judge contract.
///
/// Denied imports that are part of an admitted ABI remain valid at module
/// validation time. WASM-OJ resolves each declared function with its exact
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
        let error_message = format!("WASM-OJ denied nondeterministic capability {capability}");
        let denial = capability_trap(store, &function_type, error_message)?;
        imports.define(&namespace, &name, denial);
    }
    Ok(())
}

fn deny_capability(env: FunctionEnvMut<String>) -> Result<(), RuntimeError> {
    Err(RuntimeError::new(env.data().clone()))
}

fn capability_trap(
    store: &mut impl AsStoreMut,
    signature: &FunctionType,
    message: String,
) -> Result<Function, String> {
    use wasm_encoder::{
        CodeSection, EntityType, ExportKind, ExportSection, FunctionSection, ImportSection,
        Instruction, TypeSection, ValType,
    };

    let value_type = |ty: &Type| match ty {
        Type::I32 => ValType::I32,
        Type::I64 => ValType::I64,
        Type::F32 => ValType::F32,
        Type::F64 => ValType::F64,
        Type::V128 => ValType::V128,
        Type::ExternRef => ValType::EXTERNREF,
        Type::FuncRef => ValType::FUNCREF,
        Type::ExceptionRef => ValType::EXNREF,
    };
    let mut types = TypeSection::new();
    types.ty().function([], []);
    types.ty().function(
        signature.params().iter().map(value_type),
        signature.results().iter().map(value_type),
    );
    let mut imports = ImportSection::new();
    imports.import("host", "deny", EntityType::Function(0));
    let mut functions = FunctionSection::new();
    functions.function(1);
    let mut exports = ExportSection::new();
    exports.export("deny", ExportKind::Func, 1);
    let mut body = wasm_encoder::Function::new([]);
    body.instruction(&Instruction::Call(0));
    body.instruction(&Instruction::Unreachable);
    body.instruction(&Instruction::End);
    let mut code = CodeSection::new();
    code.function(&body);
    let mut wasm = wasm_encoder::Module::new();
    wasm.section(&types)
        .section(&imports)
        .section(&functions)
        .section(&exports)
        .section(&code);

    // Wasmer's dynamic host functions evaluate JavaScript under the web backend.
    // A Wasm stub preserves any declared signature and calls a CSP-safe typed trap.
    let module =
        Module::new(&store.as_store_ref(), wasm.finish()).map_err(|error| error.to_string())?;
    let env = FunctionEnv::new(&mut *store, message);
    let trap = Function::new_typed_with_env(&mut *store, &env, deny_capability);
    let mut imports = Imports::new();
    imports.define("host", "deny", trap);
    let instance = Instance::new(store, &module, &imports).map_err(|error| error.to_string())?;
    instance
        .exports
        .get_function("deny")
        .cloned()
        .map_err(|error| error.to_string())
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
