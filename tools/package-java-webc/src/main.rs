use flate2::{Compression, GzBuilder};
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;
use url::Url;
use walrus::ModuleConfig;
use webc::metadata::annotations::{Atom as AtomAnnotation, WASI_RUNNER_URI, Wasi};
use webc::metadata::{Atom, AtomSignature, Command, Manifest};
use webc::v3::write::{FileEntry, Writer};
use webc::v3::{ChecksumAlgorithm, SignatureAlgorithm, Timestamps};

const ATOM_NAME: &str = "java-compiler";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.len() == 3 && arguments[1] == "--verify" {
        return verify_package(Path::new(&arguments[2]));
    }
    if arguments.len() != 3 {
        return Err("usage: package-java-webc COMPILER_WASM OUTPUT_DIRECTORY\n       package-java-webc --verify PACKAGE.webc".into());
    }
    let compiler_path = Path::new(&arguments[1]);
    let output = Path::new(&arguments[2]);
    let compiler = fs::read(compiler_path)?;
    ModuleConfig::new().parse(&compiler)?;

    let mut manifest = Manifest::default();
    let digest: [u8; 32] = Sha256::digest(&compiler).into();
    manifest.atoms.insert(
        ATOM_NAME.to_string(),
        Atom {
            kind: Url::parse("https://webc.org/kind/wasm")?,
            signature: AtomSignature::Sha256(digest).to_string(),
            annotations: IndexMap::new(),
        },
    );
    let mut annotations = IndexMap::new();
    annotations.insert(
        AtomAnnotation::KEY.to_string(),
        ciborium::value::Value::serialized(&AtomAnnotation::new(ATOM_NAME, None))?,
    );
    let mut wasi = Wasi::new(ATOM_NAME);
    wasi.exec_name = Some(ATOM_NAME.to_string());
    annotations.insert(Wasi::KEY.to_string(), ciborium::value::Value::serialized(&wasi)?);
    manifest.commands.insert(
        ATOM_NAME.to_string(),
        Command { runner: WASI_RUNNER_URI.to_string(), annotations },
    );
    manifest.entrypoint = Some(ATOM_NAME.to_string());

    let atoms = BTreeMap::from([(
        ATOM_NAME.parse()?,
        FileEntry::borrowed(&compiler, Timestamps::default()),
    )]);
    let package = Writer::new(ChecksumAlgorithm::Sha256)
        .write_manifest(&manifest)?
        .write_atoms(atoms)?
        .finish(SignatureAlgorithm::None)?
        .to_vec();

    fs::create_dir_all(output)?;
    let package_path = output.join("java-teavm-0.13.1.wasi.compiler.webc");
    let compressed_path = output.join("java-teavm-0.13.1.wasi.compiler.webc.gz.bin");
    fs::write(&package_path, &package)?;
    let file = File::create(&compressed_path)?;
    let mut encoder = GzBuilder::new()
        .mtime(0)
        .write(BufWriter::new(file), Compression::best());
    encoder.write_all(&package)?;
    encoder.finish()?.flush()?;
    println!(
        "{}",
        serde_json::json!({
            "packageSha256": format!("{:x}", Sha256::digest(&package)),
            "compressedSha256": format!("{:x}", Sha256::digest(fs::read(&compressed_path)?)),
            "packageBytes": package.len(),
        })
    );
    Ok(())
}

fn verify_package(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let reader = webc::v3::read::OwnedReader::from_path(path)?;
    let manifest = reader.manifest();
    if manifest.entrypoint.as_deref() != Some(ATOM_NAME)
        || !manifest.use_map.is_empty()
        || !manifest.bindings.is_empty()
        || manifest.atoms.len() != 1
        || manifest.commands.len() != 1
        || reader.atom_names().collect::<Vec<_>>() != [ATOM_NAME]
        || reader.volume_names().next().is_some()
    {
        return Err("Java compiler WebC has a non-canonical manifest".into());
    }
    let command = manifest
        .commands
        .get(ATOM_NAME)
        .ok_or("Java compiler WebC command is missing")?;
    if command.runner != WASI_RUNNER_URI {
        return Err("Java compiler WebC command is not WASI".into());
    }
    let (_, bytes) = reader
        .get_atom(ATOM_NAME)
        .ok_or("Java compiler WebC atom is missing")?;
    let module = ModuleConfig::new().parse(bytes.as_slice())?;
    if module
        .imports
        .iter()
        .any(|import| import.module != "wasi_snapshot_preview1")
    {
        return Err("Java compiler WebC contains a non-WASI import".into());
    }
    println!("verified canonical Java compiler WebC: {}", path.display());
    Ok(())
}
