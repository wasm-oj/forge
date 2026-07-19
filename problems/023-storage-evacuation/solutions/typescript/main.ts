import * as std from "std";
type I = { z: bigint; p: number; u: bigint; a: string; k: string };
const t = std.in.readAsString().trim().split(/\s+/);
let q = 0,
  n = +t[q++],
  C = BigInt(t[q++]),
  A = BigInt(t[q++]),
  R = BigInt(t[q++]),
  T = 0n;
const v: I[] = [];
for (let i = 0; i < n; i++) {
  const x: I = {
    z: BigInt(t[q++]),
    p: +t[q++],
    u: BigInt(t[q++]),
    a: t[q++],
    k: t[q++],
  };
  T += x.z;
  v.push(x);
}
let need = T - C;
if (need < 0n) need = 0n;
if (R - A > need) need = R - A;
if (need > T) std.out.puts("IMPOSSIBLE\n");
else {
  v.sort((x, y) =>
    x.p - y.p || (x.u < y.u ? -1 : x.u > y.u ? 1 : 0) ||
    (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) || (x.k < y.k ? -1 : x.k > y.k ? 1 : 0)
  );
  let f = 0n, k = 0;
  while (f < need) f += v[k++].z;
  const out: string[] = [`${k} ${f}`];
  for (let i = 0; i < k; i++) out.push(`${v[i].a} ${v[i].k}`);
  std.out.puts(out.join("\n") + "\n");
}
