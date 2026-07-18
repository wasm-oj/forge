use ciborium::value::Value;
use filetime::{FileTime, set_file_mtime};
use flate2::{Compression, GzBuilder};
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Component, Path};
use url::Url;
use walrus::ModuleConfig;
use webc::metadata::annotations::{
    Atom as AtomAnnotation, FileSystemMapping, FileSystemMappings, WASI_RUNNER_URI, Wasi,
};
use webc::metadata::{Atom, AtomSignature, Command, Manifest};
use webc::v3::write::{Directory, FileEntry, Writer};
use webc::v3::{ChecksumAlgorithm, SignatureAlgorithm, Timestamps};

const VERSION: &str = "3.14.6";
const TARGET: &str = "wasm32-wasip1";
const WASI_SDK_VERSION: &str = "24.0";
const WASI_SDK_REVISION: &str = "d2bea01edcc46f731156a817f710cdd9fc9c1c19";
const LLVM_REVISION: &str = "26a1d6601d727a96f4301d0d8647b5a42760ae0c";
const WASI_LIBC_REVISION: &str = "b9ef79d7dbd47c6c5bafdae760823467c2f60b70";
const SOURCE_DATE_EPOCH: u64 = 1_781_085_833;
const ATOM_NAME: &str = "python";
const VOLUME_NAME: &str = "python";
const MOUNT_PATH: &str = "/usr/local";
const STDLIB_PATH: &str = "lib/python3.14";
const CANONICAL_SOURCE_ROOT: &str = "/usr/src/cpython-3.14.6";
const CANONICAL_BUILD_ROOT: &str = "/usr/src/cpython-3.14.6/cross-build/wasm32-wasip1";
const CANONICAL_BUILD_PYTHON: &str =
    "/usr/src/cpython-3.14.6/cross-build/aarch64-apple-darwin/python.exe";
const CANONICAL_WASI_SDK_ROOT: &str = "/opt/wasi-sdk-24.0";
const RUNTIME_FILES_FORMAT: &str = "FORGEFS1";
const RUNTIME_FILES_CACHE_KEY: &str =
    "wasm-oj-forge-v1:runtime-files:cpython-3.14.6-wasip1-stdlib-stored-zip";
const RUNTIME_FILES_GUEST_PATH: &str = "/cpython/lib/python314.zip";
const RUNTIME_FILES_ARCHIVE_SHA256: &str =
    "8aeae854650b5cc5af015dcfacb79f974d5a6997110c98b083cf4d618e20e4ba";
const RUNTIME_FILES_ARCHIVE_BYTES: u64 = 10_652_546;
const SOURCE_URL: &str = "https://www.python.org/ftp/python/3.14.6/Python-3.14.6.tar.xz";
const SPDX_URL: &str = "https://www.python.org/ftp/python/3.14.6/Python-3.14.6.tar.xz.spdx.json";
const WASI_SDK_URL: &str = "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-24/wasi-sdk-24.0-arm64-macos.tar.gz";
const EXCLUDED_STDLIB_ROOTS: &[&str] = &[
    "__pycache__",
    "__phello__",
    "ensurepip",
    "idlelib",
    "site-packages",
    "test",
    "tkinter",
    "turtledemo",
    "venv",
];
const EXPECTED_IMPORTS: &[&str] = &[
    "wasi_snapshot_preview1.args_get",
    "wasi_snapshot_preview1.args_sizes_get",
    "wasi_snapshot_preview1.clock_res_get",
    "wasi_snapshot_preview1.clock_time_get",
    "wasi_snapshot_preview1.environ_get",
    "wasi_snapshot_preview1.environ_sizes_get",
    "wasi_snapshot_preview1.fd_advise",
    "wasi_snapshot_preview1.fd_close",
    "wasi_snapshot_preview1.fd_datasync",
    "wasi_snapshot_preview1.fd_fdstat_get",
    "wasi_snapshot_preview1.fd_fdstat_set_flags",
    "wasi_snapshot_preview1.fd_filestat_get",
    "wasi_snapshot_preview1.fd_filestat_set_size",
    "wasi_snapshot_preview1.fd_filestat_set_times",
    "wasi_snapshot_preview1.fd_pread",
    "wasi_snapshot_preview1.fd_prestat_dir_name",
    "wasi_snapshot_preview1.fd_prestat_get",
    "wasi_snapshot_preview1.fd_pwrite",
    "wasi_snapshot_preview1.fd_read",
    "wasi_snapshot_preview1.fd_readdir",
    "wasi_snapshot_preview1.fd_seek",
    "wasi_snapshot_preview1.fd_sync",
    "wasi_snapshot_preview1.fd_tell",
    "wasi_snapshot_preview1.fd_write",
    "wasi_snapshot_preview1.path_create_directory",
    "wasi_snapshot_preview1.path_filestat_get",
    "wasi_snapshot_preview1.path_filestat_set_times",
    "wasi_snapshot_preview1.path_link",
    "wasi_snapshot_preview1.path_open",
    "wasi_snapshot_preview1.path_readlink",
    "wasi_snapshot_preview1.path_remove_directory",
    "wasi_snapshot_preview1.path_rename",
    "wasi_snapshot_preview1.path_symlink",
    "wasi_snapshot_preview1.path_unlink_file",
    "wasi_snapshot_preview1.poll_oneoff",
    "wasi_snapshot_preview1.proc_exit",
    "wasi_snapshot_preview1.random_get",
    "wasi_snapshot_preview1.sched_yield",
];

