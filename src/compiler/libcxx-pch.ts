import { FORGE_SCHEMAS } from "../core/contract.ts";
import { sha256Hex } from "../core/hash.ts";
import {
  CLANG_CC1_PINS_SHA256,
  CLANG_LIBCXX_PCH_MANIFEST_SHA256,
  CLANG_PACKAGE_SHA256,
  CLANG_VERSION,
} from "../core/toolchains.ts";

export const FORGE_LIBCXX_PCH_HEADER = `#pragma once
#include <algorithm>
#include <array>
#include <bitset>
#include <cassert>
#include <cctype>
#include <cerrno>
#include <cfloat>
#include <charconv>
#include <chrono>
#include <climits>
#include <cmath>
#include <compare>
#include <concepts>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <exception>
#include <functional>
#include <iomanip>
#include <ios>
#include <iostream>
#include <iterator>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <optional>
#include <queue>
#include <random>
#include <ranges>
#include <set>
#include <span>
#include <sstream>
#include <stack>
#include <string>
#include <string_view>
#include <tuple>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>
#include <vector>
`;

export type LibcxxPchProfile = "cpp-debug" | "cpp-release";

export interface LibcxxPchAsset {
  path: string;
  byteLength: number;
  sha256: string;
  compressedByteLength: number;
  compressedSha256: string;
}

export interface LibcxxPchManifest {
  schema: typeof FORGE_SCHEMAS.clangLibcxxPch;
  version: typeof CLANG_VERSION;
  clangPackageSha256: typeof CLANG_PACKAGE_SHA256;
  clangPinsSha256: typeof CLANG_CC1_PINS_SHA256;
  header: typeof FORGE_LIBCXX_PCH_HEADER;
  headerSha256: string;
  profiles: Readonly<Record<LibcxxPchProfile, LibcxxPchAsset>>;
}

const decoder = new TextDecoder();

export async function decodeLibcxxPchManifest(bytes: Uint8Array): Promise<LibcxxPchManifest> {
  const digest = await sha256Hex(bytes);
  if (digest !== CLANG_LIBCXX_PCH_MANIFEST_SHA256) {
    throw new Error(`Pinned libc++ PCH manifest digest mismatch: expected ${CLANG_LIBCXX_PCH_MANIFEST_SHA256}, received ${digest}.`);
  }
  let value: unknown;
  try { value = JSON.parse(decoder.decode(bytes)); } catch (error) {
    throw new Error("Pinned libc++ PCH manifest is not valid JSON.", { cause: error });
  }
  if (!isRecord(value) || value.schema !== FORGE_SCHEMAS.clangLibcxxPch
    || value.version !== CLANG_VERSION || value.clangPackageSha256 !== CLANG_PACKAGE_SHA256
    || value.clangPinsSha256 !== CLANG_CC1_PINS_SHA256 || value.header !== FORGE_LIBCXX_PCH_HEADER
    || !isRecord(value.profiles)) {
    throw new Error("Pinned libc++ PCH manifest is not admitted by the active Clang toolchain contract.");
  }
  if (value.headerSha256 !== await sha256Hex(FORGE_LIBCXX_PCH_HEADER)) {
    throw new Error("Pinned libc++ PCH header digest does not match its canonical source.");
  }
  const manifestProfiles = value.profiles;
  const profiles = Object.fromEntries(await Promise.all((["cpp-debug", "cpp-release"] as const).map(async (profile) => {
    const asset = manifestProfiles[profile];
    if (!isRecord(asset) || typeof asset.path !== "string" || !asset.path.endsWith(`.${profile}.pch.gz.bin`)
      || !isBytes(asset.byteLength) || !isBytes(asset.compressedByteLength)
      || !isSha256(asset.sha256) || !isSha256(asset.compressedSha256)) {
      throw new Error(`Pinned libc++ PCH profile '${profile}' is malformed.`);
    }
    return [profile, {
      path: asset.path,
      byteLength: asset.byteLength,
      sha256: asset.sha256,
      compressedByteLength: asset.compressedByteLength,
      compressedSha256: asset.compressedSha256,
    } satisfies LibcxxPchAsset] as const;
  }))) as Record<LibcxxPchProfile, LibcxxPchAsset>;
  if (Object.keys(manifestProfiles).sort().join(",") !== "cpp-debug,cpp-release") {
    throw new Error("Pinned libc++ PCH manifest has an unexpected profile set.");
  }
  return {
    schema: FORGE_SCHEMAS.clangLibcxxPch,
    version: CLANG_VERSION,
    clangPackageSha256: CLANG_PACKAGE_SHA256,
    clangPinsSha256: CLANG_CC1_PINS_SHA256,
    header: FORGE_LIBCXX_PCH_HEADER,
    headerSha256: value.headerSha256,
    profiles,
  };
}

export function isToolchainLibcxxPchHeader(contents: string): boolean {
  return contents === FORGE_LIBCXX_PCH_HEADER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isBytes(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
