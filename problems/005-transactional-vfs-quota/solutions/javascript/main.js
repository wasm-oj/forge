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
const P = Number(nextToken()),
  N = Number(nextToken()),
  B = BigInt(nextToken()),
  I = Number(nextToken()),
  a = /** @type {(bigint | null)[]} */ (Array(P + 1).fill(null));
let used = 0n, ino = 0, peakB = 0n, peakI = 0, sticky = 0;
let output = "";
/** @param {string} line */
function emit(line) {
  if (output.length + line.length > 65536) {
    std.out.puts(output);
    output = "";
  }
  output += line;
}
for (let z = 0; z < N; z++) {
  const op = nextToken(), x = Number(nextToken());
  /** @type {string | null} */
  let err = null;
  if (op === "CREATE") {
    if (a[x] !== null) err = "EXISTS";
    else if (ino === I) err = "INODES";
    else {
      a[x] = 0n;
      ino++;
    }
  } else if (op === "UNLINK") {
    if (a[x] === null) err = "NOENT";
    else {
      used -= /** @type {bigint} */ (a[x]);
      a[x] = null;
      ino--;
    }
  } else {
    /** @type {bigint} */
    let v;
    if (op === "WRITE") {
      const off = BigInt(nextToken()), len = BigInt(nextToken());
      v = len === 0n
        ? (a[x] ?? 0n)
        : ((a[x] ?? 0n) > off + len ? (a[x] ?? 0n) : off + len);
    } else v = BigInt(nextToken());
    if (a[x] === null) err = "NOENT";
    else {
      const old = /** @type {bigint} */ (a[x]);
      if (v > old && v - old > B - used) err = "BYTES";
      else {
        used += v - old;
        a[x] = v;
      }
    }
  }
  if (err === "BYTES" || err === "INODES") sticky = 1;
  emit(err === null ? "OK\n" : `ERR ${err}\n`);
  if (used > peakB) peakB = used;
  if (ino > peakI) peakI = ino;
}
emit(`SUMMARY ${used} ${ino} ${peakB} ${peakI} ${sticky}\n`);
if (output.length) std.out.puts(output);
