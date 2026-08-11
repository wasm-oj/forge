import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { parseGitHubTarGz } from "./github-archive.mjs";

function writeString(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) throw new Error("test tar field is too long");
  bytes.copy(header, offset);
}

function writeOctal(header, offset, length, value) {
  writeString(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarEntry(name, type, contents = Buffer.alloc(0), prefix = "") {
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, contents.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (contents.byteLength % 512)) % 512);
  return Buffer.concat([header, contents, padding]);
}

function paxRecord(key, value) {
  const record = `${key}=${value}\n`;
  let length = Buffer.byteLength(record) + 2;
  for (;;) {
    const encoded = Buffer.from(`${length} ${record}`);
    if (encoded.byteLength === length) return encoded;
    length = encoded.byteLength;
  }
}

function archive(entries) {
  return new Uint8Array(gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
}

const commit = "c0dcab98c67e9c6930a9e1aa3b3734a9c7c96de2";
const root = `wasm-oj-official-problems-${commit}`;
const longRelativePath = `collection/problems/042-calibration-multiple-choice-knapsack.${"a".repeat(64)}.json`;

test("accepts GitHub production PAX comment and applies the next-entry path", () => {
  const problem = Buffer.from("{\"schema\":\"fixture\"}\n");
  const index = Buffer.from("{\"problems\":[]}\n");
  const files = parseGitHubTarGz(archive([
    tarEntry("pax_global_header", "g", paxRecord("comment", commit)),
    tarEntry(`${root}/`, "5"),
    tarEntry("fixture.paxheader", "x", paxRecord("path", `${root}/${longRelativePath}`)),
    tarEntry("fixture.data", "0", problem),
    tarEntry(`${root}/collection/index.json`, "0", index),
  ]));

  assert.deepEqual([...files.keys()], [longRelativePath, "collection/index.json"]);
  assert.deepEqual(Buffer.from(files.get(longRelativePath)), problem);
  assert.deepEqual(Buffer.from(files.get("collection/index.json")), index);
});

test("rejects PAX link metadata and tar links", () => {
  assert.throws(() => parseGitHubTarGz(archive([
    tarEntry(`${root}/`, "5"),
    tarEntry("fixture.paxheader", "x", Buffer.concat([
      paxRecord("path", `${root}/safe.txt`),
      paxRecord("linkpath", `${root}/target.txt`),
    ])),
    tarEntry("fixture.data", "0", Buffer.from("safe\n")),
  ])), /forbidden PAX link metadata/);

  assert.throws(() => parseGitHubTarGz(archive([
    tarEntry(`${root}/`, "5"),
    tarEntry(`${root}/link`, "2"),
  ])), /archive link 'link' is forbidden/);
});

test("rejects unsafe PAX paths", () => {
  assert.throws(() => parseGitHubTarGz(archive([
    tarEntry(`${root}/`, "5"),
    tarEntry("fixture.paxheader", "x", paxRecord("path", `${root}/../escape.txt`)),
    tarEntry("fixture.data", "0", Buffer.from("unsafe\n")),
  ])), /archive path .* is unsafe/);
});

test("rejects malformed and duplicate PAX records", () => {
  assert.throws(() => parseGitHubTarGz(archive([
    tarEntry("pax_global_header", "g", Buffer.from("12 comment=x\n")),
  ])), /malformed PAX metadata/);

  assert.throws(() => parseGitHubTarGz(archive([
    tarEntry("fixture.paxheader", "x", Buffer.concat([
      paxRecord("path", `${root}/first.txt`),
      paxRecord("path", `${root}/second.txt`),
    ])),
  ])), /repeats PAX key 'path'/);

  assert.throws(() => parseGitHubTarGz(archive([
    tarEntry("fixture.paxheader", "x", Buffer.concat([
      paxRecord("path", `${root}/safe.txt`),
      paxRecord("size", "5"),
    ])),
    tarEntry("fixture.data", "0", Buffer.from("safe\n")),
  ])), /unsupported PAX metadata/);
});

test("rejects PAX paths not consumed by exactly the next archive entry", () => {
  assert.throws(() => parseGitHubTarGz(archive([
    tarEntry("fixture.paxheader", "x", paxRecord("path", `${root}/first.txt`)),
    tarEntry("pax_global_header", "g", paxRecord("comment", commit)),
  ])), /was not consumed by the next entry/);

  assert.throws(() => parseGitHubTarGz(archive([
    tarEntry("fixture.paxheader", "x", paxRecord("path", `${root}/first.txt`)),
  ])), /has no following entry/);
});
