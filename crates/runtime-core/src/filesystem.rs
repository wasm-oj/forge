use crate::deterministic::COMPILER_DETERMINISM;
use crate::filesystem_quota::{VfsMetrics, VfsQuota};
use crate::{DeterminismConfig, ResourcePolicy, RunError};
use std::path::Path;
use std::sync::Arc;
use virtual_fs::{AsyncReadExt, AsyncWriteExt, FileSystem, FsError, TmpFileSystem, create_dir_all};

const NANOSECONDS_PER_MILLISECOND: u64 = 1_000_000;
const COMPILER_FILESYSTEM_WRITE_LIMIT_BYTES: usize = 512 * 1024 * 1024;
const COMPILER_FILESYSTEM_ENTRY_LIMIT: usize = 65_536;

pub fn runtime_project_files(
    files: &std::collections::BTreeMap<String, serde_bytes::ByteBuf>,
    output_paths: &[String],
    determinism: &DeterminismConfig,
    resources: &ResourcePolicy,
) -> Result<RuntimeProjectFilesystem, RunError> {
    quota_project_files_at_timestamp(
        files,
        output_paths,
        determinism
            .realtime_epoch_ms
            .saturating_mul(NANOSECONDS_PER_MILLISECOND),
        usize::try_from(resources.filesystem_write_limit_bytes).map_err(|_| {
            RunError::InvalidRequest("filesystem write limit exceeds host range".to_string())
        })?,
        usize::try_from(resources.filesystem_entry_limit).map_err(|_| {
            RunError::InvalidRequest("filesystem entry limit exceeds host range".to_string())
        })?,
    )
}

#[derive(Debug)]
pub struct RuntimeProjectFilesystem {
    filesystem: Arc<dyn FileSystem + Send + Sync>,
    quota: Arc<VfsQuota>,
}

impl RuntimeProjectFilesystem {
    pub fn filesystem(&self) -> Arc<dyn FileSystem + Send + Sync> {
        self.filesystem.clone()
    }

    pub fn quota_exceeded(&self) -> bool {
        self.quota.exceeded()
    }

    pub fn metrics(&self) -> VfsMetrics {
        self.quota.metrics()
    }
}

/// Mount compiler inputs at Forge's contract-fixed build epoch.
///
/// Execution determinism is deliberately absent from the build identity. Input
/// metadata must therefore remain invariant when callers change run seeds or
/// clocks; otherwise compiler features such as C/C++ `__TIMESTAMP__` could make
/// one cache key describe multiple artifacts.
pub fn compiler_project_files(
    files: &std::collections::BTreeMap<String, serde_bytes::ByteBuf>,
    output_paths: &[String],
) -> Result<RuntimeProjectFilesystem, RunError> {
    quota_project_files_at_timestamp(
        files,
        output_paths,
        COMPILER_DETERMINISM
            .realtime_epoch_ms
            .saturating_mul(NANOSECONDS_PER_MILLISECOND),
        COMPILER_FILESYSTEM_WRITE_LIMIT_BYTES,
        COMPILER_FILESYSTEM_ENTRY_LIMIT,
    )
}

fn quota_project_files_at_timestamp(
    files: &std::collections::BTreeMap<String, serde_bytes::ByteBuf>,
    output_paths: &[String],
    timestamp_ns: u64,
    write_limit_bytes: usize,
    entry_limit: usize,
) -> Result<RuntimeProjectFilesystem, RunError> {
    let quota = VfsQuota::new();
    let fs = TmpFileSystem::with_fixed_timestamp(timestamp_ns);
    fs.set_memory_limiter(quota.clone());
    mount_project_files(&fs, files)?;
    let filesystem: Arc<dyn FileSystem + Send + Sync> = Arc::new(fs);
    create_output_parent_directories(&filesystem, output_paths)?;
    quota.seal(write_limit_bytes, entry_limit)?;
    Ok(RuntimeProjectFilesystem { filesystem, quota })
}

