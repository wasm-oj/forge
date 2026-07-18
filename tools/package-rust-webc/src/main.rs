use ciborium::value::Value;
use filetime::{FileTime, set_file_mtime};
use flate2::{Compression, GzBuilder};
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Component, Path};
use url::Url;
use walrus::ModuleConfig;
use walrus::ir::{MemArg, StoreKind};
use webc::metadata::annotations::{
    Atom as AtomAnnotation, FileSystemMapping, FileSystemMappings, WASI_RUNNER_URI, Wasi,
};
use webc::metadata::{Atom, AtomSignature, Command, Manifest};
use webc::v3::write::{Directory, FileEntry, Writer};
use webc::v3::{ChecksumAlgorithm, SignatureAlgorithm, Timestamps};

const VERSION: &str = "1.91.1-dev";
const TARGET: &str = "wasm32-wasip1-threads";
const RUSTC_ATOM_NAME: &str = "rustc";
const LINKER_ATOM_NAME: &str = "llvm";
const RUST_VOLUME_NAME: &str = "rust";
const LINKER_VOLUME_NAME: &str = "usr";
const SOURCE_REVISION: &str = "ae62cab6adf0665377d19ffa39daeaf758290431";
const LINKER_VERSION: &str = "22.0.0-git20542-10";
const LINKER_SOURCE_SHA256: &str =
    "6230ea1afa9691fa065935cf68c01642ff9b31c183fe8ac64cdfda025df06009";
