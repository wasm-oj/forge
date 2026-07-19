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
const N = Number(nextToken()), Q = Number(nextToken()), C = BigInt(nextToken());
const pi = /** @type {bigint[]} */ (Array(N + 1).fill(0n)),
  pm = /** @type {bigint[]} */ (Array(N + 1).fill(0n)),
  bad = /** @type {boolean[]} */ (Array(N + 2).fill(false)),
  nxt = /** @type {number[]} */ (Array(N + 2).fill(N + 1));
for (let i = 1; i <= N; i++) {
  const k = Number(nextToken()),
    x = BigInt(nextToken()),
    ms = nextToken(),
    m = ms === "-1" ? null : BigInt(ms);
  bad[i] = k === 64 || x > C || (m !== null && m < x);
  pi[i] = pi[i - 1];
  pm[i] = pm[i - 1];
  if (!bad[i]) {
    pi[i] += x;
    pm[i] += m === null ? C : (m < C ? m : C);
  }
}
for (let i = N; i >= 1; i--) nxt[i] = bad[i] ? i : nxt[i + 1];
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
  const l = Number(nextToken()), r = Number(nextToken());
  emit(
    nxt[l] <= r
      ? `REJECT ${nxt[l]}\n`
      : `ACCEPT ${(pi[r] - pi[l - 1]) * 65536n} ${
        (pm[r] - pm[l - 1]) * 65536n
      }\n`,
  );
}
if (output.length) std.out.puts(output);