fn mount_project_files(
    fs: &TmpFileSystem,
    files: &std::collections::BTreeMap<String, serde_bytes::ByteBuf>,
) -> Result<(), RunError> {
    for (raw_path, contents) in files {
        let path = Path::new(raw_path);
        if !is_normalized_guest_path(raw_path) {
            return Err(RunError::InvalidRequest(format!(
                "guest file path must be absolute and may not contain '..': {raw_path}"
            )));
        }
        if let Some(parent) = path.parent() {
            create_dir_all(fs, parent)
                .map_err(|error| RunError::Io(format!("failed to create {parent:?}: {error}")))?;
        }
        let mut file = fs
            .new_open_options()
            .create(true)
            .truncate(true)
            .write(true)
            .open(path)
            .map_err(|error| RunError::Io(format!("failed to create {raw_path}: {error}")))?;
        futures::executor::block_on(async {
            file.write_all(contents.as_ref()).await?;
            file.flush().await
        })
        .map_err(|error| RunError::Io(format!("failed to mount {raw_path}: {error}")))?;
    }
    Ok(())
}

pub fn read_files(
    fs: &Arc<dyn FileSystem + Send + Sync>,
    paths: &[String],
) -> Result<std::collections::BTreeMap<String, serde_bytes::ByteBuf>, RunError> {
    let mut files = std::collections::BTreeMap::new();
    for raw_path in paths {
        if !is_normalized_guest_path(raw_path) {
            return Err(RunError::InvalidRequest(format!(
                "output path must be absolute and normalized: {raw_path}"
            )));
        }
        let mut file = match fs.new_open_options().read(true).open(Path::new(raw_path)) {
            Ok(file) => file,
            Err(FsError::EntryNotFound) => continue,
            Err(error) => {
                return Err(RunError::Io(format!(
                    "failed to open compiler output {raw_path}: {error}"
                )));
            }
        };
        let mut contents = Vec::new();
        futures::executor::block_on(file.read_to_end(&mut contents)).map_err(|error| {
            RunError::Io(format!(
                "failed to read compiler output {raw_path}: {error}"
            ))
        })?;
        files.insert(raw_path.clone(), serde_bytes::ByteBuf::from(contents));
    }
    Ok(files)
}

pub fn create_output_parent_directories(
    fs: &Arc<dyn FileSystem + Send + Sync>,
    paths: &[String],
) -> Result<(), RunError> {
    for raw_path in paths {
        if !is_normalized_guest_path(raw_path) || raw_path == "/" {
            return Err(RunError::InvalidRequest(format!(
                "output path must be an absolute normalized file path: {raw_path}"
            )));
        }
        if let Some(parent) = Path::new(raw_path).parent() {
            create_dir_all(fs.as_ref(), parent).map_err(|error| {
                RunError::Io(format!(
                    "failed to create output directory {parent:?}: {error}"
                ))
            })?;
        }
    }
    Ok(())
}

pub fn read_files_bounded(
    fs: &Arc<dyn FileSystem + Send + Sync>,
    paths: &[String],
    limit: usize,
) -> Result<
    (
        std::collections::BTreeMap<String, serde_bytes::ByteBuf>,
        bool,
    ),
    RunError,
> {
    let mut files = std::collections::BTreeMap::new();
    let mut total = 0usize;
    for raw_path in paths {
        let path = Path::new(raw_path);
        let metadata = match fs.metadata(path) {
            Ok(metadata) => metadata,
            Err(FsError::EntryNotFound) => continue,
            Err(error) => {
                return Err(RunError::Io(format!(
                    "failed to inspect runtime output {raw_path}: {error}"
                )));
            }
        };
        let length = usize::try_from(metadata.len()).map_err(|_| {
            RunError::Io(format!(
                "runtime output {raw_path} exceeds the host size range"
            ))
        })?;
        if length > limit.saturating_sub(total) {
            return Ok((std::collections::BTreeMap::new(), true));
        }
        let mut file = fs
            .new_open_options()
            .read(true)
            .open(path)
            .map_err(|error| {
                RunError::Io(format!("failed to open runtime output {raw_path}: {error}"))
            })?;
        let mut contents = Vec::with_capacity(length);
        futures::executor::block_on(file.read_to_end(&mut contents)).map_err(|error| {
            RunError::Io(format!("failed to read runtime output {raw_path}: {error}"))
        })?;
        if contents.len() != length {
            return Err(RunError::Io(format!(
                "runtime output {raw_path} changed while it was collected"
            )));
        }
        total += contents.len();
        files.insert(raw_path.clone(), serde_bytes::ByteBuf::from(contents));
    }
    Ok((files, false))
}

