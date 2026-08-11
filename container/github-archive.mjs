import { gunzipSync } from "node:zlib";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_FILE_BYTES = 32 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function tarString(bytes) {
  const zero = bytes.indexOf(0);
  return Buffer.from(zero >= 0 ? bytes.subarray(0, zero) : bytes).toString("utf8").trim();
}

function tarOctal(bytes, label) {
  const value = tarString(bytes).replace(/^0+/, "") || "0";
  if (!/^[0-7]+$/.test(value)) throw new Error(`${label} has invalid tar octal metadata`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} has unsafe tar metadata`);
  return parsed;
}

function normalizedArchivePath(value) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) throw new Error(`archive path '${value}' is unsafe`);
  const parts = value.replace(/\/$/, "").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`archive path '${value}' is unsafe`);
  return parts;
}

function paxRecords(bytes, label) {
  const records = new Map();
  let offset = 0;
  while (offset < bytes.byteLength) {
    let separator = offset;
    while (separator < bytes.byteLength && bytes[separator] !== 0x20) separator += 1;
    if (separator === bytes.byteLength) throw new Error(`${label} has malformed PAX metadata`);
    const lengthText = Buffer.from(bytes.subarray(offset, separator)).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error(`${label} has malformed PAX metadata`);
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || length < 5 || end > bytes.byteLength || bytes[end - 1] !== 0x0a) {
      throw new Error(`${label} has malformed PAX metadata`);
    }
    let record;
    try {
      record = decoder.decode(bytes.subarray(separator + 1, end - 1));
    } catch {
      throw new Error(`${label} has non-UTF-8 PAX metadata`);
    }
    const equals = record.indexOf("=");
    if (equals < 1) throw new Error(`${label} has malformed PAX metadata`);
    const key = record.slice(0, equals);
    if (records.has(key)) throw new Error(`${label} repeats PAX key '${key}'`);
    records.set(key, record.slice(equals + 1));
    offset = end;
  }
  return records;
}

function exactPaxValue(records, key, label) {
  if (records.size !== 1 || !records.has(key)) {
    const unsupported = [...records.keys()].filter((item) => item !== key);
    if (unsupported.includes("linkpath")) throw new Error(`${label} contains forbidden PAX link metadata`);
    throw new Error(`${label} contains unsupported PAX metadata`);
  }
  const value = records.get(key);
  if (!value) throw new Error(`${label} has empty PAX '${key}' metadata`);
  return value;
}

export function parseGitHubTarGz(archive) {
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error("repository archive exceeds 128 MiB");
  const tar = new Uint8Array(gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES }));
  const files = new Map();
  let offset = 0;
  let entries = 0;
  let root;
  let pendingPath;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    entries += 1;
    if (entries > MAX_ARCHIVE_ENTRIES) throw new Error("repository archive has too many entries");
    const storedChecksum = tarOctal(header.subarray(148, 156), "tar header");
    let checksum = 0;
    for (let index = 0; index < header.length; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (storedChecksum !== checksum) throw new Error("repository archive tar checksum is invalid");
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const size = tarOctal(header.subarray(124, 136), name || "archive entry");
    if (size > MAX_ARCHIVE_FILE_BYTES) throw new Error(`archive file '${name}' exceeds 32 MiB`);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.byteLength) throw new Error(`archive entry '${name}' is truncated`);
    const type = String.fromCharCode(header[156] || 48);

    if (type === "g" || type === "x") {
      if (pendingPath !== undefined) throw new Error("archive PAX path metadata was not consumed by the next entry");
      const records = paxRecords(tar.subarray(dataStart, dataEnd), type === "g" ? "global PAX header" : "extended PAX header");
      if (type === "g") {
        exactPaxValue(records, "comment", "global PAX header");
      } else {
        pendingPath = exactPaxValue(records, "path", "extended PAX header");
        normalizedArchivePath(pendingPath);
      }
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }

    const archivePath = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = undefined;
    const parts = normalizedArchivePath(archivePath);
    root ??= parts[0];
    if (parts[0] !== root) throw new Error("repository archive contains multiple roots");
    const relative = parts.slice(1).join("/");
    if (type === "1" || type === "2") throw new Error(`archive link '${relative}' is forbidden`);
    if (type !== "0" && type !== "5") throw new Error(`archive entry '${relative}' has unsupported tar type '${type}'`);
    if (type === "0" && relative) {
      if (files.has(relative)) throw new Error(`archive repeats '${relative}'`);
      const contents = tar.slice(dataStart, dataEnd);
      const prefixText = Buffer.from(contents.subarray(0, 200)).toString("utf8");
      if (prefixText.startsWith("version https://git-lfs.github.com/spec/v1")) throw new Error(`Git LFS pointer '${relative}' is forbidden`);
      if (relative === ".gitmodules") throw new Error("Git submodules are forbidden");
      files.set(relative, contents);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (pendingPath !== undefined) throw new Error("archive PAX path metadata has no following entry");
  return files;
}
