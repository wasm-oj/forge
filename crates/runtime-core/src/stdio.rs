use std::sync::{Arc, Mutex};
use wasmer::{AsStoreMut, Extern, Function, FunctionEnv, Imports, Memory, RuntimeError, Value};
use wasmer_wasix::wasmer_wasix_types::wasi::Filetype;

struct StdioEnv {
    original: Function,
    memory: Arc<Mutex<Option<Memory>>>,
}

pub(crate) fn attach_redirected_stdio(
    store: &mut impl AsStoreMut,
    imports: &mut Imports,
    memory: &Arc<Mutex<Option<Memory>>>,
) {
    for namespace in ["wasi_snapshot_preview1", "wasix_32v1", "wasix_64v1"] {
        let Some(Extern::Function(original)) = imports.get_export(namespace, "fd_fdstat_get")
        else {
            continue;
        };
        let signature = original.ty(store);
        let env = FunctionEnv::new(
            store,
            StdioEnv {
                original,
                memory: memory.clone(),
            },
        );
        imports.define(
            namespace,
            "fd_fdstat_get",
            Function::new_with_env(store, &env, signature, |mut env, arguments| {
                let result = env.data().original.clone().call(&mut env, arguments)?;
                if matches!(arguments.first(), Some(Value::I32(0..=2)))
                    && matches!(result.as_ref(), [Value::I32(0)])
                {
                    let offset = match arguments[1] {
                        Value::I32(offset) => u64::from(offset as u32),
                        Value::I64(offset) => offset as u64,
                        _ => return Err(RuntimeError::new("Invalid fdstat pointer type")),
                    };
                    let memory = env.data().memory.lock().unwrap();
                    let memory = memory
                        .as_ref()
                        .ok_or_else(|| RuntimeError::new("Missing WASI memory"))?;
                    // Wasmer hardcodes stdio as CharacterDevice even when backed by pipes.
                    // WASI has no FIFO filetype; only replace the first fdstat field.
                    memory
                        .view(&env)
                        .write(offset, &[Filetype::Unknown as u8])
                        .map_err(|error| RuntimeError::new(error.to_string()))?;
                }
                Ok(result.into_vec())
            }),
        );
    }
}
