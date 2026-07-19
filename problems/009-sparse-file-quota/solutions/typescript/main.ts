import * as std from "std";
const input: string = std.in.readAsString();
let cursor = 0;
function nextToken(): string {
  while (cursor < input.length && input.charCodeAt(cursor) <= 32) cursor++;
  const start = cursor;
  while (cursor < input.length && input.charCodeAt(cursor) > 32) cursor++;
  return input.slice(start, cursor);
}
const F = Number(nextToken()),
  N = Number(nextToken()),
  B = BigInt(nextToken()),
  size: bigint[] = Array(F + 1).fill(0n),
  cur: bigint[] = Array(F + 1).fill(0n);
let output = "";
function emit(line: string): void {
  if (output.length + line.length > 65536) {
    std.out.puts(output);
    output = "";
  }
  output += line;
}
let used = 0n, peak = 0n;
for (let z = 0; z < N; z++) {
  const op = nextToken(), x = Number(nextToken()), v = BigInt(nextToken());
  let err = false;
  if (op === "SEEK") cur[x] = v;
  else {
    const ns = op === "WRITE"
      ? (v === 0n ? size[x] : (size[x] > cur[x] + v ? size[x] : cur[x] + v))
      : v;
    if (ns > size[x] && ns - size[x] > B - used) err = true;
    else {
      used += ns - size[x];
      size[x] = ns;
      if (op === "WRITE" && v > 0n) cur[x] += v;
    }
  }
  if (used > peak) peak = used;
  emit(`${err ? "ERR QUOTA" : "OK"} ${size[x]} ${cur[x]} ${used}\n`);
}
emit(`SUMMARY ${used} ${peak}\n`);
if (output.length) std.out.puts(output);
