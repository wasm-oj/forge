import * as std from "std";

/** @type {string} */
const input = std.in.readAsString();
let cursor = 0;
/** @returns {string} */
function nextToken() {
  while (cursor < input.length && input.charCodeAt(cursor) <= 32) cursor++;
  const start = cursor;
  while (cursor < input.length && input.charCodeAt(cursor) > 32) cursor++;
  return input.slice(start, cursor);
}
const mountedCount = Number(nextToken());
const outputCount = Number(nextToken());
const byteQuota = BigInt(nextToken());
const inodeQuota = BigInt(nextToken());

const pathCount = mountedCount + outputCount;
const paths = /** @type {number[][]} */ ([]);
let baselineBytes = 0n;
for (let i = 0; i < pathCount; i++) {
  const length = Number(nextToken());
  const path = /** @type {number[]} */ ([]);
  for (let j = 0; j < length; j++) path.push(Number(nextToken()));
  paths.push(path);
  if (i < mountedCount) baselineBytes += BigInt(nextToken());
}

paths.sort((a, b) => {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
});

let directoryCount = 1n;
for (let i = 0; i < pathCount; i++) {
  const parentLength = paths[i].length - 1;
  let alreadyPresent = 0;
  if (i > 0) {
    const limit = Math.min(paths[i - 1].length, paths[i].length);
    while (
      alreadyPresent < limit &&
      paths[i - 1][alreadyPresent] === paths[i][alreadyPresent]
    ) {
      alreadyPresent++;
    }
    alreadyPresent = Math.min(alreadyPresent, parentLength);
  }
  directoryCount += BigInt(parentLength - alreadyPresent);
}

const baselineInodes = directoryCount + BigInt(pathCount);
const accepted = baselineBytes <= byteQuota && baselineInodes <= inodeQuota;
const missingBytes = baselineBytes > byteQuota ? baselineBytes - byteQuota : 0n;
const missingInodes = baselineInodes > inodeQuota
  ? baselineInodes - inodeQuota
  : 0n;
std.out.puts(
  `${accepted ? "ACCEPT" : "REJECT"} ${baselineBytes} ${baselineInodes} ` +
    `${accepted ? byteQuota - baselineBytes : missingBytes} ` +
    `${accepted ? inodeQuota - baselineInodes : missingInodes}\n`,
);
