use ciborium::value::Value;
use filetime::{FileTime, set_file_mtime};
use flate2::{Compression, GzBuilder};
use indexmap::IndexMap;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;
use url::Url;
use walrus::ModuleConfig;
use walrus::ir::{BinaryOp, MemArg, StoreKind, Value as WasmValue};
use walrus::{ConstExpr, ValType};
use webc::metadata::annotations::{Atom as AtomAnnotation, WASI_RUNNER_URI, Wasi};
use webc::metadata::{Atom, AtomSignature, Command, Manifest};
use webc::v3::write::{FileEntry, Writer};
use webc::v3::{ChecksumAlgorithm, SignatureAlgorithm, Timestamps};

const VERSION: &str = "1.26.5";
const TARGET: &str = "wasip1/wasm";
const COMPILE_ATOM: &str = "compile";
const LINK_ATOM: &str = "link";
const ERRNO_NOSYS: i32 = 52;
const MAX_MEMORY_PAGES: u64 = 8_192;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageEntry {
    import_path: String,
    archive_path: String,
    sha256: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.len() == 3 && arguments[1] == "--verify" {
        return verify_package(Path::new(&arguments[2]));
    }
    if arguments.len() != 8 {
        return Err("usage: package-go-webc GO_VOLUME COMPILE_WASM LINK_WASM PACKAGES_JSON OUTPUT_DIRECTORY SOURCE_DISTRIBUTION_URL SOURCE_DISTRIBUTION_SHA256\n       package-go-webc --verify PACKAGE.webc".into());
    }
    let volume_root = Path::new(&arguments[1]);
    let source_compile = fs::read(&arguments[2])?;
    let source_link = fs::read(&arguments[3])?;
    validate_wasm(&source_compile, "Go compile command")?;
    validate_wasm(&source_link, "Go link command")?;
    let compile = instrument_host_inputs(&source_compile)?;
    let link = instrument_host_inputs(&source_link)?;
    let packages = read_package_entries(Path::new(&arguments[4]), volume_root)?;
    let output = Path::new(&arguments[5]);
    let source_distribution_url = validate_source_url(&arguments[6])?;
    let source_distribution_sha256 = validate_sha256(&arguments[7])?;

    normalize_timestamps(volume_root)?;
    let package = build_package(&compile, &link)?;
    let standard_library = build_standard_library(&packages, volume_root)?;
    fs::create_dir_all(output)?;
    let package_name = format!("go-{VERSION}-wasip1.webc");
    let package_path = output.join(&package_name);
    let compressed_path = output.join(format!("{package_name}.gz.bin"));
    let standard_library_path = output.join(format!("go-{VERSION}-wasip1.stdlib.gz.bin"));
    fs::write(&package_path, &package)?;
    write_gzip(&compressed_path, &package)?;
    write_gzip(&standard_library_path, &standard_library)?;
    let compressed = fs::read(&compressed_path)?;
    let compressed_standard_library = fs::read(&standard_library_path)?;
    let manifest = serde_json::json!({
        "schema": "wasm-oj-forge-v1/go-toolchain",
        "version": VERSION,
        "target": TARGET,
        "source": {
            "distributionUrl": source_distribution_url,
            "distributionSha256": source_distribution_sha256,
        },
        "compiler": {
            "command": "go-compile",
            "sourceSha256": sha256(&source_compile),
            "sha256": sha256(&compile),
        },
        "linker": {
            "command": "go-link",
            "sourceSha256": sha256(&source_link),
            "sha256": sha256(&link),
        },
        "deterministicReplacements": [
            "wasi_snapshot_preview1.random_get",
            "wasi_snapshot_preview1.clock_time_get",
            "wasi_snapshot_preview1.sock_accept",
            "wasi_snapshot_preview1.sock_shutdown",
        ],
        "filesystemMount": null,
        "packages": packages.iter().map(|entry| serde_json::json!({
            "importPath": entry.import_path,
            "archivePath": format!("/{}", entry.archive_path),
            "sha256": entry.sha256,
        })).collect::<Vec<_>>(),
        "output": {
            "path": compressed_path.file_name().and_then(|name| name.to_str()),
            "sha256": sha256(&package),
            "compressedSha256": sha256(&compressed),
            "compressedBytes": compressed.len(),
            "uncompressedBytes": package.len(),
        },
        "standardLibrary": {
            "path": standard_library_path.file_name().and_then(|name| name.to_str()),
            "sha256": sha256(&standard_library),
            "compressedSha256": sha256(&compressed_standard_library),
            "compressedBytes": compressed_standard_library.len(),
            "uncompressedBytes": standard_library.len(),
            "format": "FORGEGO1",
        }
    });
    let manifest_path = output.join(format!("go-{VERSION}-wasip1.manifest.json"));
    fs::write(
        &manifest_path,
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )?;
    println!("{}", serde_json::to_string(&manifest)?);
    Ok(())
}

