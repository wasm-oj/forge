import * as std from "std";
const input: string = std.in.readAsString();
let cursor = 0;
function nextToken(): string {
  while (cursor < input.length && input.charCodeAt(cursor) <= 32) cursor++;
  const start = cursor;
  while (cursor < input.length && input.charCodeAt(cursor) > 32) cursor++;
  return input.slice(start, cursor);
}
const N = Number(nextToken()),
  Q = Number(nextToken()),
  s: string[] = [],
  a: bigint[] = [];
for (let z = 0; z < N; z++) {
  s.push(nextToken());
  a.push(BigInt(nextToken()));
}
let i = 0, used = 0n;
const c: bigint[] = [0n, 0n, 0n],
  key = (x: string): number => x === "O" ? 0 : x === "E" ? 1 : 2;
let output = "";
function emit(line: string): void {
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
  const d: bigint[] = [...c];
  let fail = 0;
  if (i < N) {
    fail = i + 1;
    d[key(s[i])] += b - used;
  }
  emit(`${fail} ${d[0]} ${d[1]} ${d[2]}\n`);
}
if (output.length) std.out.puts(output);