#[derive(Default)]
struct TreeStats {
    files: u64,
    bytes: u64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.len() == 3 && arguments[1] == "--verify" {
        return verify_package(Path::new(&arguments[2]));
    }
    if arguments.len() != 9 {
        return Err(
            "usage: package-python-webc SOURCE_ROOT HOST_BUILD_ROOT PYTHON_WASM SPDX_DOCUMENT LICENSE_ROOT OUTPUT_DIRECTORY SOURCE_ARCHIVE_SHA256 WASI_SDK_ARCHIVE_SHA256\n       package-python-webc --verify PACKAGE.webc"
                .into(),
        );
    }

    let source_root = Path::new(&arguments[1]);
    let host_build_root = Path::new(&arguments[2]);
    let python_wasm = Path::new(&arguments[3]);
    let spdx_document = Path::new(&arguments[4]);
    let license_root = Path::new(&arguments[5]);
    let output = Path::new(&arguments[6]);
    let source_archive_sha256 = validate_sha256(&arguments[7])?;
    let wasi_sdk_archive_sha256 = validate_sha256(&arguments[8])?;
    validate_source(source_root)?;

    let python = fs::read(python_wasm)?;
    validate_wasm(&python)?;
    let imports = validate_imports(&python)?;
    let spdx = fs::read(spdx_document)?;
    validate_spdx(&spdx, source_archive_sha256)?;

    let pybuilddir = fs::read_to_string(host_build_root.join("pybuilddir.txt"))?;
    let pybuilddir = pybuilddir.trim();
    validate_relative_path(pybuilddir)?;
    let sysconfig_root = host_build_root.join(pybuilddir);
    if !sysconfig_root.is_dir() {
        return Err(format!(
            "CPython sysconfig directory is missing '{}'",
            sysconfig_root.display()
        )
        .into());
    }

    let temporary = tempfile::tempdir()?;
    let volume_root = temporary.path().join(VOLUME_NAME);
    let stdlib_root = volume_root.join(STDLIB_PATH);
    let stats = copy_stdlib(&source_root.join("Lib"), &stdlib_root)?;
    copy_sysconfig(&sysconfig_root, &stdlib_root)?;
    copy_regular_file(
        &source_root.join("LICENSE"),
        &volume_root.join(format!("share/licenses/python-{VERSION}/LICENSE")),
    )?;
    let expat_license = fs::read(source_root.join("Modules/expat/COPYING"))?;
    let hacl_license = normalized_leading_c_comment(&fs::read(
        source_root.join("Modules/_hacl/Hacl_Hash_SHA2.c"),
    )?)?;
    let libmpdec_license = normalized_leading_c_comment(&fs::read(
        source_root.join("Modules/_decimal/libmpdec/mpdecimal.h"),
    )?)?;
    let wasi_sdk_license = read_pinned_license(
        license_root,
        "wasi-sdk-24.0-Apache-2.0-LLVM-exception.txt",
        "268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5",
    )?;
    let compiler_rt_license = read_pinned_license(
        license_root,
        "wasi-sdk-24.0-compiler-rt-LICENSE.txt",
        "1a8f1058753f1ba890de984e48f0242a3a5c29a6a8f2ed9fd813f36985387e8d",
    )?;
    let wasi_libc_notice = read_pinned_license(
        license_root,
        "wasi-libc-b9ef79d-LICENSE.txt",
        "673f577e363e80e0058bd78214683f045d1d0c63930969a87f01a1d87d7cf1d6",
    )?;
    let wasi_libc_apache = read_pinned_license(
        license_root,
        "wasi-libc-b9ef79d-Apache-2.0.txt",
        "a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2",
    )?;
    let wasi_libc_mit = read_pinned_license(
        license_root,
        "wasi-libc-b9ef79d-MIT.txt",
        "23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3",
    )?;
    let cloudlibc_license = read_pinned_license(
        license_root,
        "wasi-libc-b9ef79d-cloudlibc-BSD-2-Clause.txt",
        "c8b789cf5a746611e6300a0cc7750dbf92b61912a709d04e639245f7290656d0",
    )?;
    let dlmalloc_notice = read_pinned_license(
        license_root,
        "wasi-libc-b9ef79d-dlmalloc-CC0-NOTICE.txt",
        "5f7892f12d4d3eef88c379564dd1580e99d918e1128cabe1ec2cc3057727b6a2",
    )?;
    let emmalloc_notice = read_pinned_license(
        license_root,
        "wasi-libc-b9ef79d-emmalloc-NOTICE.txt",
        "b33ff4cd6bfb1eb7e600546b5b2c95f25145ef2fecd72d6976a5263996a5594f",
    )?;
    let musl_license = read_pinned_license(
        license_root,
        "wasi-libc-b9ef79d-musl-MIT.txt",
        "f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af",
    )?;
    copy_bytes(
        &expat_license,
        &volume_root.join(format!("share/licenses/python-{VERSION}/EXPAT-MIT.txt")),
    )?;
    copy_bytes(
        &hacl_license,
        &volume_root.join(format!("share/licenses/python-{VERSION}/HACL-STAR-MIT.txt")),
    )?;
    copy_bytes(
        &libmpdec_license,
        &volume_root.join(format!(
            "share/licenses/python-{VERSION}/LIBMPDEC-BSD-2-CLAUSE.txt"
        )),
    )?;
    for (name, contents) in [
        (
            "WASI-SDK-APACHE-2.0-LLVM-EXCEPTION.txt",
            wasi_sdk_license.as_slice(),
        ),
        ("COMPILER-RT-LICENSE.txt", compiler_rt_license.as_slice()),
        ("WASI-LIBC-NOTICE.txt", wasi_libc_notice.as_slice()),
        ("WASI-LIBC-APACHE-2.0.txt", wasi_libc_apache.as_slice()),
        ("WASI-LIBC-MIT.txt", wasi_libc_mit.as_slice()),
        ("CLOUDLIBC-BSD-2-CLAUSE.txt", cloudlibc_license.as_slice()),
        ("DLMALLOC-CC0-NOTICE.txt", dlmalloc_notice.as_slice()),
        ("EMMALLOC-NOTICE.txt", emmalloc_notice.as_slice()),
        ("MUSL-MIT.txt", musl_license.as_slice()),
    ] {
        copy_bytes(
            contents,
            &volume_root.join(format!("share/licenses/python-{VERSION}/toolchain/{name}")),
        )?;
    }
    copy_bytes(
        &spdx,
        &volume_root.join(format!("share/sbom/python-{VERSION}.spdx.json")),
    )?;
    normalize_timestamps(&volume_root)?;

