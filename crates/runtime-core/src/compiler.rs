use crate::capabilities::attach_capability_denials;
use crate::deterministic::{COMPILER_DETERMINISM, attach_deterministic_imports};
use crate::filesystem::{
    RuntimeProjectFilesystem, compiler_project_files, is_normalized_guest_path, read_files,
};
use crate::module_imports::attach_imported_memory;
use crate::module_policy::{DEFERRED_START_EXPORT, defer_start_section, validate_memory_limit};
use crate::output::{OutputBudget, OutputCapture};
use crate::{
    CompilePipelineResult, CompileRequest, CompileResponse, CompileResult, CompilerToolchainConfig,
    ExecutionTermination, RunError, RunFailure,
};
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use wasmer::{AsStoreMut, Engine, Imports, Instance, Memory, Module, Store};
use wasmer_types::StoreId;
use wasmer_wasix::bin_factory::{BinaryPackage, spawn_exec};
use wasmer_wasix::runtime::module_cache::{self, ModuleCache};
use wasmer_wasix::runtime::package_loader::BuiltinPackageLoader;
use wasmer_wasix::{
    Pipe, PluggableRuntime, Runtime, WasiEnv, WasiError, WasiModuleInstanceHandles,
    WasiModuleTreeHandles, wasmer_wasix_types,
};
use webc::Container;

/// A content-verified compiler package reusable across isolated invocations.
///
/// Package command metadata remains authoritative for argv, imported memory,
/// and child commands. Each `compile` call creates a fresh process tree,
/// deterministic import state, and in-memory filesystem.
pub struct CompilerToolchain {
    engine: Engine,
    package: BinaryPackage,
    /// Compiled-module cache shared by every compile lifecycle.
    ///
    /// Modules are immutable once compiled, so sharing the cache keeps the
    /// per-request isolation contract (fresh store, instance, WASI state, and
    /// filesystem per compile) while avoiding a full atom recompilation on
    /// every request.
    module_cache: Arc<dyn ModuleCache + Send + Sync>,
}

impl CompilerToolchain {
    pub fn new(config: CompilerToolchainConfig) -> Result<Self, RunError> {
        validate_toolchain_config(&config)?;
        with_native_runtime(|| {
            let version = webc::detect(&config.package[..]).map_err(|error| {
                RunError::Compile(format!("failed to detect compiler package: {error}"))
            })?;
            let container = Container::from_bytes_and_version(config.package.into(), version)
                .map_err(|error| {
                    RunError::Compile(format!("failed to parse compiler package: {error}"))
                })?;
            for (name, command) in &container.manifest().commands {
                let atom = command
                    .atom()
                    .map_err(|error| {
                        RunError::Compile(format!(
                            "failed to inspect compiler command '{name}': {error}"
                        ))
                    })?
                    .ok_or_else(|| {
                        RunError::Compile(format!(
                            "compiler command '{name}' has no atom annotation"
                        ))
                    })?;
                let bytes = container.get_atom(&atom.name).ok_or_else(|| {
                    RunError::Compile(format!(
                        "compiler command '{name}' references missing atom '{}'",
                        atom.name
                    ))
                })?;
                validate_memory_limit(bytes.as_ref(), config.memory_limit_bytes)
                    .map_err(RunError::Compile)?;
            }

            let engine = compiler_engine(config.memory_limit_bytes)?;
            let module_cache: Arc<dyn ModuleCache + Send + Sync> =
                Arc::new(module_cache::in_memory());
            let mut loader_runtime = compiler_runtime_base(engine.clone());
            loader_runtime.set_package_loader(BuiltinPackageLoader::new());
            loader_runtime.module_cache = module_cache.clone();
            let loader_runtime: Arc<dyn Runtime + Send + Sync> = Arc::new(loader_runtime);
            let package = futures::executor::block_on(BinaryPackage::from_webc(
                &container,
                loader_runtime.as_ref(),
            ))
            .map_err(|error| {
                RunError::Compile(format!("failed to load compiler package: {error}"))
            })?;
            if package.commands.is_empty() {
                return Err(RunError::Compile(
                    "compiler package exposes no commands".to_string(),
                ));
            }
            Ok(Self {
                engine,
                package,
                module_cache,
            })
        })
    }

    pub async fn compile(&self, request: CompileRequest) -> Result<CompileResult, RunError> {
        validate_compile_request(&request, &self.package)?;
        crate::run::validate_mounted_files(&request.files, "compiler")?;
        let project_filesystem = compiler_project_files(&request.files, &request.output_paths)?;
        self.compile_in_runtime(request, project_filesystem).await
    }

