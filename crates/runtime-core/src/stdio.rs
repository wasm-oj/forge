use std::sync::{Arc, Mutex};
use wasmer::{
    AsStoreMut, Extern, Function, FunctionEnv, FunctionEnvMut, Imports, Memory, RuntimeError, Value,
};
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
        let env = FunctionEnv::new(
            store,
            StdioEnv {
                original,
                memory: memory.clone(),
            },
        );
        let function = if namespace == "wasix_64v1" {
            Function::new_typed_with_env(store, &env, redirected_fdstat_64)
        } else {
            Function::new_typed_with_env(store, &env, redirected_fdstat_32)
        };
        imports.define(namespace, "fd_fdstat_get", function);
    }
}

fn redirected_fdstat_32(
    env: FunctionEnvMut<StdioEnv>,
    fd: i32,
    offset: i32,
) -> Result<i32, RuntimeError> {
    redirected_fdstat(env, fd, Value::I32(offset), u64::from(offset as u32))
}

fn redirected_fdstat_64(
    env: FunctionEnvMut<StdioEnv>,
    fd: i32,
    offset: i64,
) -> Result<i32, RuntimeError> {
    redirected_fdstat(env, fd, Value::I64(offset), offset as u64)
}

fn redirected_fdstat(
    mut env: FunctionEnvMut<StdioEnv>,
    fd: i32,
    pointer: Value,
    offset: u64,
) -> Result<i32, RuntimeError> {
    let original = env.data().original.clone();
    let result = original.call(&mut env, &[Value::I32(fd), pointer])?;
    let [Value::I32(errno)] = result.as_ref() else {
        return Err(RuntimeError::new("WASI fdstat returned an invalid result"));
    };
    if (0..=2).contains(&fd) && *errno == 0 {
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
    Ok(*errno)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasmer::{MemoryType, Store};

    fn original_32(env: FunctionEnvMut<Memory>, fd: i32, offset: i32) -> i32 {
        original(env, fd, u64::from(offset as u32))
    }

    fn original_64(env: FunctionEnvMut<Memory>, fd: i32, offset: i64) -> i32 {
        original(env, fd, offset as u64)
    }

    fn original(env: FunctionEnvMut<Memory>, fd: i32, offset: u64) -> i32 {
        if fd == 999 {
            return 8;
        }
        let mut stat = [0x5a; 24];
        stat[0] = Filetype::CharacterDevice as u8;
        env.data().view(&env).write(offset, &stat).unwrap();
        0
    }

    #[test]
    fn redirects_only_successful_stdio_filetype_and_preserves_flags_and_rights() {
        for namespace in ["wasi_snapshot_preview1", "wasix_32v1", "wasix_64v1"] {
            let mut store = Store::default();
            let memory = Memory::new(&mut store, MemoryType::new(1, None, false)).unwrap();
            let env = FunctionEnv::new(&mut store, memory.clone());
            let original = if namespace == "wasix_64v1" {
                Function::new_typed_with_env(&mut store, &env, original_64)
            } else {
                Function::new_typed_with_env(&mut store, &env, original_32)
            };
            let mut imports = Imports::new();
            imports.define(namespace, "fd_fdstat_get", original);
            attach_redirected_stdio(
                &mut store,
                &mut imports,
                &Arc::new(Mutex::new(Some(memory.clone()))),
            );
            let Some(Extern::Function(stat)) = imports.get_export(namespace, "fd_fdstat_get")
            else {
                panic!("missing fdstat wrapper");
            };
            for fd in [0, 1, 2, 3, 999] {
                memory.view(&store).write(32, &[0x5a; 24]).unwrap();
                let pointer = if namespace == "wasix_64v1" {
                    Value::I64(32)
                } else {
                    Value::I32(32)
                };
                let result = stat.call(&mut store, &[Value::I32(fd), pointer]).unwrap();
                assert!(
                    matches!(result.as_ref(), [Value::I32(errno)] if *errno == if fd == 999 { 8 } else { 0 })
                );
                let mut actual = [0; 24];
                memory.view(&store).read(32, &mut actual).unwrap();
                let mut expected = [0x5a; 24];
                if fd <= 2 {
                    expected[0] = Filetype::Unknown as u8;
                } else if fd == 3 {
                    expected[0] = Filetype::CharacterDevice as u8;
                }
                assert_eq!(actual, expected, "{namespace} fd {fd}");
            }
        }
    }
}