    let package = build_package(&python, &volume_root)?;
    fs::create_dir_all(output)?;
    let package_name = format!("python-{VERSION}-wasip1.webc");
    let package_path = output.join(&package_name);
    let compressed_path = output.join(format!("{package_name}.gz.bin"));
    fs::write(&package_path, &package)?;
    write_gzip(&compressed_path, &package)?;
    verify_package(&package_path)?;

    let compressed = fs::read(&compressed_path)?;
    let manifest = serde_json::json!({
        "schema": "wasm-oj-forge-v1/python-toolchain",
        "version": VERSION,
        "target": TARGET,
        "source": {
            "url": SOURCE_URL,
            "archiveSha256": source_archive_sha256,
            "spdx": {
                "url": SPDX_URL,
                "sha256": sha256(&spdx),
                "packagedPath": format!("{MOUNT_PATH}/share/sbom/python-{VERSION}.spdx.json"),
            },
        },
        "wasiSdk": {
            "version": WASI_SDK_VERSION,
            "revision": WASI_SDK_REVISION,
            "url": WASI_SDK_URL,
            "archiveSha256": wasi_sdk_archive_sha256,
            "llvmRevision": LLVM_REVISION,
            "wasiLibcRevision": WASI_LIBC_REVISION,
        },
        "build": {
            "sourceDateEpoch": SOURCE_DATE_EPOCH,
            "hostRunner": "Wasmer",
            "configure": [
                "Tools/wasm/wasi configure-build-python",
                "Tools/wasm/wasi make-build-python",
                "Tools/wasm/wasi configure-host --without-ensurepip --disable-test-modules",
                "Tools/wasm/wasi make-host",
            ],
            "configureEnvironment": {
                "py_cv_module__socket": "n/a",
            },
            "disabledModules": ["_socket"],
            "strip": "llvm-strip --strip-debug",
        },
        "compiler": {
            "sha256": sha256(&python),
            "command": ATOM_NAME,
            "imports": imports,
        },
        "stdlib": {
            "mount": format!("{MOUNT_PATH}/{STDLIB_PATH}"),
            "files": stats.files,
            "bytes": stats.bytes,
            "excludedRoots": EXCLUDED_STDLIB_ROOTS,
            "excludedSuffixes": [".pyc", ".pyo"],
        },
        "sysconfig": {
            "sourceRoot": CANONICAL_SOURCE_ROOT,
            "buildRoot": CANONICAL_BUILD_ROOT,
            "wasiSdkRoot": CANONICAL_WASI_SDK_ROOT,
        },
        "licenses": [
            {
                "component": format!("CPython {VERSION}"),
                "expression": "PSF-2.0",
                "path": format!("{MOUNT_PATH}/share/licenses/python-{VERSION}/LICENSE"),
                "sha256": sha256(&fs::read(source_root.join("LICENSE"))?),
            },
            {
                "component": "Expat 2.8.1",
                "expression": "MIT",
                "path": format!("{MOUNT_PATH}/share/licenses/python-{VERSION}/EXPAT-MIT.txt"),
                "sha256": sha256(&expat_license),
            },
            {
                "component": "HACL* 8ba599b2f6c9701b3dc961db895b0856a2210f76",
                "expression": "MIT",
                "path": format!("{MOUNT_PATH}/share/licenses/python-{VERSION}/HACL-STAR-MIT.txt"),
                "sha256": sha256(&hacl_license),
            },
            {
                "component": "libmpdec 2.5.1",
                "expression": "BSD-2-Clause",
                "path": format!("{MOUNT_PATH}/share/licenses/python-{VERSION}/LIBMPDEC-BSD-2-CLAUSE.txt"),
                "sha256": sha256(&libmpdec_license),
            },
            {
                "component": format!("WASI SDK {WASI_SDK_VERSION} / LLVM compiler-rt {LLVM_REVISION}"),
                "expression": "Apache-2.0 WITH LLVM-exception",
                "path": format!("{MOUNT_PATH}/share/licenses/python-{VERSION}/toolchain/WASI-SDK-APACHE-2.0-LLVM-EXCEPTION.txt"),
                "sha256": sha256(&wasi_sdk_license),
            },
            {
                "component": format!("LLVM compiler-rt {LLVM_REVISION}"),
                "expression": "Apache-2.0 WITH LLVM-exception AND LicenseRef-LLVM-compiler-rt-third-party",
                "path": format!("{MOUNT_PATH}/share/licenses/python-{VERSION}/toolchain/COMPILER-RT-LICENSE.txt"),
                "sha256": sha256(&compiler_rt_license),
            },
            {
                "component": format!("wasi-libc {WASI_LIBC_REVISION}"),
                "expression": "Apache-2.0 WITH LLVM-exception",
                "path": format!("{MOUNT_PATH}/share/licenses/python-{VERSION}/toolchain/WASI-LIBC-NOTICE.txt"),
                "sha256": sha256(&wasi_libc_notice),
            },
            {
                "component": format!("wasi-libc {WASI_LIBC_REVISION} Apache alternative"),
                "expression": "Apache-2.0",
                "path": format!("{MOUNT_PATH}/share/licenses/python-{VERSION}/toolchain/WASI-LIBC-APACHE-2.0.txt"),
                "sha256": sha256(&wasi_libc_apache),
            },
            {
                "component": format!("wasi-libc {WASI_LIBC_REVISION} MIT alternative"),
                "expression": "MIT",
                "path": format!("{MOUNT_PATH}/share/licenses/python-{VERSION}/toolchain/WASI-LIBC-MIT.txt"),
                "sha256": sha256(&wasi_libc_mit),
            },
            {
                "component": "wasi-libc cloudlibc-derived portions",
                "expression": "BSD-2-Clause",
                "path": format!("{MOUNT_PATH}/share/licenses/python-{VERSION}/toolchain/CLOUDLIBC-BSD-2-CLAUSE.txt"),
                "sha256": sha256(&cloudlibc_license),
            },
            {
                "component": "dlmalloc 2.8.6",
                "expression": "CC0-1.0",
                "path": format!("{MOUNT_PATH}/share/licenses/python-{VERSION}/toolchain/DLMALLOC-CC0-NOTICE.txt"),
                "sha256": sha256(&dlmalloc_notice),
            },
            {
                "component": "wasi-libc emmalloc source alternative (not linked by this build)",
                "expression": "MIT OR NCSA",
                "path": format!("{MOUNT_PATH}/share/licenses/python-{VERSION}/toolchain/EMMALLOC-NOTICE.txt"),
                "sha256": sha256(&emmalloc_notice),
            },
            {
                "component": "wasi-libc musl-derived portions",
                "expression": "MIT",
                "path": format!("{MOUNT_PATH}/share/licenses/python-{VERSION}/toolchain/MUSL-MIT.txt"),
                "sha256": sha256(&musl_license),
            },
        ],
        "filesystemMount": MOUNT_PATH,
        "output": {
            "path": compressed_path.file_name().and_then(|name| name.to_str()),
            "sha256": sha256(&package),
            "compressedSha256": sha256(&compressed),
            "compressedBytes": compressed.len(),
            "uncompressedBytes": package.len(),
        },
        "runtimeFiles": {
            "format": RUNTIME_FILES_FORMAT,
            "cacheKey": RUNTIME_FILES_CACHE_KEY,
            "guestPath": RUNTIME_FILES_GUEST_PATH,
            "archiveSha256": RUNTIME_FILES_ARCHIVE_SHA256,
            "archiveBytes": RUNTIME_FILES_ARCHIVE_BYTES,
        },
    });
    let manifest_path = output.join(format!("python-{VERSION}-wasip1.manifest.json"));
    fs::write(
        &manifest_path,
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )?;
    println!("{}", serde_json::to_string(&manifest)?);
    Ok(())
}

