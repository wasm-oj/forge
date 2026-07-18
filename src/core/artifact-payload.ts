import { sha256Hex } from "./hash.ts";
import { canonicalFileEntries } from "./project-files.ts";
import type { BuildArtifact } from "./types.ts";

const encoder = new TextEncoder();
const RUNTIME_BUNDLE_DOMAIN = encoder.encode("wasm-oj-forge/runtime-bundle-payload\0");
const TEXT_FILE = 1;
const BINARY_FILE = 2;
const U64_BYTES = 8;

/**
 * Returns the exact payload representation covered by persistent-cache
 * integrity checks. Standalone Wasm is hashed directly. Runtime bundles use a
 * domain-separated, path-sorted binary frame:
 *
 *   domain || file-count:u64 || (path-length:u64 || path:utf8 ||
 *   type:u8 || content-length:u64 || content)*
 *
 * Explicit path, type, and byte-length fields make every file set decode to
 * one representation without delimiter or text/binary ambiguities.
 */
export function canonicalArtifactPayloadBytes(artifact: BuildArtifact): Uint8Array {
  if (artifact.kind === "wasm") return artifact.bytes;
  if (artifact.kind !== "runtime-bundle") {
    throw new Error(`Unsupported artifact payload kind '${String((artifact as { kind?: unknown }).kind)}'.`);
  }

  const entries = canonicalFileEntries(artifact.files);
  const frames: Uint8Array[] = [RUNTIME_BUNDLE_DOMAIN, encodeU64(entries.length, "Runtime bundle file count")];
  for (const [path, contents] of entries) {
    const pathBytes = encoder.encode(path);
    let type: number;
    let contentBytes: Uint8Array;
    if (typeof contents === "string") {
      type = TEXT_FILE;
      contentBytes = encoder.encode(contents);
    } else if (contents instanceof Uint8Array) {
      type = BINARY_FILE;
      contentBytes = contents;
    } else {
      throw new Error(`Runtime bundle file '${path}' must contain text or Uint8Array bytes.`);
    }
    frames.push(
      encodeU64(pathBytes.byteLength, `Runtime bundle path '${path}' byte length`),
      pathBytes,
      Uint8Array.of(type),
      encodeU64(contentBytes.byteLength, `Runtime bundle file '${path}' byte length`),
      contentBytes,
    );
  }
  return concatenate(frames);
}

export function artifactPayloadSha256(artifact: BuildArtifact): Promise<string> {
  return sha256Hex(canonicalArtifactPayloadBytes(artifact));
}

function encodeU64(value: number, label: string): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  const bytes = new Uint8Array(U64_BYTES);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function concatenate(frames: readonly Uint8Array[]): Uint8Array {
  const byteLength = frames.reduce((total, frame) => {
    const next = total + frame.byteLength;
    if (!Number.isSafeInteger(next)) throw new RangeError("Artifact payload framing exceeds the safe integer range.");
    return next;
  }, 0);
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const frame of frames) {
    output.set(frame, offset);
    offset += frame.byteLength;
  }
  return output;
}
