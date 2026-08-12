use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, Read};
use std::path::PathBuf;
use wasm_oj_runtime_core::{
    CompileRequest, CompileResponse, CompilerToolchain, CompilerToolchainConfig,
    ExecutionTermination, RunFailure, WASM_OJ_COMPILE_BATCH_SCHEMA,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CliCompileBatch {
    schema: String,
    /// Path to the compiler WebC package on the host filesystem.
    package_path: Option<String>,
    /// Inline base64 alternative for small packages.
    package_base64: Option<String>,
    memory_limit_bytes: u64,
    /// Path to a bounded WOJGO002 immutable shared-file archive.
    shared_files_archive_path: Option<String>,
    shared_files_base64: Option<BTreeMap<String, String>>,
    requests: Vec<CliCompileRequest>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CliCompileRequest {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    stdin_base64: String,
    #[serde(default)]
    files_base64: BTreeMap<String, String>,
    cwd: Option<String>,
    #[serde(default)]
    output_paths: Vec<String>,
    output_limit_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliCompileResult {
    code: i32,
    stdout_base64: String,
    stderr_base64: String,
    output_files_base64: BTreeMap<String, String>,
    termination: ExecutionTermination,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliCompileResponse {
    ok: bool,
    result: Option<CliCompileResult>,
    error: Option<RunFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliCompileBatchResponse {
    ok: bool,
    responses: Vec<CliCompileResponse>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GoArchiveEntry {
    import_path: String,
    archive_path: String,
    sha256: String,
    offset: u64,
    length: u64,
}

const MAX_SHARED_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_SHARED_ARCHIVE_INDEX_BYTES: usize = 4 * 1024 * 1024;
const MAX_SHARED_ARCHIVE_ENTRIES: usize = 4_096;

fn main() {
    match execute() {
        Ok(true) => {}
        Ok(false) => std::process::exit(1),
        Err(error) => {
            eprintln!("wasm-oj-compiler: {error}");
            std::process::exit(2);
        }
    }
}

fn execute() -> Result<bool, String> {
    let input = read_input()?;
    let batch: CliCompileBatch =
        serde_json::from_slice(&input).map_err(|error| format!("invalid request JSON: {error}"))?;
    if batch.schema != WASM_OJ_COMPILE_BATCH_SCHEMA {
        return Err(format!(
            "unsupported request schema '{}'; expected '{WASM_OJ_COMPILE_BATCH_SCHEMA}'",
            batch.schema
        ));
    }
    let package = match (&batch.package_path, &batch.package_base64) {
        (Some(path), None) => std::fs::read(path)
            .map_err(|error| format!("failed to read compiler package '{path}': {error}"))?,
        (None, Some(encoded)) => STANDARD
            .decode(encoded)
            .map_err(|error| format!("invalid packageBase64: {error}"))?,
        _ => return Err("exactly one of packagePath or packageBase64 is required".to_string()),
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()
        .map_err(|error| format!("failed to initialize Tokio: {error}"))?;
    let _guard = runtime.enter();
    let toolchain = CompilerToolchain::new(CompilerToolchainConfig {
        package,
        memory_limit_bytes: batch.memory_limit_bytes,
    })
    .map_err(|error| format!("failed to load compiler toolchain: {error}"))?;

    let requests = batch
        .requests
        .into_iter()
        .map(decode_request)
        .collect::<Result<Vec<_>, _>>()?;
    let (ok, responses) =
        if batch.shared_files_archive_path.is_some() || batch.shared_files_base64.is_some() {
            let mut files = match batch.shared_files_archive_path {
                Some(path) => decode_shared_archive(&path)?,
                None => BTreeMap::new(),
            };
            for (path, bytes) in decode_files(batch.shared_files_base64.unwrap_or_default())? {
                if files.insert(path.clone(), bytes).is_some() {
                    return Err(format!(
                        "shared file '{path}' is declared by both archive and inline input"
                    ));
                }
            }
            match runtime.block_on(toolchain.compile_pipeline(files, requests)) {
                Ok(result) => {
                    let ok = result.stages.iter().all(|stage| stage.code == 0);
                    let responses = result
                        .stages
                        .into_iter()
                        .map(|result| encode_response(RunResponseLike::success(result)))
                        .collect();
                    (ok, responses)
                }
                Err(error) => (
                    false,
                    vec![encode_response(RunResponseLike::failure(error))],
                ),
            }
        } else {
            let mut responses = Vec::with_capacity(requests.len());
            let mut ok = true;
            for request in requests {
                let response = runtime.block_on(toolchain.compile_response(request));
                ok = ok && response.ok;
                responses.push(encode_response(response));
            }
            (ok, responses)
        };
    let batch_response = CliCompileBatchResponse { ok, responses };
    serde_json::to_writer(io::stdout().lock(), &batch_response)
        .map_err(|error| format!("failed to serialize response: {error}"))?;
    Ok(batch_response.ok)
}

fn decode_shared_archive(path: &str) -> Result<BTreeMap<String, serde_bytes::ByteBuf>, String> {
    let mut archive = std::fs::File::open(path)
        .map_err(|error| format!("failed to open shared file archive '{path}': {error}"))?;
    let metadata = archive
        .metadata()
        .map_err(|error| format!("failed to inspect shared file archive '{path}': {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_SHARED_ARCHIVE_BYTES {
        return Err(format!(
            "shared file archive must be a regular file no larger than {MAX_SHARED_ARCHIVE_BYTES} bytes"
        ));
    }
    let mut header = [0_u8; 12];
    archive
        .read_exact(&mut header)
        .map_err(|error| format!("failed to read shared file archive header '{path}': {error}"))?;
    if &header[..8] != b"WOJGO002" {
        return Err("shared file archive has an invalid WOJGO002 header".to_string());
    }
    let index_length = u32::from_le_bytes(
        header[8..12]
            .try_into()
            .map_err(|_| "shared file archive has a truncated index length".to_string())?,
    ) as usize;
    if index_length == 0 || index_length > MAX_SHARED_ARCHIVE_INDEX_BYTES {
        return Err("shared file archive index exceeds its size boundary".to_string());
    }
    let data_offset = 12_usize
        .checked_add(index_length)
        .ok_or_else(|| "shared file archive index length overflows".to_string())?;
    if u64::try_from(data_offset).map_err(|_| "shared archive index exceeds host range")?
        > metadata.len()
    {
        return Err("shared file archive index exceeds the file boundary".to_string());
    }
    let mut index = vec![0_u8; index_length];
    archive
        .read_exact(&mut index)
        .map_err(|error| format!("failed to read shared file archive index '{path}': {error}"))?;
    let entries: Vec<GoArchiveEntry> = serde_json::from_slice(&index)
        .map_err(|error| format!("shared file archive has an invalid index: {error}"))?;
    if entries.is_empty() || entries.len() > MAX_SHARED_ARCHIVE_ENTRIES {
        return Err("shared file archive entry count exceeds its boundary".to_string());
    }
    let mut files = BTreeMap::new();
    let mut expected_offset = 0_u64;
    for entry in entries {
        if entry.offset != expected_offset
            || entry.length <= 8
            || entry.sha256.len() != 64
            || !entry
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || entry.archive_path != format!("/go/pkg/{}.a", entry.import_path)
        {
            return Err("shared file archive contains a non-canonical entry".to_string());
        }
        let end = u64::try_from(data_offset)
            .map_err(|_| "shared archive index exceeds host range")?
            .checked_add(entry.offset)
            .and_then(|offset| offset.checked_add(entry.length))
            .ok_or_else(|| "shared file archive entry boundary overflows".to_string())?;
        if end > metadata.len() {
            return Err("shared file archive entry exceeds the file boundary".to_string());
        }
        let length =
            usize::try_from(entry.length).map_err(|_| "shared file length exceeds host range")?;
        let mut bytes = vec![0_u8; length];
        archive.read_exact(&mut bytes).map_err(|error| {
            format!(
                "failed to read shared archive entry '{}': {error}",
                entry.archive_path
            )
        })?;
        if files
            .insert(entry.archive_path, serde_bytes::ByteBuf::from(bytes))
            .is_some()
        {
            return Err("shared file archive contains a duplicate guest path".to_string());
        }
        expected_offset = expected_offset
            .checked_add(entry.length)
            .ok_or_else(|| "shared file archive lengths overflow".to_string())?;
    }
    let covered_end = u64::try_from(data_offset)
        .map_err(|_| "shared archive index exceeds host range")?
        .checked_add(expected_offset)
        .ok_or_else(|| "shared archive size overflows".to_string())?;
    if covered_end != metadata.len() {
        return Err("shared file archive contains trailing or missing bytes".to_string());
    }
    Ok(files)
}

fn decode_request(encoded: CliCompileRequest) -> Result<CompileRequest, String> {
    let files = decode_files(encoded.files_base64)?;
    Ok(CompileRequest {
        command: encoded.command,
        args: encoded.args,
        env: encoded.env,
        stdin: STANDARD
            .decode(encoded.stdin_base64)
            .map_err(|error| format!("invalid stdinBase64: {error}"))?,
        files,
        cwd: encoded.cwd,
        output_paths: encoded.output_paths,
        output_limit_bytes: encoded.output_limit_bytes,
    })
}

fn decode_files(
    encoded: BTreeMap<String, String>,
) -> Result<BTreeMap<String, serde_bytes::ByteBuf>, String> {
    encoded
        .into_iter()
        .map(|(path, contents)| {
            let bytes = STANDARD
                .decode(contents)
                .map_err(|error| format!("invalid base64 for guest file '{path}': {error}"))?;
            Ok((path, serde_bytes::ByteBuf::from(bytes)))
        })
        .collect()
}

struct RunResponseLike;

impl RunResponseLike {
    fn success(result: wasm_oj_runtime_core::CompileResult) -> CompileResponse {
        CompileResponse {
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn failure(error: wasm_oj_runtime_core::RunError) -> CompileResponse {
        CompileResponse {
            ok: false,
            result: None,
            error: Some(RunFailure {
                code: error.code(),
                message: error.to_string(),
            }),
        }
    }
}

fn encode_response(response: CompileResponse) -> CliCompileResponse {
    CliCompileResponse {
        ok: response.ok,
        result: response.result.map(|result| CliCompileResult {
            code: result.code,
            stdout_base64: STANDARD.encode(result.stdout),
            stderr_base64: STANDARD.encode(result.stderr),
            output_files_base64: result
                .output_files
                .into_iter()
                .map(|(path, bytes)| (path, STANDARD.encode(bytes)))
                .collect(),
            termination: result.termination,
        }),
        error: response.error,
    }
}

fn read_input() -> Result<Vec<u8>, String> {
    let mut arguments = std::env::args_os();
    let _program = arguments.next();
    let first = arguments.next();
    let second = arguments.next();
    let trailing = arguments.next();
    match (first, second, trailing) {
        (None, None, None) => {
            let mut input = Vec::new();
            io::stdin()
                .lock()
                .read_to_end(&mut input)
                .map_err(|error| format!("failed to read stdin: {error}"))?;
            Ok(input)
        }
        (Some(flag), Some(path), None) if flag == "--request" => {
            let path = PathBuf::from(path);
            std::fs::read(&path)
                .map_err(|error| format!("failed to read {}: {error}", path.display()))
        }
        _ => Err("usage: wasm-oj-compiler [--request REQUEST.json]".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::decode_shared_archive;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ARCHIVE_ID: AtomicU64 = AtomicU64::new(0);

    fn archive_with_magic(magic: &[u8; 8]) -> (std::path::PathBuf, &'static [u8]) {
        let payload = b"!<arch>\n!";
        let index = serde_json::to_vec(&serde_json::json!([{
            "importPath": "fmt",
            "archivePath": "/go/pkg/fmt.a",
            "sha256": "a".repeat(64),
            "offset": 0,
            "length": payload.len(),
        }]))
        .unwrap();
        let mut archive = Vec::with_capacity(12 + index.len() + payload.len());
        archive.extend_from_slice(magic);
        archive.extend_from_slice(&(u32::try_from(index.len()).unwrap()).to_le_bytes());
        archive.extend_from_slice(&index);
        archive.extend_from_slice(payload);
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "wasm-oj-go-archive-test-{}-{nonce}-{}.bin",
            std::process::id(),
            NEXT_ARCHIVE_ID.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::write(&path, archive).unwrap();
        (path, payload)
    }

    #[test]
    fn decodes_bounded_go_archive_without_base64_transport() {
        let (path, payload) = archive_with_magic(b"WOJGO002");

        let files = decode_shared_archive(path.to_str().unwrap()).unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(files["/go/pkg/fmt.a"].as_ref(), payload);
    }

    #[test]
    fn rejects_the_retired_go_archive_magic() {
        let retired_magic: [u8; 8] = [b"FORG".as_slice(), b"EGO1".as_slice()]
            .concat()
            .try_into()
            .unwrap();
        let (path, _) = archive_with_magic(&retired_magic);
        let error = decode_shared_archive(path.to_str().unwrap()).unwrap_err();
        std::fs::remove_file(path).unwrap();
        assert!(error.contains("invalid WOJGO002 header"), "{error}");
    }
}
