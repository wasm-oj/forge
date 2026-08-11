import { canonicalJsonBytes } from "./canonical-json.ts";
import { sha256Hex } from "./sha256.ts";

/** Executable runtime components covered by deterministic cost calibration. */
export const FORGE_RUNTIME_COMPONENTS = Object.freeze({
  runtimeCoreWasmSha256: "8db8847ab4b5ff444c658018b5bde59628108ea1f91b1218615e1565af7e1bca",
  runtimeSourceRootSha256: "caa84cc71e734836cdacf694653ba18da7cc350ba5343a27a5ee0b9db9a71d86",
  wasmerNativeVersion: "7.2.1",
  wasmerSdkVersion: "0.10.0",
  wasmerSdkWasmSha256: "49a6646209f5ab5e7c737eac33407d87d9a9959ac83e5ecaaab9261b2323589e",
  wasmerWasixVersion: "0.702.1",
} as const);

/**
 * SHA-256 of `forgeRuntimeIdentityBytes()`.
 * Release verification independently checks the component bytes before this
 * identity is admitted into a calibrated release.
 */
export const FORGE_RUNTIME_IDENTITY_SHA256 =
  "29b41f4ddfd1c305863a3549fb2442d67904b9caed9b098347dd39284c5e602b";

/** Exact canonical serialization hashed by `FORGE_RUNTIME_IDENTITY_SHA256`. */
export function forgeRuntimeIdentityBytes(): Uint8Array {
  return canonicalJsonBytes(FORGE_RUNTIME_COMPONENTS);
}

export async function verifyForgeRuntimeIdentity(): Promise<void> {
  if (await sha256Hex(forgeRuntimeIdentityBytes()) !== FORGE_RUNTIME_IDENTITY_SHA256) {
    throw new Error("Forge runtime identity declaration does not match its digest.");
  }
}