pub fn is_normalized_guest_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.contains('\\')
        && !path
            .split('/')
            .any(|component| component == "." || component == "..")
        && (path == "/" || (!path.ends_with('/') && !path.contains("//")))
}

#[cfg(test)]
mod tests {
    use super::{
        NANOSECONDS_PER_MILLISECOND, compiler_project_files, is_normalized_guest_path,
        runtime_project_files,
    };
    use crate::deterministic::COMPILER_DETERMINISM;
    use crate::{DeterminismConfig, ResourcePolicy};
    use serde_bytes::ByteBuf;
    use std::collections::BTreeMap;
    use std::io::SeekFrom;
    use std::path::Path;
    use virtual_fs::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, FileSystem};

    #[test]
    fn validates_guest_paths_independently_of_host_path_semantics() {
        assert!(is_normalized_guest_path("/project/build/main.pyc"));
        assert!(is_normalized_guest_path("/"));
        assert!(!is_normalized_guest_path("project/main.py"));
        assert!(!is_normalized_guest_path("/project/../secret"));
        assert!(!is_normalized_guest_path("/project//main.py"));
    }

    #[test]
    fn mounts_seekable_runtime_files() {
        let files = BTreeMap::from([(
            "/runtime/library.zip".to_string(),
            ByteBuf::from(b"abcdef".to_vec()),
        )]);
        let project = runtime_project_files(&files, &[], &determinism(), &resources()).unwrap();
        let fs = project.filesystem();
        let mut file = fs
            .new_open_options()
            .read(true)
            .open(Path::new("/runtime/library.zip"))
            .unwrap();
        let bytes = futures::executor::block_on(async {
            file.seek(SeekFrom::Start(2)).await.unwrap();
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).await.unwrap();
            bytes
        });
        assert_eq!(bytes, b"cdef");
    }

    #[test]
    fn fixes_implicit_metadata_updates_to_the_deterministic_epoch() {
        let config = determinism();
        let expected = config.realtime_epoch_ms * 1_000_000;
        let files = BTreeMap::from([(
            "/project/input.txt".to_string(),
            ByteBuf::from(b"input".to_vec()),
        )]);
        let project = runtime_project_files(&files, &[], &config, &resources()).unwrap();
        let fs = project.filesystem();

        for path in ["/", "/project", "/project/input.txt"] {
            let metadata = fs.metadata(Path::new(path)).unwrap();
            assert_eq!(metadata.accessed(), expected);
            assert_eq!(metadata.created(), expected);
            assert_eq!(metadata.modified(), expected);
        }

        let mut file = fs
            .new_open_options()
            .read(true)
            .write(true)
            .open(Path::new("/project/input.txt"))
            .unwrap();
        futures::executor::block_on(file.write_all(b"updated")).unwrap();
        let metadata = fs.metadata(Path::new("/project/input.txt")).unwrap();
        assert_eq!(metadata.accessed(), expected);
        assert_eq!(metadata.modified(), expected);
    }

    #[test]
    fn rejects_file_growth_before_any_partial_sparse_write() {
        let mut limits = resources();
        limits.filesystem_write_limit_bytes = 4;
        limits.filesystem_entry_limit = 1;
        let project =
            runtime_project_files(&BTreeMap::new(), &[], &determinism(), &limits).unwrap();
        let fs = project.filesystem();
        let mut file = fs
            .new_open_options()
            .create(true)
            .write(true)
            .open(Path::new("/large.bin"))
            .unwrap();
        let error = futures::executor::block_on(async {
            file.seek(SeekFrom::Start(8)).await.unwrap();
            file.write_all(b"x").await.unwrap_err()
        });

        assert_eq!(error.kind(), std::io::ErrorKind::WriteZero);
        assert_eq!(fs.metadata(Path::new("/large.bin")).unwrap().len(), 0);
        assert!(project.quota_exceeded());
        assert_eq!(
            project.metrics(),
            super::VfsMetrics {
                bytes: 0,
                entries: 1
            }
        );
    }

    #[test]
    fn rejects_new_inodes_without_removing_the_existing_entry() {
        let mut limits = resources();
        limits.filesystem_entry_limit = 1;
        let project =
            runtime_project_files(&BTreeMap::new(), &[], &determinism(), &limits).unwrap();
        let fs = project.filesystem();
        fs.new_open_options()
            .create(true)
            .write(true)
            .open(Path::new("/first"))
            .unwrap();
        let error = fs
            .new_open_options()
            .create(true)
            .write(true)
            .open(Path::new("/second"))
            .unwrap_err();

        assert_eq!(error, virtual_fs::FsError::WriteZero);
        assert!(fs.metadata(Path::new("/first")).is_ok());
        assert_eq!(
            fs.metadata(Path::new("/second")),
            Err(virtual_fs::FsError::EntryNotFound)
        );
        assert!(project.quota_exceeded());
    }

    #[test]
    fn exact_limit_overwrite_truncate_and_delete_preserve_accounting() {
        let mut limits = resources();
        limits.filesystem_write_limit_bytes = 4;
        limits.filesystem_entry_limit = 1;
        let project =
            runtime_project_files(&BTreeMap::new(), &[], &determinism(), &limits).unwrap();
        let fs = project.filesystem();
        let mut first = fs
            .new_open_options()
            .create(true)
            .read(true)
            .write(true)
            .open(Path::new("/first"))
            .unwrap();

        futures::executor::block_on(async {
            first.write_all(b"1234").await.unwrap();
            first.seek(SeekFrom::Start(0)).await.unwrap();
            first.write_all(b"abcd").await.unwrap();
        });
        first.set_len(0).unwrap();
        futures::executor::block_on(first.write_all(b"5678")).unwrap();
        drop(first);
        fs.remove_file(Path::new("/first")).unwrap();

        let mut second = fs
            .new_open_options()
            .create(true)
            .write(true)
            .open(Path::new("/second"))
            .unwrap();
        futures::executor::block_on(second.write_all(b"wxyz")).unwrap();

        assert!(!project.quota_exceeded());
        assert_eq!(
            project.metrics(),
            super::VfsMetrics {
                bytes: 4,
                entries: 1
            }
        );
        assert_eq!(fs.metadata(Path::new("/second")).unwrap().len(), 4);
    }

    #[test]
    fn compiler_metadata_uses_the_contract_build_epoch() {
        let files = BTreeMap::from([(
            "/project/main.c".to_string(),
            ByteBuf::from(b"const char *stamp = __TIMESTAMP__;\n".to_vec()),
        )]);
        let first = compiler_project_files(&files, &[]).unwrap().filesystem();
        let second = compiler_project_files(&files, &[]).unwrap().filesystem();
        let expected = COMPILER_DETERMINISM.realtime_epoch_ms * NANOSECONDS_PER_MILLISECOND;

        for filesystem in [first, second] {
            for path in ["/", "/project", "/project/main.c"] {
                let metadata = filesystem.metadata(Path::new(path)).unwrap();
                assert_eq!(metadata.accessed(), expected);
                assert_eq!(metadata.created(), expected);
                assert_eq!(metadata.modified(), expected);
            }
        }
    }

    fn determinism() -> DeterminismConfig {
        DeterminismConfig {
            random_seed: 7,
            realtime_epoch_ms: 946_684_800_000,
            clock_step_ns: 1_000_000,
        }
    }

    fn resources() -> ResourcePolicy {
        ResourcePolicy {
            instruction_budget: 1_000_000,
            logical_time_limit_ms: 60_000,
            memory_limit_bytes: 2 * 65_536,
            output_limit_bytes: 1_024,
            filesystem_write_limit_bytes: 64 * 1024 * 1024,
            filesystem_entry_limit: 4_096,
        }
    }
}
