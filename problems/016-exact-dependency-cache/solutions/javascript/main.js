import * as std from "std";
const a = std.in.readAsString().trim().split(/\s+/).map(Number);
let p = 0,
  n = a[p++],
  h = a[p++],
  m = a[p++],
  q = a[p++],
  w = (n + 31) >> 5,
  b = new Uint32Array(h * w);
while (m--) {
  const s = a[p++] - 1, x = a[p++] - 1;
  b[x * w + (s >>> 5)] |= 1 << (s & 31);
}
/** @param {number} x @returns {number} */
const pop = (x) => {
    x >>>= 0;
    x -= x >>> 1 & 0x55555555;
    x = (x & 0x33333333) + (x >>> 2 & 0x33333333);
    return ((x + (x >>> 4) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };
/** @type {string[]} */
const out = [];
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