fn read_package_entries(
    path: &Path,
    volume_root: &Path,
) -> Result<Vec<PackageEntry>, Box<dyn std::error::Error>> {
    let entries: Vec<PackageEntry> = serde_json::from_slice(&fs::read(path)?)?;
    if entries.is_empty() {
        return Err("Go standard-library package map must not be empty".into());
    }
    let mut previous = "";
    for entry in &entries {
        if entry.import_path.is_empty()
            || entry.import_path.as_str() <= previous
            || entry.import_path.starts_with('/')
            || entry.import_path.contains("\\")
            || entry
                .import_path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("Go package import paths must be unique, sorted, and canonical".into());
        }
        if entry.archive_path.starts_with('/')
            || entry.archive_path.contains("\\")
            || entry
                .archive_path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(format!("invalid Go archive path '{}'", entry.archive_path).into());
        }
        let bytes = fs::read(volume_root.join(&entry.archive_path))?;
        if sha256(&bytes) != validate_sha256(&entry.sha256)? {
            return Err(format!("Go archive digest mismatch for '{}'", entry.import_path).into());
        }
        previous = &entry.import_path;
    }
    Ok(entries)
}

fn instrument_host_inputs(bytes: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut module = ModuleConfig::new().parse(bytes)?;
    let memory = module
        .memories
        .iter()
        .next()
        .ok_or("Go tool has no linear memory")?
        .id();
    let memory_contract = module.memories.get_mut(memory);
    if memory_contract.initial > MAX_MEMORY_PAGES {
        return Err("Go tool initial memory exceeds the Forge compiler limit".into());
    }
    memory_contract.maximum = Some(MAX_MEMORY_PAGES);
    if let Ok(import) = module
        .imports
        .get_func("wasi_snapshot_preview1", "random_get")
    {
        module.replace_imported_func(import, |(body, arguments)| {
            body.local_get(arguments[0])
                .i32_const(0)
                .local_get(arguments[1])
                .memory_fill(memory)
                .i32_const(0);
        })?;
    }
    if let Ok(import) = module
        .imports
        .get_func("wasi_snapshot_preview1", "clock_time_get")
    {
        let logical_clock = module.globals.add_local(
            ValType::I64,
            true,
            false,
            ConstExpr::Value(WasmValue::I64(946_684_800_000_000_000)),
        );
        module.replace_imported_func(import, |(body, arguments)| {
            body.local_get(arguments[2])
                .global_get(logical_clock)
                .store(
                    memory,
                    StoreKind::I64 { atomic: false },
                    MemArg {
                        align: 8,
                        offset: 0,
                    },
                )
                .global_get(logical_clock)
                .i64_const(1_000_000)
                .binop(BinaryOp::I64Add)
                .global_set(logical_clock)
                .i32_const(0);
        })?;
    }
    for name in ["sock_accept", "sock_shutdown"] {
        if let Ok(import) = module.imports.get_func("wasi_snapshot_preview1", name) {
            module.replace_imported_func(import, |(body, _)| {
                body.i32_const(ERRNO_NOSYS);
            })?;
        }
    }
    Ok(module.emit_wasm())
}

