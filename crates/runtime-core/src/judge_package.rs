//! Pure static admission for immutable `WOJJDG02` judge packages.
//!
//! This module deliberately does not compile, instantiate, or execute trusted
//! judge WebAssembly. It verifies the transport and command ABI before runtime
//! code is allowed to consume the bytes.

use serde::Deserialize;
use serde::Deserializer;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;
use wasmparser::{Validator, WasmFeatures};

use crate::contract::WASM_OJ_CONTRACT_VERSION;

pub const WASM_OJ_JUDGE_PACKAGE_MAGIC: &[u8; 8] = b"WOJJDG02";
pub const WASM_OJ_JUDGE_PACKAGE_SCHEMA: &str = "wasm-oj-v2/judge-package";
pub const WASM_OJ_JUDGE_PACKAGE_MAX_BYTES: usize = 32 * 1024 * 1024;
pub const TRUSTED_JUDGE_WASM_MAX_BYTES: usize = 8 * 1024 * 1024;

const HEADER_BYTES: usize = 8 + 4 + 4;
const BLOB_HEADER_BYTES: usize = 32 + 8;
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_BLOBS: usize = 258;
const MAX_ASSETS: usize = 256;
const MAX_ASSET_BYTES: usize = 4 * 1024 * 1024;
const MAX_ASSET_TOTAL_BYTES: usize = 4 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_MEMORY_LIMIT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_LOGICAL_TIME_LIMIT_MS: u64 = MAX_SAFE_INTEGER / 1_000_000;
const MAX_WALL_TIME_LIMIT_MS: u64 = 10 * 60 * 1_000;
const WASM_PAGE_BYTES: u64 = 65_536;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("{0}")]
pub struct JudgePackageError(String);

fn invalid(message: impl Into<String>) -> JudgePackageError {
    JudgePackageError(message.into())
}

/// Publication metadata that can be checked together with the package bytes.
#[derive(Debug, Default, Clone, Copy)]
pub struct JudgePackageValidationOptions<'a> {
    pub expected_bytes: Option<usize>,
    pub expected_sha256: Option<&'a str>,
    pub memory_limit_bytes: Option<u64>,
}