const LINK_OBJECT_PLACEHOLDER: &str = "__FORGE_RUST_OBJECT__";
const LINK_ALLOCATOR_PLACEHOLDER: &str = "__FORGE_RUST_ALLOCATOR_BITCODE__";
const LINK_OUTPUT_PLACEHOLDER: &str = "__FORGE_RUST_OUTPUT__";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.len() == 3 && arguments[1] == "--verify" {
        return verify_package(Path::new(&arguments[2]));
    }
    if arguments.len() != 6 {
        return Err(
            "usage: package-rust-webc RUST_ROOT LINKER_CORE_WASM LINKER_RESOURCES_TAR OUTPUT_DIRECTORY SOURCE_ARCHIVE_SHA256\n       package-rust-webc --verify PACKAGE.webc"
                .into(),
        );
    }
    let rust_root = Path::new(&arguments[1]);
    let linker_core_path = Path::new(&arguments[2]);
    let linker_resources_path = Path::new(&arguments[3]);
    let output = Path::new(&arguments[4]);
    let source_archive_sha256 = validate_sha256(&arguments[5])?;
    let rustc_path = rust_root.join("bin/rustc");
    let library_root = rust_root.join("lib");
    let source_rustc = fs::read(&rustc_path)?;
    validate_wasm(&source_rustc)?;
    let rustc = instrument_deterministic_host_inputs(&source_rustc)?;
    validate_wasm(&rustc)?;
    let linker = fs::read(linker_core_path)?;
    let linker_resources = fs::read(linker_resources_path)?;
    validate_wasm(&linker)?;
    if !library_root.is_dir() {
        return Err(format!("Rust sysroot is missing '{}'", library_root.display()).into());
    }

    let temporary = tempfile::tempdir()?;
    let rust_volume_root = temporary.path().join(RUST_VOLUME_NAME);
    let linker_volume_root = temporary.path().join(LINKER_VOLUME_NAME);
    copy_tree(&library_root, &rust_volume_root.join("lib"))?;
    fs::create_dir_all(&linker_volume_root)?;
    unpack_resources(&linker_resources, &linker_volume_root)?;
    normalize_timestamps(&rust_volume_root)?;
    normalize_timestamps(&linker_volume_root)?;
    let linker_arguments = linker_argument_contract(&library_root)?;

    let package = build_package(&rustc, &linker, &rust_volume_root, &linker_volume_root)?;
    fs::create_dir_all(output)?;
    let package_name = format!("rust-{VERSION}.webc");
    let package_path = output.join(&package_name);
    let compressed_path = output.join(format!("{package_name}.gz.bin"));
    fs::write(&package_path, &package)?;
    write_gzip(&compressed_path, &package)?;

    let compressed = fs::read(&compressed_path)?;
    let manifest = serde_json::json!({
        "schema": "wasm-oj-forge-v1/rust-toolchain",
        "version": VERSION,
        "target": TARGET,
        "source": {
            "repository": "https://github.com/olimpiadi-informatica/wasm-compilers",
            "revision": SOURCE_REVISION,
            "archiveSha256": source_archive_sha256,
        },
        "compiler": {
            "sourceSha256": sha256(&source_rustc),
            "sha256": sha256(&rustc),
            "command": "rustc",
            "deterministicReplacements": ["wasi_snapshot_preview1.random_get", "wasi_snapshot_preview1.clock_time_get"],
        },
        "linker": {
            "version": LINKER_VERSION,
            "source": format!("@yowasp/clang@{LINKER_VERSION}"),
            "sourceSha256": LINKER_SOURCE_SHA256,
            "coreSha256": sha256(&linker),
            "resourcesSha256": sha256(&linker_resources),
            "command": "wasm-ld",
            "arguments": linker_arguments,
        },
        "pipeline": {
            "strategy": "rustc-object-then-wasm-ld",
            "objectEmission": "rustc --emit=obj -C save-temps=yes",
            "allocatorShim": "rustc-generated LLVM bitcode",
            "linkArgsSource": "rustc --print=link-args",
        },
        "filesystemMounts": {
            "rust": "/rust",
            "linker": "/usr",
        },
        "output": {
            "path": compressed_path.file_name().and_then(|name| name.to_str()),
            "sha256": sha256(&package),
            "compressedSha256": sha256(&compressed),
            "compressedBytes": compressed.len(),
            "uncompressedBytes": package.len(),
        }
    });
    let manifest_path = output.join(format!("rust-{VERSION}.manifest.json"));
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

    if manifest.entrypoint.as_deref() != Some(RUSTC_ATOM_NAME) {
        return Err("Rust WebC entrypoint must be exactly 'rustc'".into());
    }
    if !manifest.use_map.is_empty() || !manifest.bindings.is_empty() {
        return Err("Rust WebC must not declare dependencies or bindings".into());
    }
    if manifest.atoms.len() != 2
        || !manifest.atoms.contains_key(RUSTC_ATOM_NAME)
        || !manifest.atoms.contains_key(LINKER_ATOM_NAME)
    {
        return Err("Rust WebC must contain exactly the local 'rustc' and 'llvm' atoms".into());
    }
    if reader.atom_names().collect::<Vec<_>>() != [LINKER_ATOM_NAME, RUSTC_ATOM_NAME] {
        return Err("Rust WebC atom section must contain exactly 'llvm' and 'rustc'".into());
    }
    if reader.volume_names().collect::<Vec<_>>() != [RUST_VOLUME_NAME, LINKER_VOLUME_NAME] {
        return Err("Rust WebC must contain exactly the 'rust' and 'usr' volumes".into());
    }
    if manifest.commands.len() != 2 {
        return Err("Rust WebC must expose exactly two commands".into());
    }
    let rustc_command = manifest
        .commands
        .get(RUSTC_ATOM_NAME)
        .ok_or("Rust WebC does not expose the 'rustc' command")?;
    verify_command(rustc_command, RUSTC_ATOM_NAME, "rustc")?;
    let linker_command = manifest
        .commands
        .get("wasm-ld")
        .ok_or("Rust WebC does not expose the 'wasm-ld' command")?;
    verify_command(linker_command, LINKER_ATOM_NAME, "wasm-ld")?;

    if manifest.package.len() != 1 {
        return Err("Rust WebC must contain exactly one package annotation".into());
    }
    let filesystem = manifest
        .filesystem()?
        .ok_or("Rust WebC has no filesystem mapping")?;
    let expected_mappings = [
        FileSystemMapping {
            from: None,
            volume_name: RUST_VOLUME_NAME.to_string(),
            host_path: None,
            mount_path: "/rust".to_string(),
        },
        FileSystemMapping {
            from: None,
            volume_name: LINKER_VOLUME_NAME.to_string(),
            host_path: None,
            mount_path: "/usr".to_string(),
        },
    ];
    if filesystem.as_slice() != expected_mappings {
        return Err("Rust WebC filesystem mappings must be exactly rust=/rust and usr=/usr".into());
    }

    let (_, rustc_bytes) = reader
        .get_atom(RUSTC_ATOM_NAME)
        .ok_or("Rust WebC rustc atom is missing from its atom section")?;
    validate_wasm(rustc_bytes.as_slice())?;
    let module = ModuleConfig::new().parse(rustc_bytes.as_slice())?;
    for import in module.imports.iter() {
        if import.module == "wasi_snapshot_preview1"
            && matches!(import.name.as_str(), "random_get" | "clock_time_get")
        {
            return Err(format!(
                "Rust WebC rustc atom still imports nondeterministic host function '{}.{}'",
                import.module, import.name
            )
            .into());
        }
    }
    let (_, linker_bytes) = reader
        .get_atom(LINKER_ATOM_NAME)
        .ok_or("Rust WebC llvm atom is missing from its atom section")?;
    validate_wasm(linker_bytes.as_slice())?;

    println!("verified canonical Rust WebC: {}", path.display());
    Ok(())
}