fn verify_package(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let reader = webc::v3::read::OwnedReader::from_path(path)?;
    let manifest = reader.manifest();
    if manifest.entrypoint.as_deref() != Some(ATOM_NAME) {
        return Err("Python WebC entrypoint must be exactly 'python'".into());
    }
    if !manifest.use_map.is_empty() || !manifest.bindings.is_empty() {
        return Err("Python WebC must not declare dependencies or bindings".into());
    }
    if manifest.atoms.len() != 1 || !manifest.atoms.contains_key(ATOM_NAME) {
        return Err("Python WebC must contain exactly one atom named 'python'".into());
    }
    if reader.atom_names().collect::<Vec<_>>() != [ATOM_NAME] {
        return Err("Python WebC atom section must contain exactly 'python'".into());
    }
    if reader.volume_names().collect::<Vec<_>>() != [VOLUME_NAME] {
        return Err("Python WebC must contain exactly one volume named 'python'".into());
    }
    if manifest.commands.len() != 1 {
        return Err("Python WebC must expose exactly one command".into());
    }
    let command = manifest
        .commands
        .get(ATOM_NAME)
        .ok_or("Python WebC does not expose the 'python' command")?;
    if command.runner != WASI_RUNNER_URI {
        return Err("Python WebC python command must use the WASI runner".into());
    }
    if command.annotations.len() != 2
        || !command.annotations.contains_key(AtomAnnotation::KEY)
        || !command.annotations.contains_key(Wasi::KEY)
    {
        return Err("Python WebC python command has non-canonical annotations".into());
    }
    let atom = command
        .annotation::<AtomAnnotation>(AtomAnnotation::KEY)?
        .ok_or("Python WebC python command has no atom owner")?;
    if atom.name != ATOM_NAME || atom.dependency.is_some() {
        return Err("Python WebC python command must be owned by its local python atom".into());
    }
    let wasi = command
        .annotation::<Wasi>(Wasi::KEY)?
        .ok_or("Python WebC python command has no WASI annotation")?;
    if wasi.exec_name.as_deref() != Some(ATOM_NAME)
        || wasi.package.is_some()
        || wasi.env.is_some()
        || wasi.main_args.is_some()
        || wasi.mount_atom_in_volume.is_some()
        || wasi.cwd.is_some()
    {
        return Err("Python WebC python command has a non-canonical WASI annotation".into());
    }
    if manifest.package.len() != 1 {
        return Err("Python WebC must contain exactly one package annotation".into());
    }
    let filesystem = manifest
        .filesystem()?
        .ok_or("Python WebC has no filesystem mapping")?;
    let expected_mapping = FileSystemMapping {
        from: None,
        volume_name: VOLUME_NAME.to_string(),
        host_path: None,
        mount_path: MOUNT_PATH.to_string(),
    };
    if filesystem.as_slice() != [expected_mapping] {
        return Err(
            "Python WebC filesystem must map its python volume exactly to /usr/local".into(),
        );
    }

    let (_, atom_bytes) = reader
        .get_atom(ATOM_NAME)
        .ok_or("Python WebC python atom is missing from its atom section")?;
    validate_wasm(atom_bytes.as_slice())?;
    validate_imports(atom_bytes.as_slice())?;
    let volume = reader.get_volume(VOLUME_NAME)?;
    let (vars_bytes, _) = volume.lookup_file([
        "lib",
        "python3.14",
        "_sysconfig_vars__wasi_wasm32-wasi.json",
    ])?;
    let (data_bytes, _) =
        volume.lookup_file(["lib", "python3.14", "_sysconfigdata__wasi_wasm32-wasi.py"])?;
    let variables: BTreeMap<String, serde_json::Value> =
        serde_json::from_slice(vars_bytes.as_slice())?;
    let (canonical_json, canonical_python) = render_canonical_sysconfig(variables.clone())?;
    if variables != serde_json::from_str(&canonical_json)?
        || vars_bytes.as_slice() != canonical_json.as_bytes()
        || data_bytes.as_slice() != canonical_python.as_bytes()
    {
        return Err("Python WebC contains non-canonical sysconfig data".into());
    }
    let (build_details, _) = volume.lookup_file(["lib", "python3.14", "build-details.json"])?;
    validate_build_details(build_details.as_slice())?;
    println!("verified canonical Python WebC: {}", path.display());
    Ok(())
}

