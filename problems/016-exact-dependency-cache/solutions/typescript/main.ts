import * as std from "std";
const a: number[] = std.in.readAsString().trim().split(/\s+/).map(Number);
let p = 0, n = a[p++], h = a[p++], m = a[p++], q = a[p++], w = (n + 31) >> 5;
const b: Uint32Array = new Uint32Array(h * w);
while (m--) {
  const s = a[p++] - 1, x = a[p++] - 1;
  b[x * w + (s >>> 5)] |= 1 << (s & 31);
}
const pop = (v: number): number => {
    v >>>= 0;
    v -= v >>> 1 & 0x55555555;
    v = (v & 0x33333333) + (v >>> 2 & 0x33333333);
    return ((v + (v >>> 4) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  },
  out: string[] = [];
while (q--) {
  const v = new Uint32Array(w), k = a[p++];
  for (let i = 0; i < k; i++) {
    const x = a[p++] - 1, o = x * w;
    for (let j = 0; j < w; j++) v[j] |= b[o + j];
  }
  let ans = 0;
  for (const x of v) ans += pop(x);
  out.push(String(ans));
}
std.out.puts(out.join("\n") + "\n");