fn verify_command(
    command: &Command,
    atom_name: &str,
    exec_name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if command.runner != WASI_RUNNER_URI {
        return Err("Rust WebC rustc command must use the WASI runner".into());
    }
    if command.annotations.len() != 2
        || !command.annotations.contains_key(AtomAnnotation::KEY)
        || !command.annotations.contains_key(Wasi::KEY)
    {
        return Err("Rust WebC rustc command has non-canonical annotations".into());
    }
    let atom = command
        .annotation::<AtomAnnotation>(AtomAnnotation::KEY)?
        .ok_or("Rust WebC rustc command has no atom owner")?;
    if atom.name != atom_name || atom.dependency.is_some() {
        return Err(
            format!("Rust WebC '{exec_name}' command has the wrong local atom owner").into(),
        );
    }
    let wasi = command
        .annotation::<Wasi>(Wasi::KEY)?
        .ok_or("Rust WebC rustc command has no WASI annotation")?;
    if wasi.exec_name.as_deref() != Some(exec_name)
        || wasi.package.is_some()
        || wasi.env.is_some()
        || wasi.main_args.is_some()
        || wasi.mount_atom_in_volume.is_some()
        || wasi.cwd.is_some()
    {
        return Err(
            format!("Rust WebC '{exec_name}' command has a non-canonical WASI annotation").into(),
        );
    }
    Ok(())
}

fn instrument_deterministic_host_inputs(
    rustc: &[u8],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut module = ModuleConfig::new().parse(rustc)?;
    let memory = module
        .memories
        .iter()
        .next()
        .ok_or("rustc does not import or define a linear memory")?
        .id();

    let random_import = module
        .imports
        .get_func("wasi_snapshot_preview1", "random_get")?;
    module.replace_imported_func(random_import, |(body, arguments)| {
        body.local_get(arguments[0])
            .i32_const(0)
            .local_get(arguments[1])
            .memory_fill(memory)
            .i32_const(0);
    })?;

    let clock_import = module
        .imports
        .get_func("wasi_snapshot_preview1", "clock_time_get")?;
    module.replace_imported_func(clock_import, |(body, arguments)| {
        body.local_get(arguments[2])
            .i64_const(946_684_800_000_000_000)
            .store(
                memory,
                StoreKind::I64 { atomic: false },
                MemArg {
                    align: 8,
                    offset: 0,
                },
            )
            .i32_const(0);
    })?;

    Ok(module.emit_wasm())
}