/// Bounded, execution-relevant manifest projection returned after validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JudgePackageManifest {
    pub judge_kind: String,
    pub judge_data_sha256: String,
    pub judge_data_bytes: usize,
    pub allowed_languages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedJudgePackage {
    pub manifest: JudgePackageManifest,
    pub judge_data_case_count: usize,
    pub bytes: usize,
    pub execution_semantic_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedJudgeWasmInfo {
    pub bytes: usize,
    pub initial_memory_pages: u64,
    pub maximum_memory_pages: Option<u64>,
    pub imports: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestWire {
    schema: String,
    wasm_oj_contract: u32,
    judge_data: BlobReference,
    allowed_profiles: BTreeMap<String, CompileProfile>,
    judge: JudgeWire,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct BlobReference {
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetReference {
    guest_path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompileProfile {
    target: String,
    optimization: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum JudgeWire {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "checker")]
    Checker {
        #[serde(rename = "runtimeProfile")]
        runtime_profile: String,
        artifact: BlobReference,
        assets: Vec<AssetReference>,
        args: Vec<String>,
    },
    #[serde(rename = "interactive")]
    Interactive {
        #[serde(rename = "runtimeProfile")]
        runtime_profile: String,
        artifact: BlobReference,
        assets: Vec<AssetReference>,
        args: Vec<String>,
        #[serde(rename = "inputPath")]
        input_path: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct JudgeDataWire {
    schema: String,
    cases: Vec<JudgeCaseWire>,
    scoring: ScoringWire,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct JudgeCaseWire {
    id: String,
    input: String,
    output: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScoringWire {
    maximum_points: u64,
    calibration: CalibrationWire,
    policies: Vec<PolicyWire>,
    safety_limits: SafetyLimitsWire,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CalibrationWire {
    method: String,
    profiles: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyWire {
    id: String,
    points: u64,
    limits: LimitsWire,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LimitsWire {
    instruction_budget: u64,
    memory_limit_bytes: u64,
    #[serde(default, deserialize_with = "deserialize_present_u64")]
    logical_time_limit_ms: Option<u64>,
}

fn deserialize_present_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    u64::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SafetyLimitsWire {
    wall_time_limit_ms: u64,
}

#[derive(Debug)]
struct CheckedJudgeData {
    case_count: usize,
    maximum_memory_bytes: u64,
}

#[derive(Debug)]
struct CheckedManifest {
    wire: ManifestWire,
    references: BTreeMap<[u8; 32], usize>,
    ordered_digests: Vec<[u8; 32]>,
    artifact_digest: Option<[u8; 32]>,
}

pub fn validate_judge_package(bytes: &[u8]) -> Result<ValidatedJudgePackage, JudgePackageError> {
    validate_judge_package_with_options(bytes, JudgePackageValidationOptions::default())
}

/// Validate exact `WOJJDG02` bytes without invoking any guest code.
pub fn validate_judge_package_with_options(
    bytes: &[u8],
    options: JudgePackageValidationOptions<'_>,
) -> Result<ValidatedJudgePackage, JudgePackageError> {
    if bytes.len() < HEADER_BYTES || bytes.len() > WASM_OJ_JUDGE_PACKAGE_MAX_BYTES {
        return Err(invalid(
            "judge package bytes are outside the 32 MiB transport limit",
        ));
    }
    if let Some(expected) = options.expected_bytes
        && (expected == 0 || expected > WASM_OJ_JUDGE_PACKAGE_MAX_BYTES)
    {
        return Err(invalid("expected judge package byte length is invalid"));
    }
    let expected_digest = options
        .expected_sha256
        .map(parse_digest)
        .transpose()
        .map_err(|_| invalid("expected judge package digest must be lowercase SHA-256"))?;

    if &bytes[..8] != WASM_OJ_JUDGE_PACKAGE_MAGIC {
        return Err(invalid("judge package transport magic is invalid"));
    }
    let manifest_length =
        u32::from_be_bytes(bytes[8..12].try_into().expect("fixed header")) as usize;
    let blob_count = u32::from_be_bytes(bytes[12..16].try_into().expect("fixed header")) as usize;
    if manifest_length == 0 || manifest_length > MAX_MANIFEST_BYTES || blob_count > MAX_BLOBS {
        return Err(invalid("judge package transport header exceeds its limits"));
    }
    let manifest_end = HEADER_BYTES
        .checked_add(manifest_length)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| invalid("judge package manifest is truncated"))?;
    let checked_manifest = check_manifest(&bytes[HEADER_BYTES..manifest_end])?;
    if blob_count != checked_manifest.ordered_digests.len() {
        return Err(invalid(
            "judge package blob count disagrees with its manifest",
        ));
    }

    let mut cursor = manifest_end;
    let mut checked_judge_data = None;
    for expected_digest_value in &checked_manifest.ordered_digests {
        let header_end = cursor
            .checked_add(BLOB_HEADER_BYTES)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| invalid("judge package transport is truncated"))?;
        let actual_digest: [u8; 32] = bytes[cursor..cursor + 32].try_into().expect("fixed digest");
        let blob_length_u64 = u64::from_be_bytes(
            bytes[cursor + 32..header_end]
                .try_into()
                .expect("fixed length"),
        );
        let blob_length = usize::try_from(blob_length_u64)
            .map_err(|_| invalid("judge package blob length exceeds the platform range"))?;
        let expected_length = checked_manifest.references[expected_digest_value];
        if actual_digest != *expected_digest_value || blob_length != expected_length {
            return Err(invalid(
                "judge package blob header disagrees with its manifest",
            ));
        }
        cursor = header_end;
        let content_end = cursor
            .checked_add(blob_length)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| invalid("judge package transport is truncated"))?;
        let contents = &bytes[cursor..content_end];
        if sha256(contents) != *expected_digest_value {
            return Err(invalid(format!(
                "judge package blob '{}' failed integrity verification",
                hex_digest(expected_digest_value)
            )));
        }
        if *expected_digest_value
            == parse_digest(&checked_manifest.wire.judge_data.sha256)
                .expect("manifest digest was checked")
        {
            checked_judge_data = Some(check_judge_data(
                contents,
                &checked_manifest.wire.allowed_profiles,
            )?);
        }
        if checked_manifest.artifact_digest == Some(*expected_digest_value) {
            let judge_data = checked_judge_data.as_ref().ok_or_else(|| {
                invalid("judge package judgeData must precede its executable blobs")
            })?;
            let memory_limit = options
                .memory_limit_bytes
                .map(|limit| limit.min(judge_data.maximum_memory_bytes))
                .unwrap_or(judge_data.maximum_memory_bytes);
            validate_trusted_judge_wasm(contents, Some(memory_limit))?;
        }
        cursor = content_end;
    }
    if cursor != bytes.len() {
        return Err(invalid("judge package transport contains trailing bytes"));
    }

    let package_digest = sha256(bytes);
    if options
        .expected_bytes
        .is_some_and(|expected| expected != bytes.len())
    {
        return Err(invalid(
            "judge package byte length disagrees with its publication",
        ));
    }
    if expected_digest.is_some_and(|expected| expected != package_digest) {
        return Err(invalid(
            "judge package digest disagrees with its publication",
        ));
    }
    let judge_data =
        checked_judge_data.ok_or_else(|| invalid("judge package is missing its judgeData blob"))?;
    let manifest = manifest_projection(&checked_manifest.wire);
    Ok(ValidatedJudgePackage {
        manifest,
        judge_data_case_count: judge_data.case_count,
        bytes: bytes.len(),
        execution_semantic_sha256: hex_digest(&package_digest),
    })
}

fn check_manifest(bytes: &[u8]) -> Result<CheckedManifest, JudgePackageError> {
    let wire: ManifestWire = parse_canonical_json(bytes, "judge package manifest")?;
    if wire.schema != WASM_OJ_JUDGE_PACKAGE_SCHEMA
        || wire.wasm_oj_contract != WASM_OJ_CONTRACT_VERSION
    {
        return Err(invalid("judge package manifest contract is unsupported"));
    }
    check_allowed_profiles(&wire.allowed_profiles)?;

    let judge_data_digest = check_blob_reference(&wire.judge_data, None, "judgeData")?;
    let mut references = BTreeMap::new();
    references.insert(judge_data_digest, wire.judge_data.bytes as usize);
    let mut artifact_digest = None;
    match &wire.judge {
        JudgeWire::Text => {}
        JudgeWire::Checker {
            runtime_profile,
            artifact,
            assets,
            args,
        } => {
            artifact_digest = Some(check_executable_manifest(
                "checker",
                runtime_profile,
                artifact,
                assets,
                args,
                None,
                &mut references,
            )?);
        }
        JudgeWire::Interactive {
            runtime_profile,
            artifact,
            assets,
            args,
            input_path,
        } => {
            artifact_digest = Some(check_executable_manifest(
                "interactive",
                runtime_profile,
                artifact,
                assets,
                args,
                Some(input_path),
                &mut references,
            )?);
        }
    }
    let ordered_digests = std::iter::once(judge_data_digest)
        .chain(
            references
                .keys()
                .copied()
                .filter(|digest| *digest != judge_data_digest),
        )
        .collect();
    Ok(CheckedManifest {
        wire,
        references,
        ordered_digests,
        artifact_digest,
    })
}

#[allow(clippy::too_many_arguments)]
fn check_executable_manifest(
    kind: &str,
    runtime_profile: &str,
    artifact: &BlobReference,
    assets: &[AssetReference],
    args: &[String],
    input_path: Option<&String>,
    references: &mut BTreeMap<[u8; 32], usize>,
) -> Result<[u8; 32], JudgePackageError> {
    if !matches!(
        runtime_profile,
        "c-wasip1-release" | "cpp-wasip1-release" | "rust-wasip1-release" | "go-wasip1-release"
    ) {
        return Err(invalid(format!(
            "judge package {kind} runtimeProfile is unsupported"
        )));
    }
    let artifact_digest = check_blob_reference(
        artifact,
        Some(TRUSTED_JUDGE_WASM_MAX_BYTES),
        "judge artifact",
    )?;
    insert_reference(references, artifact_digest, artifact.bytes as usize)?;
    if assets.len() > MAX_ASSETS {
        return Err(invalid(format!("judge package {kind} assets are invalid")));
    }
    let namespace = if kind == "checker" {
        "/checker/assets/"
    } else {
        "/interactor/assets/"
    };
    let mut previous_path: Option<&str> = None;
    let mut asset_total = 0usize;
    for asset in assets {
        check_guest_path(&asset.guest_path, namespace)?;
        if previous_path.is_some_and(|previous| {
            utf16_cmp(previous, &asset.guest_path) != std::cmp::Ordering::Less
        }) {
            return Err(invalid(format!(
                "judge package {kind} assets must be unique and sorted by guestPath"
            )));
        }
        previous_path = Some(&asset.guest_path);
        let digest = check_blob_reference(
            &BlobReference {
                bytes: asset.bytes,
                sha256: asset.sha256.clone(),
            },
            Some(MAX_ASSET_BYTES),
            "judge asset",
        )?;
        asset_total = asset_total
            .checked_add(asset.bytes as usize)
            .ok_or_else(|| invalid("judge package asset size overflow"))?;
        insert_reference(references, digest, asset.bytes as usize)?;
    }
    if asset_total > MAX_ASSET_TOTAL_BYTES {
        return Err(invalid(format!("judge package {kind} assets exceed 4 MiB")));
    }
    check_args(args)?;
    if let Some(path) = input_path {
        check_guest_path(path, "/interactor/input/")?;
    }
    Ok(artifact_digest)
}

fn insert_reference(
    references: &mut BTreeMap<[u8; 32], usize>,
    digest: [u8; 32],
    bytes: usize,
) -> Result<(), JudgePackageError> {
    if references
        .insert(digest, bytes)
        .is_some_and(|existing| existing != bytes)
    {
        return Err(invalid(
            "judge package repeats one digest with different lengths",
        ));
    }
    Ok(())
}

fn check_blob_reference(
    reference: &BlobReference,
    maximum: Option<usize>,
    label: &str,
) -> Result<[u8; 32], JudgePackageError> {
    let bytes = usize::try_from(reference.bytes)
        .map_err(|_| invalid(format!("judge package {label} is outside its byte limit")))?;
    if bytes == 0 || bytes > maximum.unwrap_or(WASM_OJ_JUDGE_PACKAGE_MAX_BYTES) {
        return Err(invalid(format!(
            "judge package {label} is outside its byte limit"
        )));
    }
    parse_digest(&reference.sha256)
        .map_err(|_| invalid(format!("judge package {label} digest is invalid")))
}

fn check_allowed_profiles(
    profiles: &BTreeMap<String, CompileProfile>,
) -> Result<(), JudgePackageError> {
    if profiles.is_empty() {
        return Err(invalid(
            "allowedProfiles must contain at least one compile profile",
        ));
    }
    for (language, profile) in profiles {
        if !matches!(
            language.as_str(),
            "c" | "cpp" | "rust" | "python" | "javascript" | "typescript" | "go"
        ) {
            return Err(invalid(format!(
                "allowedProfiles language '{language}' is unsupported"
            )));
        }
        if !matches!(profile.target.as_str(), "wasip1" | "wasix")
            || !matches!(profile.optimization.as_str(), "debug" | "release")
        {
            return Err(invalid(format!(
                "allowedProfiles profile for '{language}' is unsupported"
            )));
        }
    }
    Ok(())
}

fn check_args(args: &[String]) -> Result<(), JudgePackageError> {
    if args.len() > 64
        || args
            .iter()
            .any(|arg| arg.contains('\0') || arg.len() > 4_096)
    {
        return Err(invalid("judge package args must be a bounded string array"));
    }
    Ok(())
}

fn check_guest_path(path: &str, namespace: &str) -> Result<(), JudgePackageError> {
    let bad_component = path
        .split('/')
        .any(|component| matches!(component, "." | ".."));
    if utf16_len(path) > 512
        || !path.starts_with(namespace)
        || !path.starts_with('/')
        || path.ends_with('/')
        || path.contains("//")
        || path.contains('\\')
        || path.contains('\0')
        || bad_component
    {
        return Err(invalid(format!(
            "judge package guest path must be inside '{namespace}'"
        )));
    }
    Ok(())
}

fn manifest_projection(wire: &ManifestWire) -> JudgePackageManifest {
    JudgePackageManifest {
        judge_kind: match wire.judge {
            JudgeWire::Text => "text",
            JudgeWire::Checker { .. } => "checker",
            JudgeWire::Interactive { .. } => "interactive",
        }
        .to_string(),
        judge_data_sha256: wire.judge_data.sha256.clone(),
        judge_data_bytes: wire.judge_data.bytes as usize,
        allowed_languages: wire.allowed_profiles.keys().cloned().collect(),
    }
}

fn check_judge_data(
    bytes: &[u8],
    allowed_profiles: &BTreeMap<String, CompileProfile>,
) -> Result<CheckedJudgeData, JudgePackageError> {
    let data: JudgeDataWire = parse_canonical_json(bytes, "judge package judgeData")?;
    if data.schema != "wasm-oj-v2/judge-data" {
        return Err(invalid("judge data schema is unsupported"));
    }
    if data.cases.is_empty() || data.cases.len() > 10_000 {
        return Err(invalid("judge data must contain between 1 and 10000 cases"));
    }
    let mut case_ids = BTreeSet::new();
    for case in &data.cases {
        if !valid_slug(&case.id) || !case_ids.insert(case.id.as_str()) {
            return Err(invalid(
                "judge data contains an invalid or duplicate case id",
            ));
        }
        // Reading these fields is intentional: their JSON types are part of the contract.
        let _ = (&case.input, &case.output);
    }
    if data.scoring.maximum_points != 100 {
        return Err(invalid("judge data maximumPoints must be 100"));
    }
    if data.scoring.calibration.method != "wasm-oj-v2/compiled-average-optimal-rounded/v1" {
        return Err(invalid("judge data calibration method is unsupported"));
    }
    if data
        .scoring
        .calibration
        .profiles
        .keys()
        .ne(allowed_profiles.keys())
    {
        return Err(invalid(
            "judge data calibration profiles must exactly match allowedProfiles",
        ));
    }
    for profile in data.scoring.calibration.profiles.values() {
        if profile.is_empty() || !is_ecmascript_trimmed(profile) || utf16_len(profile) > 4_096 {
            return Err(invalid("judge data calibration profile is invalid"));
        }
    }
    let policy_ids = ["baseline", "efficient", "optimal"];
    if data.scoring.policies.len() != policy_ids.len() {
        return Err(invalid("judge data scoring policies are invalid"));
    }
    let mut points = 0u64;
    for (index, policy) in data.scoring.policies.iter().enumerate() {
        if policy.id != policy_ids[index] {
            return Err(invalid("judge data policies are not in canonical order"));
        }
        positive_at_most(policy.points, 100, "judge data policy points")?;
        points += policy.points;
        check_limits(&policy.limits)?;
        if index > 0 {
            check_policy_order(&data.scoring.policies[index - 1].limits, &policy.limits)?;
        }
    }
    if points != 100 {
        return Err(invalid("judge data policy points must sum to 100"));
    }
    positive_at_most(
        data.scoring.safety_limits.wall_time_limit_ms,
        MAX_WALL_TIME_LIMIT_MS,
        "judge data wallTimeLimitMs",
    )?;
    let maximum_memory_bytes = data
        .scoring
        .policies
        .iter()
        .map(|policy| policy.limits.memory_limit_bytes)
        .max()
        .expect("three policies were checked");
    Ok(CheckedJudgeData {
        case_count: data.cases.len(),
        maximum_memory_bytes,
    })
}

fn check_limits(limits: &LimitsWire) -> Result<(), JudgePackageError> {
    positive_at_most(
        limits.instruction_budget,
        MAX_SAFE_INTEGER,
        "judge data instructionBudget",
    )?;
    positive_at_most(
        limits.memory_limit_bytes,
        MAX_MEMORY_LIMIT_BYTES,
        "judge data memoryLimitBytes",
    )?;
    if limits.memory_limit_bytes < WASM_PAGE_BYTES
        || !limits.memory_limit_bytes.is_multiple_of(WASM_PAGE_BYTES)
    {
        return Err(invalid(
            "judge data memoryLimitBytes must be a positive number of Wasm pages",
        ));
    }
    if let Some(logical) = limits.logical_time_limit_ms {
        positive_at_most(
            logical,
            MAX_LOGICAL_TIME_LIMIT_MS,
            "judge data logicalTimeLimitMs",
        )?;
    }
    Ok(())
}

fn check_policy_order(broad: &LimitsWire, strict: &LimitsWire) -> Result<(), JudgePackageError> {
    let logical_invalid = broad.logical_time_limit_ms.is_some_and(|broad_value| {
        strict
            .logical_time_limit_ms
            .is_none_or(|value| value > broad_value)
    });
    let any_stricter = strict.instruction_budget < broad.instruction_budget
        || strict.memory_limit_bytes < broad.memory_limit_bytes
        || (broad.logical_time_limit_ms.is_none() && strict.logical_time_limit_ms.is_some())
        || matches!(
            (broad.logical_time_limit_ms, strict.logical_time_limit_ms),
            (Some(broad_value), Some(strict_value)) if strict_value < broad_value
        );
    if strict.instruction_budget > broad.instruction_budget
        || strict.memory_limit_bytes > broad.memory_limit_bytes
        || logical_invalid
        || !any_stricter
    {
        return Err(invalid(
            "judge data policies must be ordered broad-to-strict",
        ));
    }
    Ok(())
}

fn positive_at_most(value: u64, maximum: u64, label: &str) -> Result<(), JudgePackageError> {
    if value == 0 || value > maximum {
        return Err(invalid(format!("{label} is outside its limit")));
    }
    Ok(())
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn utf16_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn is_ecmascript_trimmed(value: &str) -> bool {
    value.trim_matches(is_ecmascript_whitespace) == value
}

fn is_ecmascript_whitespace(value: char) -> bool {
    matches!(
        value,
        '\u{0009}'
            | '\u{000a}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn parse_canonical_json<T: for<'de> Deserialize<'de>>(
    bytes: &[u8],
    label: &str,
) -> Result<T, JudgePackageError> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| invalid(format!("{label} is not valid UTF-8 JSON: {error}")))?;
    check_safe_json_numbers(&value, label)?;
    let mut canonical = serde_json::to_vec(&value)
        .map_err(|error| invalid(format!("failed to canonicalize {label}: {error}")))?;
    canonical.push(b'\n');
    if canonical != bytes {
        return Err(invalid(format!(
            "{label} is not encoded as WASM-OJ canonical JSON"
        )));
    }
    serde_json::from_value(value)
        .map_err(|error| invalid(format!("{label} has an invalid shape: {error}")))
}

fn check_safe_json_numbers(value: &Value, label: &str) -> Result<(), JudgePackageError> {
    match value {
        Value::Number(number) => {
            let valid = number
                .as_u64()
                .is_some_and(|integer| integer <= MAX_SAFE_INTEGER)
                || number.as_i64().is_some_and(|integer| {
                    integer >= -(MAX_SAFE_INTEGER as i64) && integer <= MAX_SAFE_INTEGER as i64
                });
            if !valid {
                return Err(invalid(format!("{label} contains a non-canonical number")));
            }
        }
        Value::Array(values) => {
            for item in values {
                check_safe_json_numbers(item, label)?;
            }
        }
        Value::Object(object) => {
            for item in object.values() {
                check_safe_json_numbers(item, label)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
    Ok(())
}

fn parse_digest(value: &str) -> Result<[u8; 32], JudgePackageError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid("value is not a lowercase SHA-256 digest"));
    }
    let mut digest = [0u8; 32];
    for (index, output) in digest.iter_mut().enumerate() {
        let offset = index * 2;
        *output = (hex_nibble(value.as_bytes()[offset])? << 4)
            | hex_nibble(value.as_bytes()[offset + 1])?;
    }
    Ok(digest)
}

fn hex_nibble(value: u8) -> Result<u8, JudgePackageError> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        _ => Err(invalid("invalid lowercase hexadecimal digit")),
    }
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn hex_digest(digest: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(64);
    for byte in digest {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FunctionType {
    parameters: Vec<u8>,
    results: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExportEntry {
    name: String,
    kind: u8,
    index: u32,
}

struct WasmReader<'a> {
    bytes: &'a [u8],
    offset: usize,
    label: String,
}

impl<'a> WasmReader<'a> {
    fn new(bytes: &'a [u8], label: impl Into<String>) -> Self {
        Self {
            bytes,
            offset: 0,
            label: label.into(),
        }
    }

    fn done(&self) -> bool {
        self.offset == self.bytes.len()
    }

    fn require_done(&self) -> Result<(), JudgePackageError> {
        if self.done() {
            Ok(())
        } else {
            Err(invalid(format!("{} has trailing bytes", self.label)))
        }
    }

    fn byte(&mut self) -> Result<u8, JudgePackageError> {
        let byte = self
            .bytes
            .get(self.offset)
            .copied()
            .ok_or_else(|| invalid(format!("{} is truncated", self.label)))?;
        self.offset += 1;
        Ok(byte)
    }

    fn u32(&mut self) -> Result<u32, JudgePackageError> {
        let mut value = 0u32;
        for index in 0..5 {
            let byte = self.byte()?;
            if index == 4 && byte & 0xf0 != 0 {
                return Err(invalid(format!(
                    "{} contains an overflowing varuint32",
                    self.label
                )));
            }
            value |= u32::from(byte & 0x7f) << (index * 7);
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(invalid(format!(
            "{} contains an invalid varuint32",
            self.label
        )))
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], JudgePackageError> {
        let end = self
            .offset
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| invalid(format!("{} is truncated", self.label)))?;
        let result = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(result)
    }

    fn section(
        &mut self,
        length: usize,
        label: impl Into<String>,
    ) -> Result<WasmReader<'a>, JudgePackageError> {
        Ok(WasmReader::new(self.take(length)?, label))
    }

    fn name(&mut self) -> Result<String, JudgePackageError> {
        let length = self.u32()? as usize;
        if length > 4_096 {
            return Err(invalid(format!(
                "{} contains an invalid name length",
                self.label
            )));
        }
        std::str::from_utf8(self.take(length)?)
            .map(str::to_owned)
            .map_err(|_| invalid(format!("{} contains a non-UTF-8 name", self.label)))
    }

    fn vector<T>(
        &mut self,
        mut read: impl FnMut(&mut Self, usize) -> Result<T, JudgePackageError>,
    ) -> Result<Vec<T>, JudgePackageError> {
        let count = self.u32()? as usize;
        let mut result = Vec::with_capacity(count.min(self.bytes.len()));
        for index in 0..count {
            result.push(read(self, index)?);
        }
        Ok(result)
    }
}

/// Validate the trusted checker/interactor command ABI without instantiation.
pub fn validate_trusted_judge_wasm(
    bytes: &[u8],
    memory_limit_bytes: Option<u64>,
) -> Result<TrustedJudgeWasmInfo, JudgePackageError> {
    if bytes.len() < 8 || bytes.len() > TRUSTED_JUDGE_WASM_MAX_BYTES {
        return Err(invalid(
            "trusted judge Wasm is outside the 8 MiB artifact limit",
        ));
    }
    if bytes[..8] != [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00] {
        return Err(invalid(
            "trusted judge artifact is not a core WebAssembly v1 module",
        ));
    }
    if let Some(limit) = memory_limit_bytes
        && (limit < WASM_PAGE_BYTES || !limit.is_multiple_of(WASM_PAGE_BYTES))
    {
        return Err(invalid(
            "trusted judge memory limit must be a positive multiple of 64 KiB",
        ));
    }
    let mut features = WasmFeatures::default();
    features.remove(
        WasmFeatures::THREADS
            | WasmFeatures::SHARED_EVERYTHING_THREADS
            | WasmFeatures::MEMORY64
            | WasmFeatures::MULTI_MEMORY
            | WasmFeatures::COMPONENT_MODEL
            | WasmFeatures::CUSTOM_PAGE_SIZES,
    );
    Validator::new_with_features(features)
        .validate_all(bytes)
        .map_err(|error| {
            invalid(format!(
                "trusted judge artifact is not valid WebAssembly: {error}"
            ))
        })?;

    let mut reader = WasmReader::new(&bytes[8..], "trusted judge module");
    let mut types = Vec::new();
    let mut imported_types = Vec::new();
    let mut import_names = Vec::new();
    let mut defined_types = Vec::new();
    let mut memory = None;
    let mut exports = Vec::new();
    while !reader.done() {
        let id = reader.byte()?;
        let length = reader.u32()? as usize;
        let mut section = reader.section(length, format!("trusted judge section {id}"))?;
        match id {
            0 => {}
            1 => types = parse_wasm_types(&mut section)?,
            2 => {
                (imported_types, import_names) = parse_wasm_imports(&mut section)?;
            }
            3 => {
                defined_types = section.vector(|reader, _| reader.u32())?;
                section.require_done()?;
            }
            5 => memory = Some(parse_wasm_memory(&mut section)?),
            7 => {
                exports = section.vector(|reader, _| {
                    Ok(ExportEntry {
                        name: reader.name()?,
                        kind: reader.byte()?,
                        index: reader.u32()?,
                    })
                })?;
                section.require_done()?;
            }
            8 => {
                return Err(invalid(
                    "trusted judge Wasm must not declare a start section; '_start' is the only entrypoint",
                ));
            }
            _ => {}
        }
    }
    let (initial, maximum) = memory
        .ok_or_else(|| invalid("trusted judge Wasm must define exactly one linear memory"))?;
    if memory_limit_bytes.is_some_and(|limit| initial.saturating_mul(WASM_PAGE_BYTES) > limit) {
        return Err(invalid(
            "trusted judge initial memory exceeds the problem memory limit",
        ));
    }
    for export in &exports {
        if matches!(
            export.name.as_str(),
            "gas_counter" | "__wasm_oj_deferred_start"
        ) || export.name.starts_with("__wasm_oj_")
        {
            return Err(invalid(format!(
                "trusted judge export '{}' is reserved by WASM-OJ",
                export.name
            )));
        }
        if !matches!(export.name.as_str(), "memory" | "_start") {
            return Err(invalid(format!(
                "trusted judge export '{}' is outside the admitted command ABI",
                export.name
            )));
        }
    }
    let memory_exports: Vec<_> = exports
        .iter()
        .filter(|entry| entry.name == "memory")
        .collect();
    if memory_exports.len() != 1 || memory_exports[0].kind != 2 || memory_exports[0].index != 0 {
        return Err(invalid(
            "trusted judge Wasm must export its sole linear memory as 'memory'",
        ));
    }
    let start_exports: Vec<_> = exports
        .iter()
        .filter(|entry| entry.name == "_start")
        .collect();
    if start_exports.len() != 1 || start_exports[0].kind != 0 {
        return Err(invalid(
            "trusted judge Wasm must export exactly one '_start' function",
        ));
    }
    let start_index = start_exports[0].index as usize;
    if start_index < imported_types.len() {
        return Err(invalid(
            "trusted judge '_start' must be defined by the module",
        ));
    }
    let start_type = defined_types
        .get(start_index - imported_types.len())
        .and_then(|index| types.get(*index as usize));
    if !matches!(start_type, Some(function) if function.parameters.is_empty() && function.results.is_empty())
    {
        return Err(invalid(
            "trusted judge '_start' must have the signature () -> ()",
        ));
    }
    for index in imported_types.iter().chain(&defined_types) {
        if types.get(*index as usize).is_none() {
            return Err(invalid("trusted judge function refers to a missing type"));
        }
    }
    let unique_imports: BTreeSet<_> = import_names.iter().collect();
    if unique_imports.len() != import_names.len() {
        return Err(invalid("trusted judge Wasm repeats a WASI import"));
    }
    for (index, qualified_name) in import_names.iter().enumerate() {
        let name = qualified_name
            .strip_prefix("wasi_snapshot_preview1.")
            .expect("import parser checks namespace");
        let (parameters, results) =
            wasi_signature(name).expect("import parser checks the admitted name surface");
        let actual = &types[imported_types[index] as usize];
        if actual.parameters != parameters || actual.results != results {
            return Err(invalid(format!(
                "trusted judge import '{qualified_name}' has an invalid WASI ABI signature"
            )));
        }
    }
    Ok(TrustedJudgeWasmInfo {
        bytes: bytes.len(),
        initial_memory_pages: initial,
        maximum_memory_pages: maximum,
        imports: import_names,
    })
}

fn parse_wasm_types(reader: &mut WasmReader<'_>) -> Result<Vec<FunctionType>, JudgePackageError> {
    let result = reader.vector(|reader, _| {
        if reader.byte()? != 0x60 {
            return Err(invalid(
                "trusted judge Wasm may declare only core function types",
            ));
        }
        let parameters = reader.vector(|reader, _| wasm_value_type(reader))?;
        let results = reader.vector(|reader, _| wasm_value_type(reader))?;
        Ok(FunctionType {
            parameters,
            results,
        })
    })?;
    reader.require_done()?;
    Ok(result)
}

fn wasm_value_type(reader: &mut WasmReader<'_>) -> Result<u8, JudgePackageError> {
    let value = reader.byte()?;
    if matches!(value, 0x7f | 0x7e | 0x7d | 0x7c | 0x7b | 0x70 | 0x6f) {
        Ok(value)
    } else {
        Err(invalid(
            "trusted judge Wasm uses a type outside the admitted core value-type surface",
        ))
    }
}

fn parse_wasm_imports(
    reader: &mut WasmReader<'_>,
) -> Result<(Vec<u32>, Vec<String>), JudgePackageError> {
    let imports = reader.vector(|reader, _| {
        let namespace = reader.name()?;
        let name = reader.name()?;
        let kind = reader.byte()?;
        if kind != 0 {
            return Err(invalid(format!(
                "trusted judge import '{namespace}.{name}' must be a function"
            )));
        }
        if namespace != "wasi_snapshot_preview1" || wasi_signature(&name).is_none() {
            return Err(invalid(format!(
                "trusted judge import '{namespace}.{name}' is outside the admitted WASI Preview 1 surface"
            )));
        }
        Ok((reader.u32()?, format!("{namespace}.{name}")))
    })?;
    reader.require_done()?;
    Ok(imports.into_iter().unzip())
}

fn parse_wasm_memory(reader: &mut WasmReader<'_>) -> Result<(u64, Option<u64>), JudgePackageError> {
    let memories = reader.vector(|reader, _| {
        let flags = reader.u32()?;
        if !matches!(flags, 0 | 1) {
            return Err(invalid(
                "trusted judge memory must be 32-bit, unshared, and use the default page size",
            ));
        }
        let initial = u64::from(reader.u32()?);
        let maximum = if flags == 1 {
            Some(u64::from(reader.u32()?))
        } else {
            None
        };
        if maximum.is_some_and(|maximum| maximum < initial) {
            return Err(invalid(
                "trusted judge memory maximum is below its initial size",
            ));
        }
        Ok((initial, maximum))
    })?;
    reader.require_done()?;
    if memories.len() != 1 {
        return Err(invalid(
            "trusted judge Wasm must define exactly one linear memory",
        ));
    }
    Ok(memories[0])
}

fn wasi_signature(name: &str) -> Option<(&'static [u8], &'static [u8])> {
    const I32: u8 = 0x7f;
    const I64: u8 = 0x7e;
    let errno: &'static [u8] = &[I32];
    let signature = match name {
        "args_get" | "args_sizes_get" | "environ_get" | "environ_sizes_get" | "fd_fdstat_get"
        | "fd_filestat_get" | "fd_prestat_get" | "fd_tell" | "random_get" => {
            (&[I32, I32][..], errno)
        }
        "clock_res_get" => (&[I32, I32][..], errno),
        "clock_time_get" => (&[I32, I64, I32][..], errno),
        "fd_advise" => (&[I32, I64, I64, I32][..], errno),
        "fd_allocate" => (&[I32, I64, I64][..], errno),
        "fd_close" | "fd_datasync" | "fd_sync" | "proc_raise" => (&[I32][..], errno),
        "fd_fdstat_set_flags" => (&[I32, I32][..], errno),
        "fd_fdstat_set_rights" => (&[I32, I64, I64][..], errno),
        "fd_filestat_set_size" => (&[I32, I64][..], errno),
        "fd_filestat_set_times" => (&[I32, I64, I64, I32][..], errno),
        "fd_pread" | "fd_pwrite" => (&[I32, I32, I32, I64, I32][..], errno),
        "fd_prestat_dir_name"
        | "path_create_directory"
        | "path_remove_directory"
        | "path_unlink_file" => (&[I32, I32, I32][..], errno),
        "fd_read" | "fd_write" | "poll_oneoff" => (&[I32, I32, I32, I32][..], errno),
        "fd_readdir" => (&[I32, I32, I32, I64, I32][..], errno),
        "fd_renumber" => (&[I32, I32][..], errno),
        "fd_seek" => (&[I32, I64, I32, I32][..], errno),
        "path_filestat_get" => (&[I32, I32, I32, I32, I32][..], errno),
        "path_filestat_set_times" => (&[I32, I32, I32, I32, I64, I64, I32][..], errno),
        "path_link" => (&[I32, I32, I32, I32, I32, I32, I32][..], errno),
        "path_rename" => (&[I32, I32, I32, I32, I32, I32][..], errno),
        "path_open" => (&[I32, I32, I32, I32, I32, I64, I64, I32, I32][..], errno),
        "path_readlink" => (&[I32, I32, I32, I32, I32, I32][..], errno),
        "path_symlink" => (&[I32, I32, I32, I32, I32][..], errno),
        "proc_exit" => (&[I32][..], &[][..]),
        "sched_yield" => (&[][..], errno),
        _ => return None,
    };
    Some(signature)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN_HEX: &str = include_str!("../../../testdata/wojjdg02-v2-text.hex");
    const GOLDEN_DIGEST: &str = "0039034e813284b1a22fa6c11c1351097cb9141e5954f03f1b2bea98a9b5f12e";

    fn decode_hex(value: &str) -> Vec<u8> {
        let value = value.trim();
        assert!(value.len().is_multiple_of(2));
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| (hex_nibble(pair[0]).unwrap() << 4) | hex_nibble(pair[1]).unwrap())
            .collect()
    }

    #[test]
    fn validates_the_shared_wojjdg02_golden_vector() {
        let bytes = decode_hex(GOLDEN_HEX);
        let validated = validate_judge_package_with_options(
            &bytes,
            JudgePackageValidationOptions {
                expected_bytes: Some(863),
                expected_sha256: Some(GOLDEN_DIGEST),
                memory_limit_bytes: None,
            },
        )
        .unwrap();
        assert_eq!(validated.execution_semantic_sha256, GOLDEN_DIGEST);
        assert_eq!(validated.judge_data_case_count, 1);
        assert_eq!(validated.manifest.judge_kind, "text");
        assert_eq!(validated.manifest.allowed_languages, ["c"]);
    }

    #[test]
    fn rejects_every_truncated_golden_prefix() {
        let bytes = decode_hex(GOLDEN_HEX);
        for length in 0..bytes.len() {
            assert!(
                validate_judge_package(&bytes[..length]).is_err(),
                "accepted truncated prefix of {length} bytes"
            );
        }
    }

    #[test]
    fn rejects_the_retired_transport_magic() {
        let mut bytes = decode_hex(GOLDEN_HEX);
        let retired_magic: Vec<u8> = [b"FORG".as_slice(), b"JDG1".as_slice()].concat();
        bytes[..8].copy_from_slice(&retired_magic);
        assert!(
            validate_judge_package(&bytes)
                .unwrap_err()
                .to_string()
                .contains("transport magic")
        );
    }

    #[test]
    fn rejects_noncanonical_manifest_duplicate_blob_and_trailing_bytes() {
        let bytes = decode_hex(GOLDEN_HEX);

        let mut noncanonical = bytes.clone();
        let manifest_length = u32::from_be_bytes(noncanonical[8..12].try_into().unwrap()) as usize;
        noncanonical[HEADER_BYTES + manifest_length - 1] = b' ';
        assert!(
            validate_judge_package(&noncanonical)
                .unwrap_err()
                .to_string()
                .contains("canonical JSON")
        );

        let blob_start = HEADER_BYTES + manifest_length;
        let mut duplicate = bytes.clone();
        duplicate[12..16].copy_from_slice(&2u32.to_be_bytes());
        duplicate.extend_from_within(blob_start..);
        assert!(
            validate_judge_package(&duplicate)
                .unwrap_err()
                .to_string()
                .contains("blob count disagrees")
        );

        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(
            validate_judge_package(&trailing)
                .unwrap_err()
                .to_string()
                .contains("trailing bytes")
        );
    }

    #[test]
    fn rejects_blob_header_and_content_digest_corruption() {
        let bytes = decode_hex(GOLDEN_HEX);
        let manifest_length = u32::from_be_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let blob_start = HEADER_BYTES + manifest_length;

        let mut header = bytes.clone();
        header[blob_start] ^= 1;
        assert!(
            validate_judge_package(&header)
                .unwrap_err()
                .to_string()
                .contains("header disagrees")
        );

        let mut content = bytes;
        content[blob_start + BLOB_HEADER_BYTES] ^= 1;
        assert!(
            validate_judge_package(&content)
                .unwrap_err()
                .to_string()
                .contains("integrity verification")
        );
    }

    fn u32_leb(mut value: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            bytes.push(byte);
            if value == 0 {
                return bytes;
            }
        }
    }

    fn wasm_name(value: &str) -> Vec<u8> {
        let mut result = u32_leb(value.len() as u32);
        result.extend_from_slice(value.as_bytes());
        result
    }

    fn wasm_section(id: u8, payload: &[u8]) -> Vec<u8> {
        let mut result = vec![id];
        result.extend(u32_leb(payload.len() as u32));
        result.extend_from_slice(payload);
        result
    }

    fn command_module(
        import: Option<(&str, &str)>,
        start_section: bool,
        memory_flags: u8,
    ) -> Vec<u8> {
        let imported = usize::from(import.is_some());
        let mut module = b"\0asm\x01\0\0\0".to_vec();
        let type_payload = if import.is_some() {
            vec![2, 0x60, 1, 0x7f, 0, 0x60, 0, 0]
        } else {
            vec![1, 0x60, 0, 0]
        };
        module.extend(wasm_section(1, &type_payload));
        if let Some((namespace, name)) = import {
            let mut payload = vec![1];
            payload.extend(wasm_name(namespace));
            payload.extend(wasm_name(name));
            payload.extend([0, 0]);
            module.extend(wasm_section(2, &payload));
        }
        module.extend(wasm_section(3, &[1, u8::from(import.is_some())]));
        let memory_payload = if memory_flags == 0 {
            vec![1, 0, 1]
        } else {
            vec![1, memory_flags, 1, 1]
        };
        module.extend(wasm_section(5, &memory_payload));
        let mut exports = vec![2];
        exports.extend(wasm_name("memory"));
        exports.extend([2, 0]);
        exports.extend(wasm_name("_start"));
        exports.extend([0, imported as u8]);
        module.extend(wasm_section(7, &exports));
        if start_section {
            module.extend(wasm_section(8, &[imported as u8]));
        }
        module.extend(wasm_section(10, &[1, 2, 0, 0x0b]));
        module
    }

    fn checker_package() -> (Vec<u8>, Vec<Vec<u8>>) {
        let golden = decode_hex(GOLDEN_HEX);
        let golden_manifest_length = u32::from_be_bytes(golden[8..12].try_into().unwrap()) as usize;
        let golden_blob_start = HEADER_BYTES + golden_manifest_length;
        let judge_data_length = u64::from_be_bytes(
            golden[golden_blob_start + 32..golden_blob_start + BLOB_HEADER_BYTES]
                .try_into()
                .unwrap(),
        ) as usize;
        let judge_data = golden[golden_blob_start + BLOB_HEADER_BYTES
            ..golden_blob_start + BLOB_HEADER_BYTES + judge_data_length]
            .to_vec();
        let artifact = command_module(None, false, 0);
        let asset = vec![0, 1, 2, 255];
        let judge_data_digest = sha256(&judge_data);
        let artifact_digest = sha256(&artifact);
        let asset_digest = sha256(&asset);
        let manifest = serde_json::json!({
            "allowedProfiles": {"c": {"optimization": "release", "target": "wasip1"}},
            "wasmOjContract": 2,
            "judge": {
                "args": [],
                "artifact": {"bytes": artifact.len(), "sha256": hex_digest(&artifact_digest)},
                "assets": [{
                    "bytes": asset.len(),
                    "guestPath": "/checker/assets/policy.bin",
                    "sha256": hex_digest(&asset_digest),
                }],
                "kind": "checker",
                "runtimeProfile": "c-wasip1-release",
            },
            "judgeData": {"bytes": judge_data.len(), "sha256": hex_digest(&judge_data_digest)},
            "schema": "wasm-oj-v2/judge-package",
        });
        let mut manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        manifest_bytes.push(b'\n');
        let mut remaining = vec![(artifact_digest, artifact), (asset_digest, asset)];
        remaining.sort_by_key(|(digest, _)| *digest);
        let ordered: Vec<_> = std::iter::once((judge_data_digest, judge_data))
            .chain(remaining)
            .collect();
        let mut package = Vec::new();
        package.extend_from_slice(WASM_OJ_JUDGE_PACKAGE_MAGIC);
        package.extend_from_slice(&(manifest_bytes.len() as u32).to_be_bytes());
        package.extend_from_slice(&(ordered.len() as u32).to_be_bytes());
        package.extend_from_slice(&manifest_bytes);
        let mut records = Vec::new();
        for (digest, contents) in ordered {
            let mut record = Vec::new();
            record.extend_from_slice(&digest);
            record.extend_from_slice(&(contents.len() as u64).to_be_bytes());
            record.extend_from_slice(&contents);
            package.extend_from_slice(&record);
            records.push(record);
        }
        (package, records)
    }

    #[test]
    fn validates_checker_artifact_integration_and_rejects_out_of_order_blobs() {
        let (package, records) = checker_package();
        let validated = validate_judge_package(&package).unwrap();
        assert_eq!(validated.manifest.judge_kind, "checker");

        let manifest_length = u32::from_be_bytes(package[8..12].try_into().unwrap()) as usize;
        let records_start = HEADER_BYTES + manifest_length;
        let mut reordered = package[..records_start].to_vec();
        reordered.extend_from_slice(&records[0]);
        reordered.extend_from_slice(&records[2]);
        reordered.extend_from_slice(&records[1]);
        assert!(
            validate_judge_package(&reordered)
                .unwrap_err()
                .to_string()
                .contains("header disagrees")
        );
    }

    #[test]
    fn statically_validates_trusted_wasm_and_rejects_malicious_capabilities() {
        let valid = command_module(None, false, 0);
        assert_eq!(
            validate_trusted_judge_wasm(&valid, Some(WASM_PAGE_BYTES))
                .unwrap()
                .initial_memory_pages,
            1
        );

        let network = command_module(Some(("wasi_snapshot_preview1", "sock_accept")), false, 0);
        assert!(validate_trusted_judge_wasm(&network, None).is_err());

        let wasix = command_module(Some(("wasix_32v1", "fd_read")), false, 0);
        assert!(validate_trusted_judge_wasm(&wasix, None).is_err());

        let start = command_module(None, true, 0);
        assert!(validate_trusted_judge_wasm(&start, None).is_err());

        let shared = command_module(None, false, 3);
        assert!(validate_trusted_judge_wasm(&shared, None).is_err());

        assert!(validate_trusted_judge_wasm(&valid[..valid.len() - 1], None).is_err());
    }
}