fn validate_source(source_root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let patchlevel = fs::read_to_string(source_root.join("Include/patchlevel.h"))?;
    let expected = format!("#define PY_VERSION              \"{VERSION}\"");
    if !patchlevel.lines().any(|line| line.trim_end() == expected) {
        return Err(format!("CPython source does not identify version {VERSION}").into());
    }
    if !source_root.join("Lib").is_dir() || !source_root.join("LICENSE").is_file() {
        return Err("CPython source is missing Lib or LICENSE".into());
    }
    Ok(())
}

fn validate_spdx(
    spdx: &[u8],
    source_archive_sha256: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let document: serde_json::Value = serde_json::from_slice(spdx)?;
    if document
        .get("documentNamespace")
        .and_then(|value| value.as_str())
        != Some(SPDX_URL)
    {
        return Err("CPython SPDX document has an unexpected namespace".into());
    }
    let packages = document
        .get("packages")
        .and_then(|value| value.as_array())
        .ok_or("CPython SPDX document has no package list")?;
    let cpython = packages
        .iter()
        .find(|package| {
            package.get("name").and_then(|value| value.as_str()) == Some("CPython")
                && package.get("versionInfo").and_then(|value| value.as_str()) == Some(VERSION)
        })
        .ok_or("CPython SPDX document does not describe the pinned CPython release")?;
    let has_digest = cpython
        .get("checksums")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .any(|checksum| {
            checksum.get("algorithm").and_then(|value| value.as_str()) == Some("SHA256")
                && checksum
                    .get("checksumValue")
                    .and_then(|value| value.as_str())
                    == Some(source_archive_sha256)
        });
    if !has_digest {
        return Err("CPython SPDX document does not bind the pinned source archive digest".into());
    }
    Ok(())
}

fn copy_stdlib(source: &Path, destination: &Path) -> Result<TreeStats, Box<dyn std::error::Error>> {
    let mut stats = TreeStats::default();
    copy_stdlib_directory(source, destination, true, &mut stats)?;
    Ok(stats)
}