fn build_package(
    rustc: &[u8],
    linker: &[u8],
    rust_volume_root: &Path,
    linker_volume_root: &Path,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let rustc_digest: [u8; 32] = Sha256::digest(rustc).into();
    let linker_digest: [u8; 32] = Sha256::digest(linker).into();
    let mut manifest = Manifest::default();
    manifest.atoms.insert(
        RUSTC_ATOM_NAME.to_string(),
        Atom {
            kind: Url::parse("https://webc.org/kind/wasm")?,
            signature: AtomSignature::Sha256(rustc_digest).to_string(),
            annotations: IndexMap::new(),
        },
    );
    manifest.atoms.insert(
        LINKER_ATOM_NAME.to_string(),
        Atom {
            kind: Url::parse("https://webc.org/kind/wasm")?,
            signature: AtomSignature::Sha256(linker_digest).to_string(),
            annotations: IndexMap::new(),
        },
    );
    manifest.package.insert(
        FileSystemMappings::KEY.to_string(),
        Value::serialized(&FileSystemMappings(vec![
            FileSystemMapping {
                from: None,
                volume_name: RUST_VOLUME_NAME.to_string(),
                host_path: None,
                mount_path: "/rust".to_string(),
            },
            FileSystemMapping {
                from: None,
                volume_name: LINKER_VOLUME_NAME.to_string(),
                host_path: None,
                mount_path: "/usr".to_string(),
            },
        ]))?,
    );
    add_command(&mut manifest, "rustc", RUSTC_ATOM_NAME)?;
    add_command(&mut manifest, "wasm-ld", LINKER_ATOM_NAME)?;
    manifest.entrypoint = Some("rustc".to_string());

    let atoms = BTreeMap::from([
        (
            RUSTC_ATOM_NAME.parse()?,
            FileEntry::borrowed(rustc, Timestamps::default()),
        ),
        (
            LINKER_ATOM_NAME.parse()?,
            FileEntry::borrowed(linker, Timestamps::default()),
        ),
    ]);
    let rust_volume = Directory::from_path(rust_volume_root)?;
    let linker_volume = Directory::from_path(linker_volume_root)?;
    let mut writer = Writer::new(ChecksumAlgorithm::Sha256)
        .write_manifest(&manifest)?
        .write_atoms(atoms)?;
    writer.write_volume(RUST_VOLUME_NAME, rust_volume)?;
    writer.write_volume(LINKER_VOLUME_NAME, linker_volume)?;
    Ok(writer.finish(SignatureAlgorithm::None)?.to_vec())
}

fn add_command(
    manifest: &mut Manifest,
    command_name: &str,
    atom_name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut annotations = IndexMap::new();
    annotations.insert(
        AtomAnnotation::KEY.to_string(),
        Value::serialized(&AtomAnnotation::new(atom_name, None))?,
    );
    let mut wasi = Wasi::new(atom_name);
    wasi.exec_name = Some(command_name.to_string());
    annotations.insert(Wasi::KEY.to_string(), Value::serialized(&wasi)?);
    manifest.commands.insert(
        command_name.to_string(),
        Command {
            runner: WASI_RUNNER_URI.to_string(),
            annotations,
        },
    );
    Ok(())
}

fn linker_argument_contract(
    library_root: &Path,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    Ok(serde_json::json!({
        "objectPlaceholder": LINK_OBJECT_PLACEHOLDER,
        "allocatorPlaceholder": LINK_ALLOCATOR_PLACEHOLDER,
        "outputPlaceholder": LINK_OUTPUT_PLACEHOLDER,
        "debug": linker_arguments(library_root, "-O0")?,
        "release": linker_arguments(library_root, "-O2")?,
    }))
}

