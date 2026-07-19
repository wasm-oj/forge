import * as std from "std";
const input: string = std.in.readAsString();
let cursor = 0;
function nextToken(): string {
  while (cursor < input.length && input.charCodeAt(cursor) <= 32) cursor++;
  const start = cursor;
  while (cursor < input.length && input.charCodeAt(cursor) > 32) cursor++;
  return input.slice(start, cursor);
}
const P = Number(nextToken()),
  S = Number(nextToken()),
  N = Number(nextToken()),
  Q = Number(nextToken());
const c: number[] = Array(P + 1).fill(0),
  lo: (bigint | null)[] = Array(P + 1).fill(null),
  hi: bigint[] = Array(P + 1).fill(0n);
for (let i = 0; i < N; i++) {
  const p = Number(nextToken());
  nextToken();
  const v = BigInt(nextToken());
  c[p]++;
  if (lo[p] === null || v < (lo[p] as bigint)) lo[p] = v;
  if (v > hi[p]) hi[p] = v;
}
let output = "";
function emit(line: string): void {
  if (output.length + line.length > 65536) {
    std.out.puts(output);
    output = "";
  }
  output += line;
}
for (let i = 0; i < Q; i++) {
  const p = Number(nextToken()), raw = BigInt(nextToken());
  if (c[p] !== S || lo[p] !== hi[p]) emit("INVALID\n");
  else {
    const b = lo[p] as bigint;
    emit(`${b} ${raw > b ? raw - b : 0n}\n`);
  }
}
if (output.length) std.out.puts(output);