fn copy_stdlib_directory(
    source: &Path,
    destination: &Path,
    root: bool,
    stats: &mut TreeStats,
) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(destination)?;
    set_directory_mode(destination)?;
    let mut entries = fs::read_dir(source)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if (root && EXCLUDED_STDLIB_ROOTS.contains(&name_text.as_ref()))
            || name_text == "__pycache__"
        {
            continue;
        }
        let source_path = entry.path();
        let destination_path = destination.join(&name);
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_stdlib_directory(&source_path, &destination_path, false, stats)?;
        } else if file_type.is_file() {
            if name_text.ends_with(".pyc") || name_text.ends_with(".pyo") {
                continue;
            }
            let bytes = fs::read(&source_path)?;
            copy_bytes(&bytes, &destination_path)?;
            stats.files += 1;
            stats.bytes += bytes.len() as u64;
        } else {
            return Err(format!(
                "unsupported CPython stdlib entry '{}'",
                source_path.display()
            )
            .into());
        }
    }
    Ok(())
}

fn copy_sysconfig(source: &Path, destination: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let data_name = "_sysconfigdata__wasi_wasm32-wasi.py";
    let vars_name = "_sysconfig_vars__wasi_wasm32-wasi.json";
    let details_name = "build-details.json";
    for name in [data_name, vars_name, details_name] {
        if !source.join(name).is_file() {
            return Err(format!(
                "CPython build is missing required sysconfig file '{}'",
                source.join(name).display()
            )
            .into());
        }
    }

    let variables: BTreeMap<String, serde_json::Value> =
        serde_json::from_slice(&fs::read(source.join(vars_name))?)?;
    let (canonical_json, canonical_python) = render_canonical_sysconfig(variables)?;
    copy_bytes(canonical_json.as_bytes(), &destination.join(vars_name))?;
    copy_bytes(canonical_python.as_bytes(), &destination.join(data_name))?;
    copy_regular_file(&source.join(details_name), &destination.join(details_name))?;
    Ok(())
}

fn render_canonical_sysconfig(
    mut variables: BTreeMap<String, serde_json::Value>,
) -> Result<(String, String), Box<dyn std::error::Error>> {
    canonicalize_sysconfig(&mut variables)?;
    let canonical_json = format!("{}\n", serde_json::to_string_pretty(&variables)?);
    let canonical_python = format!(
        "# Canonical system configuration generated for WASM OJ Forge.\n\
         build_time_vars = {canonical_json}"
    );
    Ok((canonical_json, canonical_python))
}

fn validate_build_details(bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    let document: serde_json::Value = serde_json::from_slice(bytes)?;
    if document
        .pointer("/schema_version")
        .and_then(|value| value.as_str())
        != Some("1.0")
        || document
            .pointer("/base_prefix")
            .and_then(|value| value.as_str())
            != Some("/usr/local")
        || document
            .pointer("/platform")
            .and_then(|value| value.as_str())
            != Some("wasi-wasm32")
        || document
            .pointer("/language/version_info/micro")
            .and_then(|value| value.as_u64())
            != Some(6)
    {
        return Err("Python WebC contains unexpected CPython build details".into());
    }
    Ok(())
}

