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
  N = Number(nextToken()),
  B = BigInt(nextToken()),
  I = Number(nextToken()),
  a: (bigint | null)[] = Array(P + 1).fill(null);
let used = 0n, ino = 0, peakB = 0n, peakI = 0, sticky = 0;
let output = "";
function emit(line: string): void {
  if (output.length + line.length > 65536) {
    std.out.puts(output);
    output = "";
  }
  output += line;
}
for (let z = 0; z < N; z++) {
  const op = nextToken(), x = Number(nextToken());
  let err: string | null = null;
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
      used -= a[x] as bigint;
      a[x] = null;
      ino--;
    }
  } else {
    let v: bigint;
    if (op === "WRITE") {
      const off = BigInt(nextToken()),
        len = BigInt(nextToken()),
        old = a[x] ?? 0n;
      v = len === 0n ? old : (old > off + len ? old : off + len);
    } else v = BigInt(nextToken());
    if (a[x] === null) err = "NOENT";
    else {
      const old = a[x] as bigint;
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
