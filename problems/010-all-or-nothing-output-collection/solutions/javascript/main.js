import * as std from "std";
/** @typedef {{ p: string, m: bigint, a: bigint }} File */
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
  U = BigInt(nextToken()),
  a = /** @type {File[]} */ ([]);
for (let i = 0; i < N; i++) {
  a.push({ p: nextToken(), m: BigInt(nextToken()), a: BigInt(nextToken()) });
}
a.sort((x, y) => x.p < y.p ? -1 : x.p > y.p ? 1 : 0);
const pre = /** @type {bigint[]} */ ([0n]);
let mismatch = N;
for (let i = 0; i < N; i++) {
  pre.push(pre[i] + a[i].m);
  if (mismatch === N && a[i].m !== a[i].a) mismatch = i;
}
let k = 0;
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
  if (b < U) {
    emit("ERR QUOTA -\n");
    continue;
  }
  const cap = b - U;
  while (k < N && pre[k + 1] <= cap) k++;
  if (k < mismatch) emit(`ERR QUOTA ${a[k].p}\n`);
  else if (mismatch < N) emit(`ERR MISMATCH ${a[mismatch].p}\n`);
  else if (k < N) emit(`ERR QUOTA ${a[k].p}\n`);
  else emit(`OK ${N} ${U + pre[N]}\n`);
}
if (output.length) std.out.puts(output);