fn canonicalize_sysconfig(
    variables: &mut BTreeMap<String, serde_json::Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    require_sysconfig_value(variables, "MODULE__SOCKET_STATE", "n/a")?;
    for name in ["MODBUILT_NAMES", "MODOBJS"] {
        let value = variables
            .get(name)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("CPython sysconfig field '{name}' must be a string"))?;
        if value
            .split_ascii_whitespace()
            .any(|entry| entry == "_socket" || entry.ends_with("/socketmodule.o"))
        {
            return Err(format!("CPython sysconfig field '{name}' still includes _socket").into());
        }
    }

    let canonical_host_runner = format!(
        "/usr/bin/wasmer run --mapdir /:{CANONICAL_SOURCE_ROOT} \
         --env PYTHONPATH=/cross-build/wasm32-wasip1/build/lib.wasi-wasm32-3.14"
    );
    let canonical_build_command = format!(
        "_PYTHON_HOSTRUNNER='{canonical_host_runner}' \
         _PYTHON_PROJECT_BASE={CANONICAL_BUILD_ROOT} \
         _PYTHON_HOST_PLATFORM=$(_PYTHON_HOST_PLATFORM) PYTHONPATH=../../Lib \
         _PYTHON_SYSCONFIGDATA_NAME=_sysconfigdata__wasi_wasm32-wasi \
         _PYTHON_SYSCONFIGDATA_PATH=$(shell test -f pybuilddir.txt && echo \
         {CANONICAL_BUILD_ROOT}/`cat pybuilddir.txt`) {CANONICAL_BUILD_PYTHON}"
    );
    let canonical_values = BTreeMap::from([
        ("abs_srcdir", CANONICAL_SOURCE_ROOT.to_string()),
        ("abs_builddir", CANONICAL_BUILD_ROOT.to_string()),
        ("CC", format!("{CANONICAL_WASI_SDK_ROOT}/bin/clang")),
        ("CXX", format!("{CANONICAL_WASI_SDK_ROOT}/bin/clang++")),
        ("AR", format!("{CANONICAL_WASI_SDK_ROOT}/bin/llvm-ar")),
        ("INSTALL", "/usr/bin/install -c".to_string()),
        ("MKDIR_P", "/bin/mkdir -p".to_string()),
        (
            "CONFIG_ARGS",
            format!(
                "'--host=wasm32-wasip1' '--build=aarch64-apple-darwin' \
                 '--with-build-python={CANONICAL_BUILD_PYTHON}' '--without-ensurepip' \
                 '--disable-test-modules' 'build_alias=aarch64-apple-darwin' \
                 'host_alias=wasm32-wasip1' 'PKG_CONFIG_PATH=' \
                 'PKG_CONFIG_LIBDIR={CANONICAL_WASI_SDK_ROOT}/share/wasi-sysroot/lib/pkgconfig:\
                 {CANONICAL_WASI_SDK_ROOT}/share/wasi-sysroot/share/pkgconfig' \
                 'CC={CANONICAL_WASI_SDK_ROOT}/bin/clang' \
                 'CPP={CANONICAL_WASI_SDK_ROOT}/bin/clang-cpp'"
            ),
        ),
        ("HOSTRUNNER", canonical_host_runner),
        ("PYTHON_FOR_FREEZE", CANONICAL_BUILD_PYTHON.to_string()),
        ("BUILD_GNU_TYPE", "aarch64-apple-darwin".to_string()),
        (
            "LLVM_PROF_MERGER",
            format!(
                "{CANONICAL_WASI_SDK_ROOT}/bin/llvm-profdata merge \
                 -output=\"$(shell pwd)/code.profclangd\" \"$(shell pwd)\"/*.profclangr"
            ),
        ),
        ("INSTALL_PROGRAM", "/usr/bin/install -c".to_string()),
        ("INSTALL_SCRIPT", "/usr/bin/install -c".to_string()),
        ("INSTALL_DATA", "/usr/bin/install -c -m 644".to_string()),
        ("INSTALL_SHARED", "/usr/bin/install -c -m 755".to_string()),
        (
            "COVERAGE_INFO",
            format!("{CANONICAL_BUILD_ROOT}/coverage.info"),
        ),
        (
            "COVERAGE_REPORT",
            format!("{CANONICAL_BUILD_ROOT}/lcov-report"),
        ),
        ("LINKCC", format!("{CANONICAL_WASI_SDK_ROOT}/bin/clang")),
        (
            "LDSHARED",
            format!("{CANONICAL_WASI_SDK_ROOT}/bin/clang -shared"),
        ),
        (
            "LDCXXSHARED",
            format!("{CANONICAL_WASI_SDK_ROOT}/bin/clang++ -shared"),
        ),
        (
            "FREEZE_MODULE_BOOTSTRAP",
            format!("{CANONICAL_BUILD_PYTHON} ../../Programs/_freeze_module.py"),
        ),
        (
            "FREEZE_MODULE",
            format!("{CANONICAL_BUILD_PYTHON} ../../Programs/_freeze_module.py"),
        ),
        (
            "BLDSHARED",
            format!("{CANONICAL_WASI_SDK_ROOT}/bin/clang -shared"),
        ),
        ("PYTHON_FOR_BUILD", canonical_build_command.clone()),
        ("TESTPYTHON", canonical_build_command.clone()),
        ("TESTRUNNER", format!("{canonical_build_command} -m test")),
    ]);

    for (name, value) in canonical_values {
        let slot = variables
            .get_mut(name)
            .ok_or_else(|| format!("CPython sysconfig is missing canonical field '{name}'"))?;
        if !slot.is_string() {
            return Err(format!("CPython sysconfig field '{name}' must be a string").into());
        }
        *slot = serde_json::Value::String(value);
    }

    for (name, value) in variables.iter() {
        if !value.is_string() && !value.is_number() {
            return Err(
                format!("CPython sysconfig field '{name}' has unsupported JSON type").into(),
            );
        }
        let Some(value) = value.as_str() else {
            continue;
        };
        for forbidden in [
            "/private/",
            "/tmp/",
            "/var/folders/",
            "/Users/",
            "/opt/homebrew/",
            "wasi-sdk-24.0-arm64-macos",
            "apple-darwin25",
        ] {
            if value.contains(forbidden) {
                return Err(format!(
                    "CPython sysconfig field '{name}' retains host-specific value '{forbidden}'"
                )
                .into());
            }
        }
    }
    Ok(())
}

fn require_sysconfig_value(
    variables: &BTreeMap<String, serde_json::Value>,
    name: &str,
    expected: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let actual = variables.get(name).and_then(serde_json::Value::as_str);
    if actual != Some(expected) {
        return Err(format!(
            "CPython sysconfig field '{name}' must be '{expected}', received {actual:?}"
        )
        .into());
    }
    Ok(())
}

fn copy_regular_file(source: &Path, destination: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if !source.is_file() || source.symlink_metadata()?.file_type().is_symlink() {
        return Err(format!("expected regular file '{}'", source.display()).into());
    }
    copy_bytes(&fs::read(source)?, destination)
}

