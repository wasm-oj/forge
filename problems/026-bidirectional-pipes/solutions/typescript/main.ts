import * as std from "std";
type Act = [string, bigint];
const x = std.in.readAsString().trim().split(/\s+/);
let p = 0, C = BigInt(x[p++]);
const n = [+x[p++], +x[p++]], a: Act[][] = [[], []];
for (let w = 0; w < 2; w++) {
  for (let i = 0; i < n[w]; i++) {
    const t = x[p++];
    a[w].push([t, t === "C" ? 0n : BigInt(x[p++])]);
  }
}
const pc = [0, 0], closed = [n[0] === 0, n[1] === 0], occ = [0n, 0n];
let steps = 0n, result = "";
outer: for (;;) {
  if (pc[0] === n[0] && pc[1] === n[1]) {
    result = `SUCCESS ${steps} ${occ[0]} ${occ[1]}`;
    break;
  }
  let progress = false;
  for (let w = 0; w < 2; w++) {
    if (pc[w] === n[w]) continue;
    const [t, k] = a[w][pc[w]], o = 1 - w;
    let z = 0;
    if (t === "W") {
      if (C - occ[w] >= k) {
        occ[w] += k;
        z = 1;
      }
    } else if (t === "R") {
      if (occ[o] >= k) {
        occ[o] -= k;
        z = 1;
      } else if (closed[o]) z = -1;
    } else {
      closed[w] = true;
      z = 1;
    }
    if (z < 0) {
      result = `FAIL ${"AB"[w]} ${steps} ${occ[0]} ${occ[1]}`;
      break outer;
    }
    if (z) {
      pc[w]++;
      steps++;
      progress = true;
      if (pc[w] === n[w]) closed[w] = true;
    }
  }
  if (!progress) {
    result = `DEADLOCK ${steps} ${occ[0]} ${occ[1]}`;
    break;
  }
}
std.out.puts(result + "\n");