fn linker_arguments(
    library_root: &Path,
    linker_optimization: &str,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let guest_library_root = format!("/rust/lib/rustlib/{TARGET}/lib");
    let self_contained = format!("{guest_library_root}/self-contained");
    let mut arguments = vec![
        "--shared-memory".to_string(),
        "--max-memory=1073741824".to_string(),
        "--import-memory".to_string(),
        "--export".to_string(),
        "__main_void".to_string(),
        "-z".to_string(),
        "stack-size=1048576".to_string(),
        "--stack-first".to_string(),
        "--allow-undefined".to_string(),
        "--no-demangle".to_string(),
        "--import-memory".to_string(),
        "--export-memory".to_string(),
        "--shared-memory".to_string(),
        "--max-memory=1073741824".to_string(),
        format!("{self_contained}/crt1-command.o"),
        LINK_OBJECT_PLACEHOLDER.to_string(),
        LINK_ALLOCATOR_PLACEHOLDER.to_string(),
    ];
    for crate_name in [
        "panic_abort",
        "std",
        "wasi",
        "cfg_if",
        "rustc_demangle",
        "std_detect",
        "hashbrown",
        "rustc_std_workspace_alloc",
        "unwind",
        "libc",
    ] {
        arguments.push(guest_rlib(library_root, crate_name)?);
    }
    arguments.extend(["-l".to_string(), "c".to_string()]);
    for crate_name in [
        "rustc_std_workspace_core",
        "alloc",
        "core",
        "compiler_builtins",
    ] {
        arguments.push(guest_rlib(library_root, crate_name)?);
    }
    arguments.extend([
        "-L".to_string(),
        self_contained,
        "-o".to_string(),
        LINK_OUTPUT_PLACEHOLDER.to_string(),
        "--gc-sections".to_string(),
        linker_optimization.to_string(),
    ]);
    Ok(arguments)
}

fn guest_rlib(library_root: &Path, crate_name: &str) -> Result<String, Box<dyn std::error::Error>> {
    let host_directory = library_root.join(format!("rustlib/{TARGET}/lib"));
    let prefix = format!("lib{crate_name}-");
    let mut matches = fs::read_dir(&host_directory)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            (entry.file_type().ok()?.is_file()
                && name.starts_with(&prefix)
                && name.ends_with(".rlib"))
            .then_some(name)
        })
        .collect::<Vec<_>>();
    matches.sort();
    if matches.len() != 1 {
        return Err(format!(
            "Rust sysroot must contain exactly one '{prefix}*.rlib'; found {}",
            matches.len()
        )
        .into());
    }
    Ok(format!("/rust/lib/rustlib/{TARGET}/lib/{}", matches[0]))
}

fn unpack_resources(bytes: &[u8], destination: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut archive = tar::Archive::new(bytes);
    for item in archive.entries()? {
        let mut entry = item?;
        let relative = entry.path()?.into_owned();
        if relative.as_os_str().is_empty()
            || relative.is_absolute()
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(format!("unsafe linker resource path '{}'", relative.display()).into());
        }
        let kind = entry.header().entry_type();
        let output = destination.join(&relative);
        if kind.is_dir() {
            fs::create_dir_all(&output)?;
        } else if kind.is_file() {
            let parent = output
                .parent()
                .ok_or("linker resource file has no parent")?;
            fs::create_dir_all(parent)?;
            entry.unpack(&output)?;
        } else {
            return Err(format!(
                "unsupported linker resource entry '{}' ({kind:?})",
                relative.display()
            )
            .into());
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(destination)?;
    let mut entries = fs::read_dir(source)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_tree(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path)?;
        } else {
            return Err(
                format!("unsupported Rust sysroot entry '{}'", source_path.display()).into(),
            );
        }
    }
    Ok(())
}

fn normalize_timestamps(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if path.is_dir() {
        let mut entries = fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            normalize_timestamps(&entry.path())?;
        }
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
        return Err("rustc is not a WebAssembly 1 binary".into());
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<&str, Box<dyn std::error::Error>> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("source archive SHA-256 must contain exactly 64 hexadecimal characters".into());
    }
    Ok(value)
}

fn sha256(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