    pub async fn compile_pipeline(
        &self,
        files: std::collections::BTreeMap<String, serde_bytes::ByteBuf>,
        stages: Vec<CompileRequest>,
    ) -> Result<CompilePipelineResult, RunError> {
        if stages.is_empty() {
            return Err(RunError::InvalidRequest(
                "a compiler pipeline requires at least one stage".to_string(),
            ));
        }
        crate::run::validate_mounted_files(&files, "compiler")?;
        for stage in &stages {
            validate_compile_request(stage, &self.package)?;
            if !stage.files.is_empty() {
                return Err(RunError::InvalidRequest(
                    "compiler pipeline stage files must be declared in the shared file set"
                        .to_string(),
                ));
            }
        }
        let output_paths = stages
            .iter()
            .flat_map(|stage| stage.output_paths.iter().cloned())
            .collect::<Vec<_>>();
        let filesystem = compiler_project_files(&files, &output_paths)?;
        let mut results = Vec::with_capacity(stages.len());
        for stage in stages {
            let result = self.compile_direct(stage, &filesystem)?;
            let succeeded = result.code == 0;
            results.push(result);
            if !succeeded {
                break;
            }
        }
        Ok(CompilePipelineResult { stages: results })
    }

    pub async fn compile_response(&self, request: CompileRequest) -> CompileResponse {
        match self.compile(request).await {
            Ok(result) => CompileResponse {
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => CompileResponse {
                ok: false,
                result: None,
                error: Some(RunFailure {
                    code: error.code(),
                    message: error.to_string(),
                }),
            },
        }
    }

    async fn compile_in_runtime(
        &self,
        request: CompileRequest,
        project_filesystem: RuntimeProjectFilesystem,
    ) -> Result<CompileResult, RunError> {
        let filesystem = project_filesystem.filesystem();
        let (mut stdin_writer, stdin_reader) = Pipe::channel();
        stdin_writer
            .write_all(&request.stdin)
            .map_err(|error| RunError::Io(error.to_string()))?;
        drop(stdin_writer);

        let output_limit = usize::try_from(request.output_limit_bytes)
            .map_err(|_| RunError::InvalidRequest("output limit exceeds host range".to_string()))?;
        let output_budget = OutputBudget::new(output_limit);
        let (stdout_capture, stdout_file) = OutputCapture::new(output_budget.clone(), 1);
        let (stderr_capture, stderr_file) = OutputCapture::new(output_budget, 2);
        let runtime = compiler_runtime(
            self.engine.clone(),
            &COMPILER_DETERMINISM,
            self.module_cache.clone(),
        )?;

        let mut builder = WasiEnv::builder(&request.command)
            .runtime(runtime.clone())
            .args(request.args.clone())
            .envs(request.env.clone())
            .stdin(Box::new(stdin_reader))
            .stdout(Box::new(stdout_file))
            .stderr(Box::new(stderr_file))
            .fs(filesystem.clone())
            .use_webc(self.package.clone());
        builder
            .add_preopen_build(|directory| {
                directory.directory("/").read(true).write(true).create(true)
            })
            .map_err(|error| {
                RunError::InvalidRequest(format!("failed to preopen compiler filesystem: {error}"))
            })?;
        if let Some(cwd) = &request.cwd {
            builder.set_current_dir(cwd);
        }
        let env = builder.build().map_err(|error| {
            RunError::Compile(format!(
                "failed to build compiler WASI environment: {error}"
            ))
        })?;
        let command = self.package.get_command(&request.command).ok_or_else(|| {
            RunError::InvalidRequest(format!(
                "compiler package does not expose command '{}'",
                request.command
            ))
        })?;
        env.prepare_spawn(command);
        let mut handle = spawn_exec(self.package.clone(), &request.command, env, &runtime)
            .await
            .map_err(|error| {
                RunError::Compile(format!("failed to start compiler command: {error}"))
            })?;
        let exit_code = handle
            .wait_finished()
            .await
            .map_err(|error| RunError::Runtime(format!("compiler command failed: {error}")))?;

        let stdout = stdout_capture.bytes();
        let stderr = stderr_capture.bytes();
        let output_exceeded = stdout_capture.exceeded() || stderr_capture.exceeded();
        let output_files = read_files(&filesystem, &request.output_paths)?;
        let (code, termination) = if project_filesystem.quota_exceeded() {
            (137, ExecutionTermination::FilesystemLimit)
        } else if output_exceeded {
            (137, ExecutionTermination::OutputLimit)
        } else {
            (exit_code.raw(), ExecutionTermination::Exited)
        };
        Ok(CompileResult {
            code,
            stdout,
            stderr,
            output_files,
            termination,
        })
    }

    /// Execute one compiler stage directly in a fresh Wasmer store.
    ///
    /// Compiler pipelines deliberately share only their virtual filesystem.
    /// Every stage still receives a new store, WASI environment, deterministic
    /// host state, and module instance. Direct instantiation also keeps browser
    /// and native behavior aligned for toolchains that perform substantial
    /// random-access file I/O, such as the standard Go compiler and linker.
    fn compile_direct(
        &self,
        request: CompileRequest,
        project_filesystem: &RuntimeProjectFilesystem,
    ) -> Result<CompileResult, RunError> {
        let filesystem = project_filesystem.filesystem();
        let command = self.package.get_command(&request.command).ok_or_else(|| {
            RunError::InvalidRequest(format!(
                "compiler package does not expose command '{}'",
                request.command
            ))
        })?;
        let executable =
            defer_start_section(command.atom_ref().as_ref()).map_err(RunError::Compile)?;
        let mut store = Store::new(self.engine.clone());
        let module = Module::new(&store, &executable.wasm).map_err(|error| {
            RunError::Compile(format!(
                "failed to compile compiler command '{}': {error}",
                request.command
            ))
        })?;

        let (mut stdin_writer, stdin_reader) = Pipe::channel();
        stdin_writer
            .write_all(&request.stdin)
            .map_err(|error| RunError::Io(error.to_string()))?;
        drop(stdin_writer);

        let output_limit = usize::try_from(request.output_limit_bytes)
            .map_err(|_| RunError::InvalidRequest("output limit exceeds host range".to_string()))?;
        let output_budget = OutputBudget::new(output_limit);
        let (stdout_capture, stdout_file) = OutputCapture::new(output_budget.clone(), 1);
        let (stderr_capture, stderr_file) = OutputCapture::new(output_budget, 2);
        let runtime = compiler_runtime(
            self.engine.clone(),
            &COMPILER_DETERMINISM,
            self.module_cache.clone(),
        )?;

        let mut builder = WasiEnv::builder(&request.command)
            .runtime(runtime)
            .args(request.args.clone())
            .envs(request.env.clone())
            .stdin(Box::new(stdin_reader))
            .stdout(Box::new(stdout_file))
            .stderr(Box::new(stderr_file))
            .fs(filesystem.clone());
        builder
            .add_preopen_build(|directory| {
                directory.directory("/").read(true).write(true).create(true)
            })
            .map_err(|error| {
                RunError::InvalidRequest(format!("failed to preopen compiler filesystem: {error}"))
            })?;
        if let Some(cwd) = &request.cwd {
            builder.set_current_dir(cwd);
        }
        let mut sandbox = builder.finalize(&mut store).map_err(|error| {
            RunError::Compile(format!(
                "failed to finalize compiler WASI environment: {error}"
            ))
        })?;
        let mut imports = sandbox
            .import_object_for_all_wasi_versions(&mut store, &module)
            .map_err(|error| {
                RunError::Compile(format!("failed to create compiler WASI imports: {error}"))
            })?;
        let memory_slot: Arc<Mutex<Option<Memory>>> = Arc::new(Mutex::new(None));
        attach_deterministic_imports(
            &mut store,
            &mut imports,
            memory_slot.clone(),
            &COMPILER_DETERMINISM,
            crate::deterministic::VirtualClock::unbounded(&COMPILER_DETERMINISM),
            0,
        );
        attach_capability_denials(&mut store, &module, &mut imports).map_err(RunError::Compile)?;
        let imported_memory =
            attach_imported_memory(&mut store, &module, &mut imports).map_err(RunError::Compile)?;
        let instance = Instance::new(&mut store, &module, &imports).map_err(|error| {
            RunError::Compile(format!(
                "failed to instantiate compiler command '{}': {error}",
                request.command
            ))
        })?;
        let guest_memory = instance
            .exports
            .get_memory("memory")
            .cloned()
            .ok()
            .or(imported_memory)
            .ok_or_else(|| {
                RunError::Compile(format!(
                    "compiler command '{}' has no guest linear memory",
                    request.command
                ))
            })?;
        *memory_slot
            .lock()
            .map_err(|error| RunError::Runtime(error.to_string()))? = Some(guest_memory.clone());
        let handles = WasiModuleTreeHandles::Static(WasiModuleInstanceHandles::new(
            guest_memory,
            &store,
            instance.clone(),
            None,
        ));
        sandbox
            .initialize_handles_and_layout(&mut store, instance.clone(), handles, None, true)
            .map_err(|error| {
                RunError::Compile(format!("failed to initialize compiler instance: {error}"))
            })?;
        let start = instance.exports.get_function("_start").map_err(|error| {
            RunError::Compile(format!(
                "compiler command '{}' has no _start function: {error}",
                request.command
            ))
        })?;
        let execution = if executable.has_deferred_start {
            let initializer = instance
                .exports
                .get_function(DEFERRED_START_EXPORT)
                .map_err(|error| {
                    RunError::Runtime(format!(
                        "compiler deferred start function is unavailable: {error}"
                    ))
                })?;
            match initializer.call(&mut store, &[]) {
                Ok(_) => start.call(&mut store, &[]),
                Err(error) => Err(error),
            }
        } else {
            start.call(&mut store, &[])
        };

        let mut code = 0;
        if let Err(error) = execution {
            if let Some(wasi_error) = crate::wasi_error(&error) {
                match wasi_error {
                    WasiError::Exit(exit) => {
                        let errno: wasmer_wasix_types::wasi::Errno = (*exit).into();
                        code = errno as i32;
                    }
                    WasiError::UnknownWasiVersion => {
                        return Err(RunError::WasiUnsupported(
                            "unknown compiler WASI version".to_string(),
                        ));
                    }
                    WasiError::ThreadExit => {
                        return Err(RunError::WasiUnsupported(
                            "compiler thread exit".to_string(),
                        ));
                    }
                    WasiError::DeepSleep(_) => {
                        return Err(RunError::WasiUnsupported("compiler deep sleep".to_string()));
                    }
                    WasiError::DlSymbolResolutionFailed(symbol) => {
                        return Err(RunError::WasiUnsupported(format!(
                            "compiler unresolved symbol {symbol}"
                        )));
                    }
                }
            } else {
                return Err(RunError::Runtime(format!(
                    "compiler command '{}' trapped: {error}",
                    request.command
                )));
            }
        }
        sandbox.on_exit(
            &mut store,
            Some(wasmer_wasix_types::wasi::Errno::Success.into()),
        );

        let stdout = stdout_capture.bytes();
        let stderr = stderr_capture.bytes();
        let output_exceeded = stdout_capture.exceeded() || stderr_capture.exceeded();
        let output_files = read_files(&filesystem, &request.output_paths)?;
        let (code, termination) = if project_filesystem.quota_exceeded() {
            (137, ExecutionTermination::FilesystemLimit)
        } else if output_exceeded {
            (137, ExecutionTermination::OutputLimit)
        } else {
            (code, ExecutionTermination::Exited)
        };
        Ok(CompileResult {
            code,
            stdout,
            stderr,
            output_files,
            termination,
        })
    }
}

fn compiler_runtime(
    engine: Engine,
    determinism: &crate::DeterminismConfig,
    module_cache: Arc<dyn ModuleCache + Send + Sync>,
) -> Result<Arc<dyn Runtime + Send + Sync>, RunError> {
    type MemorySlot = Arc<Mutex<Option<Memory>>>;
    let pending: Arc<Mutex<HashMap<StoreId, MemorySlot>>> = Arc::new(Mutex::new(HashMap::new()));
    let imports_pending = pending.clone();
    let instance_pending = pending;
    let config = determinism.clone();
    let mut runtime = compiler_runtime_base(engine);
    runtime.module_cache = module_cache;
    runtime.with_additional_imports(move |_module, store| {
        let store_id = store.objects_mut().id();
        let memory = Arc::new(Mutex::new(None));
        let mut pending = imports_pending
            .lock()
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        if pending.insert(store_id, memory.clone()).is_some() {
            return Err(std::io::Error::other(
                "deterministic import state already exists for compiler store",
            )
            .into());
        }
        drop(pending);
        let mut imports = Imports::new();
        attach_deterministic_imports(
            store,
            &mut imports,
            memory,
            &config,
            crate::deterministic::VirtualClock::unbounded(&config),
            0,
        );
        Ok(imports)
    });
    runtime.with_instance_setup(move |_module, store, instance, imported_memory| {
        let store_id = store.objects_mut().id();
        let memory_slot = instance_pending
            .lock()
            .map_err(|error| std::io::Error::other(error.to_string()))?
            .remove(&store_id)
            .ok_or_else(|| {
                std::io::Error::other("compiler instance has no deterministic import state")
            })?;
        let memory = instance
            .exports
            .get_memory("memory")
            .cloned()
            .ok()
            .or_else(|| imported_memory.cloned())
            .ok_or_else(|| std::io::Error::other("compiler instance has no linear memory"))?;
        *memory_slot
            .lock()
            .map_err(|error| std::io::Error::other(error.to_string()))? = Some(memory);
        Ok(())
    });
    Ok(Arc::new(runtime))
}

fn validate_toolchain_config(config: &CompilerToolchainConfig) -> Result<(), RunError> {
    if config.package.is_empty() {
        return Err(RunError::InvalidRequest(
            "compiler package must not be empty".to_string(),
        ));
    }
    if config.memory_limit_bytes == 0 || !config.memory_limit_bytes.is_multiple_of(65_536) {
        return Err(RunError::InvalidRequest(
            "memoryLimitBytes must be a positive multiple of 64 KiB".to_string(),
        ));
    }
    Ok(())
}

fn validate_compile_request(
    request: &CompileRequest,
    package: &BinaryPackage,
) -> Result<(), RunError> {
    if request.command.is_empty() || package.get_command(&request.command).is_none() {
        return Err(RunError::InvalidRequest(format!(
            "compiler package does not expose command '{}'",
            request.command
        )));
    }
    if request.output_limit_bytes == 0 || usize::try_from(request.output_limit_bytes).is_err() {
        return Err(RunError::InvalidRequest(
            "outputLimitBytes is not representable on this host".to_string(),
        ));
    }
    if let Some(cwd) = &request.cwd
        && !is_normalized_guest_path(cwd)
    {
        return Err(RunError::InvalidRequest(
            "cwd must be an absolute normalized guest path".to_string(),
        ));
    }
    for output_path in &request.output_paths {
        if !is_normalized_guest_path(output_path) {
            return Err(RunError::InvalidRequest(format!(
                "output path must be absolute and normalized: {output_path}"
            )));
        }
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn compiler_runtime_base(engine: Engine) -> PluggableRuntime {
    let tasks: Arc<dyn wasmer_wasix::runtime::task_manager::VirtualTaskManager> =
        Arc::new(crate::run::web_runtime::WebTaskManager);
    let mut runtime = PluggableRuntime::new(tasks);
    runtime.set_engine(engine);
    runtime
}

#[cfg(not(target_arch = "wasm32"))]
fn compiler_runtime_base(engine: Engine) -> PluggableRuntime {
    use wasmer_wasix::runtime::task_manager::tokio::TokioTaskManager;

    let tasks: Arc<dyn wasmer_wasix::runtime::task_manager::VirtualTaskManager> =
        Arc::new(TokioTaskManager::default());
    let mut runtime = PluggableRuntime::new(tasks);
    runtime.set_engine(engine);
    runtime
}

#[cfg(target_arch = "wasm32")]
fn compiler_engine(_memory_limit_bytes: u64) -> Result<Engine, RunError> {
    Ok(Engine::default())
}

#[cfg(not(target_arch = "wasm32"))]
fn compiler_engine(memory_limit_bytes: u64) -> Result<Engine, RunError> {
    use crate::memory::LimitingTunables;
    use wasmer::Pages;
    use wasmer::sys::{BaseTunables, Cranelift, NativeEngineExt, Target};

    let pages = u32::try_from(memory_limit_bytes / 65_536).map_err(|_| {
        RunError::InvalidRequest("memory limit exceeds Wasmer page range".to_string())
    })?;
    let base = BaseTunables::for_target(&Target::default());
    let mut engine: Engine = Cranelift::default().into();
    engine.set_tunables(LimitingTunables::new(base, Pages(pages)));
    Ok(engine)
}

#[cfg(target_arch = "wasm32")]
fn with_native_runtime<T>(operation: impl FnOnce() -> Result<T, RunError>) -> Result<T, RunError> {
    operation()
}

#[cfg(not(target_arch = "wasm32"))]
fn with_native_runtime<T>(operation: impl FnOnce() -> Result<T, RunError>) -> Result<T, RunError> {
    let runtime = if tokio::runtime::Handle::try_current().is_err() {
        Some(
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| {
                    RunError::Runtime(format!("failed to initialize Tokio: {error}"))
                })?,
        )
    } else {
        None
    };
    let _runtime_guard = runtime.as_ref().map(tokio::runtime::Runtime::enter);
    operation()
}
