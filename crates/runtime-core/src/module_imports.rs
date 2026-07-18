use wasmer::{AsStoreMut, Extern, ExternType, Imports, Memory, Module};

/// Resolves the single guest linear memory when a WASI/WASIX module imports it.
///
/// Wasmer's low-level WASI import builder provides syscall functions, but it
/// does not allocate an `env.memory` import. Packaged WASIX runtimes such as
/// CPython use that ABI, so the portable runner must provide the memory before
/// instantiation. Other unresolved imports remain errors: silently fabricating
/// functions, tables, or globals would change program semantics.
pub(crate) fn attach_imported_memory(
    store: &mut impl AsStoreMut,
    module: &Module,
    imports: &mut Imports,
) -> Result<Option<Memory>, String> {
    let mut guest_memory = None;
    let mut memory_import = None;

    for import in module.imports() {
        if let Some(existing) = imports.get_export(import.module(), import.name()) {
            if let ExternType::Memory(_) = import.ty() {
                let Extern::Memory(memory) = existing else {
                    return Err(format!(
                        "import {}.{} must be a memory",
                        import.module(),
                        import.name()
                    ));
                };
                record_memory_import(
                    &mut guest_memory,
                    &mut memory_import,
                    import.module(),
                    import.name(),
                    memory,
                )?;
            }
            continue;
        }

        match import.ty() {
            ExternType::Memory(memory_type) => {
                if import.module() != "env" || import.name() != "memory" {
                    return Err(format!(
                        "unresolved memory import {}.{} is unsupported; only env.memory is admitted",
                        import.module(),
                        import.name()
                    ));
                }
                let memory = Memory::new(store, *memory_type).map_err(|error| {
                    format!(
                        "failed to create imported memory {}.{}: {error}",
                        import.module(),
                        import.name()
                    )
                })?;
                imports.define(import.module(), import.name(), memory.clone());
                record_memory_import(
                    &mut guest_memory,
                    &mut memory_import,
                    import.module(),
                    import.name(),
                    memory,
                )?;
            }
            unresolved_type => {
                return Err(format!(
                    "unresolved import {}.{} ({unresolved_type:?})",
                    import.module(),
                    import.name()
                ));
            }
        }
    }

    Ok(guest_memory)
}

/// Supplies admitted memory imports from an additional-imports hook where
/// Wasmer has not merged its built-in WASI functions yet. Non-memory imports
/// are intentionally left for the runtime's normal resolver.
pub(crate) fn attach_declared_memory_imports(
    store: &mut impl AsStoreMut,
    module: &Module,
    imports: &mut Imports,
) -> Result<Option<Memory>, String> {
    let mut guest_memory = None;
    let mut memory_import = None;
    for import in module.imports() {
        let ExternType::Memory(memory_type) = import.ty() else {
            continue;
        };
        if let Some(existing) = imports.get_export(import.module(), import.name()) {
            let Extern::Memory(memory) = existing else {
                return Err(format!(
                    "import {}.{} must be a memory",
                    import.module(),
                    import.name()
                ));
            };
            record_memory_import(
                &mut guest_memory,
                &mut memory_import,
                import.module(),
                import.name(),
                memory,
            )?;
            continue;
        }
        if import.module() != "env" || import.name() != "memory" {
            return Err(format!(
                "unresolved memory import {}.{} is unsupported; only env.memory is admitted",
                import.module(),
                import.name()
            ));
        }
        let memory = Memory::new(&mut *store, *memory_type).map_err(|error| {
            format!(
                "failed to create imported memory {}.{}: {error}",
                import.module(),
                import.name()
            )
        })?;
        imports.define(import.module(), import.name(), memory.clone());
        record_memory_import(
            &mut guest_memory,
            &mut memory_import,
            import.module(),
            import.name(),
            memory,
        )?;
    }
    Ok(guest_memory)
}

fn record_memory_import(
    guest_memory: &mut Option<Memory>,
    first_import: &mut Option<(String, String)>,
    module: &str,
    name: &str,
    memory: Memory,
) -> Result<(), String> {
    if let Some((first_module, first_name)) = first_import {
        return Err(format!(
            "multiple imported memories are unsupported: {first_module}.{first_name} and {module}.{name}"
        ));
    }
    *first_import = Some((module.to_string(), name.to_string()));
    *guest_memory = Some(memory);
    Ok(())
}
