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
use webc::metadata::annotations::{
    Atom as AtomAnnotation, FileSystemMapping, FileSystemMappings, WASI_RUNNER_URI, Wasi,
};
use webc::metadata::{Atom, AtomSignature, Command, Manifest};
use webc::v3::write::{Directory, FileEntry, Writer};
use webc::v3::{ChecksumAlgorithm, SignatureAlgorithm, Timestamps};

const VERSION: &str = "22.0.0-git20542-10";
const ATOM_NAME: &str = "llvm";
const VOLUME_NAME: &str = "usr";
const COMMANDS: [&str; 3] = ["clang", "clang++", "wasm-ld"];

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.len() != 5 {
        return Err(
            "usage: package-yowasp-clang CORE_WASM RESOURCES_TAR OUTPUT_DIRECTORY SOURCE_SHA256"
                .into(),
        );
    }
    let core_path = Path::new(&arguments[1]);
    let resources_path = Path::new(&arguments[2]);
    let output = Path::new(&arguments[3]);
    let source_sha256 = validate_sha256(&arguments[4])?;
    let core = fs::read(core_path)?;
    let resources = fs::read(resources_path)?;
    validate_wasm(&core)?;

    let temporary = tempfile::tempdir()?;
    let volume_root = temporary.path().join(VOLUME_NAME);
    fs::create_dir_all(&volume_root)?;
    unpack_resources(&resources, &volume_root)?;
    normalize_timestamps(&volume_root)?;

    let package = build_package(&core, &volume_root)?;
    fs::create_dir_all(output)?;
    let package_name = format!("clang-{VERSION}.webc");
    let package_path = output.join(&package_name);
    let compressed_path = output.join(format!("{package_name}.gz.bin"));
    fs::write(&package_path, &package)?;
    write_gzip(&compressed_path, &package)?;

    let compressed = fs::read(&compressed_path)?;
    let manifest = serde_json::json!({
        "schema": "wasm-oj-forge-v1/clang-toolchain",
        "version": VERSION,
        "sourceSha256": source_sha256,
        "coreSha256": sha256(&core),
        "resourcesSha256": sha256(&resources),
        "commands": COMMANDS,
        "filesystemMount": "/usr",
        "output": {
            "path": compressed_path.file_name().and_then(|name| name.to_str()),
            "sha256": sha256(&package),
            "compressedSha256": sha256(&compressed),
            "compressedBytes": compressed.len(),
            "uncompressedBytes": package.len(),
        }
    });
    let manifest_path = output.join(format!("clang-{VERSION}.manifest.json"));
    fs::write(
        &manifest_path,
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )?;
    println!("{}", serde_json::to_string(&manifest)?);
    Ok(())
}

fn build_package(core: &[u8], volume_root: &Path) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let digest: [u8; 32] = Sha256::digest(core).into();
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
            mount_path: "/usr".to_string(),
        }]))?,
    );
    for command_name in COMMANDS {
        let mut annotations = IndexMap::new();
        annotations.insert(
            AtomAnnotation::KEY.to_string(),
            Value::serialized(&AtomAnnotation::new(ATOM_NAME, None))?,
        );
        let mut wasi = Wasi::new(ATOM_NAME);
        wasi.exec_name = Some(command_name.to_string());
        annotations.insert(Wasi::KEY.to_string(), Value::serialized(&wasi)?);
        manifest.commands.insert(
            command_name.to_string(),
            Command {
                runner: WASI_RUNNER_URI.to_string(),
                annotations,
            },
        );
    }
    manifest.entrypoint = Some("clang".to_string());

    let atoms = BTreeMap::from([(
        ATOM_NAME.parse()?,
        FileEntry::borrowed(core, Timestamps::default()),
    )]);
    let volume = Directory::from_path(volume_root)?;
    let mut writer = Writer::new(ChecksumAlgorithm::Sha256)
        .write_manifest(&manifest)?
        .write_atoms(atoms)?;
    writer.write_volume(VOLUME_NAME, volume)?;
    Ok(writer.finish(SignatureAlgorithm::None)?.to_vec())
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
            return Err(format!("unsafe resource archive path '{}'", relative.display()).into());
        }
        let kind = entry.header().entry_type();
        let output = destination.join(&relative);
        if kind.is_dir() {
            fs::create_dir_all(&output)?;
        } else if kind.is_file() {
            let parent = output.parent().ok_or("resource file has no parent")?;
            fs::create_dir_all(parent)?;
            entry.unpack(&output)?;
        } else {
            return Err(format!(
                "unsupported resource archive entry '{}' ({kind:?})",
                relative.display()
            )
            .into());
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
        return Err("YoWASP Clang core is not a WebAssembly 1 binary".into());
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<&str, Box<dyn std::error::Error>> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("source SHA-256 must contain exactly 64 hexadecimal characters".into());
    }
    Ok(value)
}

fn sha256(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