fn build_package(compile: &[u8], link: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut manifest = Manifest::default();
    add_atom(&mut manifest, COMPILE_ATOM, compile)?;
    add_atom(&mut manifest, LINK_ATOM, link)?;
    add_command(&mut manifest, "go-compile", COMPILE_ATOM)?;
    add_command(&mut manifest, "go-link", LINK_ATOM)?;
    manifest.entrypoint = Some("go-compile".to_string());
    let atoms = BTreeMap::from([
        (
            COMPILE_ATOM.parse()?,
            FileEntry::borrowed(compile, Timestamps::default()),
        ),
        (
            LINK_ATOM.parse()?,
            FileEntry::borrowed(link, Timestamps::default()),
        ),
    ]);
    let writer = Writer::new(ChecksumAlgorithm::Sha256)
        .write_manifest(&manifest)?
        .write_atoms(atoms)?;
    Ok(writer.finish(SignatureAlgorithm::None)?.to_vec())
}

fn build_standard_library(
    packages: &[PackageEntry],
    volume_root: &Path,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut contents = Vec::new();
    let mut index = Vec::with_capacity(packages.len());
    for package in packages {
        let archive = fs::read(volume_root.join(&package.archive_path))?;
        let offset = contents.len();
        contents.extend_from_slice(&archive);
        index.push(serde_json::json!({
            "importPath": package.import_path,
            "archivePath": format!("/{}", package.archive_path),
            "offset": offset,
            "length": archive.len(),
            "sha256": package.sha256,
        }));
    }
    let index = serde_json::to_vec(&index)?;
    let index_length = u32::try_from(index.len())?;
    let mut archive = Vec::with_capacity(12 + index.len() + contents.len());
    archive.extend_from_slice(b"FORGEGO1");
    archive.extend_from_slice(&index_length.to_le_bytes());
    archive.extend_from_slice(&index);
    archive.extend_from_slice(&contents);
    Ok(archive)
}

fn add_atom(
    manifest: &mut Manifest,
    name: &str,
    bytes: &[u8],
) -> Result<(), Box<dyn std::error::Error>> {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    manifest.atoms.insert(
        name.to_string(),
        Atom {
            kind: Url::parse("https://webc.org/kind/wasm")?,
            signature: AtomSignature::Sha256(digest).to_string(),
            annotations: IndexMap::new(),
        },
    );
    Ok(())
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

fn verify_package(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let reader = webc::v3::read::OwnedReader::from_path(path)?;
    let manifest = reader.manifest();
    if manifest.entrypoint.as_deref() != Some("go-compile")
        || manifest.atoms.len() != 2
        || manifest.commands.len() != 2
        || !manifest.commands.contains_key("go-compile")
        || !manifest.commands.contains_key("go-link")
        || reader.volume_names().next().is_some()
    {
        return Err("Go WebC does not match its canonical package shape".into());
    }
    for atom in [COMPILE_ATOM, LINK_ATOM] {
        let (_, bytes) = reader.get_atom(atom).ok_or("Go WebC atom is missing")?;
        validate_wasm(bytes.as_slice(), atom)?;
        let module = ModuleConfig::new().parse(bytes.as_slice())?;
        for import in module.imports.iter() {
            if import.module == "wasi_snapshot_preview1"
                && matches!(
                    import.name.as_str(),
                    "random_get" | "clock_time_get" | "sock_accept" | "sock_shutdown"
                )
            {
                return Err(format!(
                    "Go WebC atom '{atom}' retains host input '{}.{}'",
                    import.module, import.name
                )
                .into());
            }
        }
    }
    println!("verified canonical Go WebC: {}", path.display());
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

fn validate_wasm(bytes: &[u8], label: &str) -> Result<(), Box<dyn std::error::Error>> {
    if bytes.len() < 8 || &bytes[..8] != b"\0asm\x01\0\0\0" {
        return Err(format!("{label} is not a WebAssembly 1 binary").into());
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<&str, Box<dyn std::error::Error>> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("SHA-256 must contain exactly 64 hexadecimal characters".into());
    }
    Ok(value)
}

fn validate_source_url(value: &str) -> Result<&str, Box<dyn std::error::Error>> {
    let url = Url::parse(value)?;
    if url.scheme() != "https"
        || url.host_str() != Some("go.dev")
        || !url.path().starts_with("/dl/")
    {
        return Err("Go distribution URL must be an official https://go.dev/dl/ URL".into());
    }
    Ok(value)
}

fn sha256(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
