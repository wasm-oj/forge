import * as std from "std";
const input: string = std.in.readAsString();
let cursor = 0;
function nextToken(): string {
  while (cursor < input.length && input.charCodeAt(cursor) <= 32) cursor++;
  const start = cursor;
  while (cursor < input.length && input.charCodeAt(cursor) > 32) cursor++;
  return input.slice(start, cursor);
}
const K = Number(nextToken()),
  W = Number(nextToken()),
  R = Number(nextToken()),
  Q = Number(nextToken());
const w: bigint[] = Array(K + 1).fill(1000n);
for (let i = 0; i < W; i++) {
  const id = Number(nextToken());
  w[id] = BigInt(nextToken());
}
const pc: bigint[] = [0n],
  pn: bigint[] = [0n],
  rw: bigint[] = [],
  rc: bigint[] = [];
for (let i = 0; i < R; i++) {
  const id = Number(nextToken()), c = BigInt(nextToken());
  rw.push(w[id]);
  rc.push(c);
  pc.push(pc[i] + w[id] * c);
  pn.push(pn[i] + c);
}
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
  let lo = 0, hi = R + 1;
  while (lo + 1 < hi) {
    const m = (lo + hi) >> 1;
    if (pc[m] <= b) lo = m;
    else hi = m;
  }
  let done = pn[lo], cost = pc[lo];
  if (lo < R) {
    let take = (b - cost) / rw[lo];
    if (take > rc[lo]) take = rc[lo];
    done += take;
    cost += take * rw[lo];
  }
  emit(`${done} ${cost}\n`);
}
if (output.length) std.out.puts(output);
