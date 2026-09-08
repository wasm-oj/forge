use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;
use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen_futures::spawn_local;
use wasmer::Engine;
use wasmer_wasix::runtime::task_manager::{
    SpawnMemoryTypeOrStore, SpawnType, TaskWasm, TaskWasmRunProperties, VirtualTaskManager,
};
use wasmer_wasix::{PluggableRuntime, Runtime, WasiFunctionEnv, WasiThreadError};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

thread_local! {
    static WAIT_CELL: js_sys::Int32Array = js_sys::Int32Array::new(&js_sys::SharedArrayBuffer::new(4));
}

#[derive(Debug, Default)]
pub struct WebTaskManager {
    pub host_clock: bool,
}

impl VirtualTaskManager for WebTaskManager {
    fn sleep_now(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + Sync>> {
        if !self.host_clock || duration.is_zero() {
            return Box::pin(async {});
        }
        let deadline_ms = performance_now() + duration.as_secs_f64() * 1000.0;
        Box::pin(poll_fn(move |context| {
            let remaining_ms = deadline_ms - performance_now();
            if remaining_ms <= 0.0 {
                return Poll::Ready(());
            }
            // Wasmer synchronously polls timer and I/O futures together. A full
            // blocking sleep here would hide an already-ready I/O/cleanup branch.
            // Wake before returning Pending so its synchronous parker can repoll.
            context.waker().wake_by_ref();
            WAIT_CELL.with(|cell| {
                if let Err(error) =
                    js_sys::Atomics::wait_with_timeout(cell, 0, 0, remaining_ms.min(1.0))
                {
                    wasm_bindgen::throw_val(error);
                }
            });
            Poll::Pending
        }))
    }

    fn task_shared(
        &self,
        task: Box<
            dyn FnOnce() -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> + Send + 'static,
        >,
    ) -> Result<(), WasiThreadError> {
        spawn_local(async move { task().await });
        Ok(())
    }

    fn task_wasm(&self, task: TaskWasm) -> Result<(), WasiThreadError> {
        let TaskWasm {
            callbacks,
            env,
            module,
            globals,
            spawn_type,
            update_layout,
            call_initialize,
        } = task;
        let (memory, instance_group) = match spawn_type {
            SpawnType::CreateMemory => (SpawnMemoryTypeOrStore::New, None),
            SpawnType::NewLinkerInstanceGroup(group) => (SpawnMemoryTypeOrStore::New, Some(group)),
            SpawnType::CreateMemoryOfType(ty) => (SpawnMemoryTypeOrStore::Type(ty), None),
            SpawnType::AttachMemory(shared) => {
                let mut store = env.runtime().new_store();
                let memory = shared.attach(&mut store);
                (SpawnMemoryTypeOrStore::StoreAndMemory(store, memory), None)
            }
        };
        let (mut ctx, mut store) = WasiFunctionEnv::new_with_store(
            module,
            env,
            globals,
            memory,
            update_layout,
            call_initialize,
            instance_group,
        )?;
        if let Some(trigger) = callbacks.trigger {
            let run = callbacks.run;
            let recycle = callbacks.recycle;
            let pre_run = callbacks.pre_run;
            spawn_local(async move {
                let trigger_result = trigger().await;
                if let Some(pre_run) = pre_run {
                    pre_run(&mut ctx, &mut store).await;
                }
                run(TaskWasmRunProperties {
                    ctx,
                    store,
                    trigger_result: Some(trigger_result),
                    recycle,
                });
            });
        } else {
            spawn_local(async move {
                if let Some(pre_run) = callbacks.pre_run {
                    pre_run(&mut ctx, &mut store).await;
                }
                (callbacks.run)(TaskWasmRunProperties {
                    ctx,
                    store,
                    trigger_result: None,
                    recycle: callbacks.recycle,
                });
            });
        }
        Ok(())
    }

    fn task_dedicated(
        &self,
        task: Box<dyn FnOnce() + Send + 'static>,
    ) -> Result<(), WasiThreadError> {
        task();
        Ok(())
    }

    fn thread_parallelism(&self) -> Result<usize, WasiThreadError> {
        Ok(1)
    }
}

pub fn runtime_with_engine(engine: Engine, host_clock: bool) -> Arc<dyn Runtime + Send + Sync> {
    let tasks: Arc<dyn VirtualTaskManager> = Arc::new(WebTaskManager { host_clock });
    let mut runtime = PluggableRuntime::new(tasks);
    runtime.set_engine(engine);
    Arc::new(runtime)
}
