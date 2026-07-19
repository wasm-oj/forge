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
const N = Number(nextToken()),
  Q = Number(nextToken()),
  s = /** @type {string[]} */ ([]),
  a = /** @type {bigint[]} */ ([]);
for (let z = 0; z < N; z++) {
  s.push(nextToken());
  a.push(BigInt(nextToken()));
}
let i = 0, used = 0n;
const c = /** @type {bigint[]} */ ([0n, 0n, 0n]);
/**
 * @param {string} x
 * @returns {number}
 */
const key = (x) => x === "O" ? 0 : x === "E" ? 1 : 2;
let output = "";
/** @param {string} line */
function emit(line) {
  if (output.length + line.length > 65536) {
    std.out.puts(output);
    output = "";
  }
  output += line;
}
for (let z = 0; z < Q; z++) {
  const b = BigInt(nextToken());
  while (i < N && a[i] <= b - used) {
    used += a[i];
    c[key(s[i])] += a[i];
    i++;
  }
  const d = /** @type {bigint[]} */ ([...c]);
  let fail = 0;
  if (i < N) {
    fail = i + 1;
    d[key(s[i])] += b - used;
  }
  emit(`${fail} ${d[0]} ${d[1]} ${d[2]}\n`);
}
if (output.length) std.out.puts(output);