fn read_pinned_license(
    root: &Path,
    name: &str,
    expected_sha256: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let path = root.join(name);
    let contents = fs::read(&path)?;
    let actual = sha256(&contents);
    if actual != expected_sha256 {
        return Err(format!(
            "license '{}' has digest {actual}; expected {expected_sha256}",
            path.display()
        )
        .into());
    }
    Ok(contents)
}

fn normalized_leading_c_comment(source: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let source = std::str::from_utf8(source)?;
    let comment = source
        .strip_prefix("/*")
        .and_then(|value| value.split_once("*/").map(|(comment, _)| comment))
        .ok_or("third-party source has no leading C license comment")?;
    let mut normalized = comment
        .lines()
        .map(|line| {
            let line = line.strip_prefix(' ').unwrap_or(line);
            let line = line.strip_prefix('*').unwrap_or(line);
            line.strip_prefix(' ').unwrap_or(line).trim_end()
        })
        .collect::<Vec<_>>();
    while normalized.first().is_some_and(|line| line.is_empty()) {
        normalized.remove(0);
    }
    while normalized.last().is_some_and(|line| line.is_empty()) {
        normalized.pop();
    }
    Ok(format!("{}\n", normalized.join("\n")).into_bytes())
}

fn copy_bytes(bytes: &[u8], destination: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
        set_directory_mode(parent)?;
    }
    fs::write(destination, bytes)?;
    set_file_mode(destination)?;
    Ok(())
}

fn build_package(python: &[u8], volume_root: &Path) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let digest: [u8; 32] = Sha256::digest(python).into();
    let mut manifest = Manifest::default();
    manifest.atoms.insert(
        ATOM_NAME.to_string(),
        Atom {
            kind: Url::parse("https://webc.org/kind/wasm")?,
            signature: AtomSignature::Sha256(digest).to_string(),
            annotations: IndexMap::new(),
        },
    );
    manifest.package.insert(
        FileSystemMappings::KEY.to_string(),
        Value::serialized(&FileSystemMappings(vec![FileSystemMapping {
            from: None,
            volume_name: VOLUME_NAME.to_string(),
            host_path: None,
            mount_path: MOUNT_PATH.to_string(),
        }]))?,
    );
    let mut annotations = IndexMap::new();
    annotations.insert(
        AtomAnnotation::KEY.to_string(),
        Value::serialized(&AtomAnnotation::new(ATOM_NAME, None))?,
    );
    let mut wasi = Wasi::new(ATOM_NAME);
    wasi.exec_name = Some(ATOM_NAME.to_string());
    annotations.insert(Wasi::KEY.to_string(), Value::serialized(&wasi)?);
    manifest.commands.insert(
        ATOM_NAME.to_string(),
        Command {
            runner: WASI_RUNNER_URI.to_string(),
            annotations,
        },
    );
    manifest.entrypoint = Some(ATOM_NAME.to_string());

    let atoms = BTreeMap::from([(
        ATOM_NAME.parse()?,
        FileEntry::borrowed(python, Timestamps::default()),
    )]);
    let volume = Directory::from_path(volume_root)?;
    let mut writer = Writer::new(ChecksumAlgorithm::Sha256)
        .write_manifest(&manifest)?
        .write_atoms(atoms)?;
    writer.write_volume(VOLUME_NAME, volume)?;
    Ok(writer.finish(SignatureAlgorithm::None)?.to_vec())
}

fn validate_imports(python: &[u8]) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let module = ModuleConfig::new().parse(python)?;
    let imports = module
        .imports
        .iter()
        .map(|import| format!("{}.{}", import.module, import.name))
        .collect::<BTreeSet<_>>();
    let expected = EXPECTED_IMPORTS
        .iter()
        .map(|value| value.to_string())
        .collect::<BTreeSet<_>>();
    if imports != expected {
        let missing = expected.difference(&imports).cloned().collect::<Vec<_>>();
        let unexpected = imports.difference(&expected).cloned().collect::<Vec<_>>();
        return Err(format!(
            "CPython WASI imports differ from the canonical set; missing: {missing:?}; unexpected: {unexpected:?}"
        ).into());
    }
    Ok(imports.into_iter().collect())
}

fn normalize_timestamps(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if path.is_dir() {
        let mut entries = fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            normalize_timestamps(&entry.path())?;
        }
        set_directory_mode(path)?;
    } else {
        set_file_mode(path)?;
    }
    set_file_mtime(path, FileTime::from_unix_time(0, 0))?;
    Ok(())
}

fn write_gzip(path: &Path, contents: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    let file = File::create(path)?;
    let mut encoder = GzBuilder::new()
        .mtime(0)
        .write(BufWriter::new(file), Compression::best());
    encoder.write_all(contents)?;
    encoder.finish()?.flush()?;
    Ok(())
}

fn validate_wasm(bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    if bytes.len() < 8 || &bytes[..8] != b"\0asm\x01\0\0\0" {
        return Err("python is not a WebAssembly 1 binary".into());
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<(), Box<dyn std::error::Error>> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("CPython pybuilddir.txt contains an unsafe path".into());
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<&str, Box<dyn std::error::Error>> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("SHA-256 must contain exactly 64 hexadecimal characters".into());
    }
    Ok(value)
}

fn sha256(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

#[cfg(unix)]
fn set_file_mode(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o644))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_file_mode(_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

#[cfg(unix)]
fn set_directory_mode(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_directory_mode(_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}
