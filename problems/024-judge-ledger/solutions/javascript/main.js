import * as std from "std";
const x = std.in.readAsString().trim().split(/\s+/);
let p = 0, n = +x[p++], q = +x[p++], b = 1;
while (b < n) b *= 2;
const bad = Array(n + 2).fill(0),
  nb = Array(n + 2).fill(n + 1),
  u = Array.from({ length: 4 }, () => Array(n + 1).fill(0)),
  s = Array.from({ length: 2 }, () => Array(n + 1).fill(0n)),
  tm = Array(2 * b).fill(0n),
  tv = Array(2 * b).fill(0n);
for (let i = 1; i <= n; i++) {
  bad[i] = +x[p++];
  const a = [0, 1, 2, 3].map(() => BigInt(x[p++]));
  for (let j = 0; j < 4; j++) u[j][i] = u[j][i - 1] + (a[j] < 0n ? 1 : 0);
  for (let j = 0; j < 2; j++) s[j][i] = s[j][i - 1] + (a[j] < 0n ? 0n : a[j]);
  tm[b + i - 1] = a[2] < 0n ? 0n : a[2];
  tv[b + i - 1] = a[3] < 0n ? 0n : a[3];
}
for (let i = b - 1; i; i--) {
  tm[i] = tm[2 * i] > tm[2 * i + 1] ? tm[2 * i] : tm[2 * i + 1];
  tv[i] = tv[2 * i] > tv[2 * i + 1] ? tv[2 * i] : tv[2 * i + 1];
}
for (let i = n; i; i--) nb[i] = bad[i] ? i : nb[i + 1];
/**
 * @param {bigint[]} t
 * @param {number} l
 * @param {number} r
 * @returns {bigint}
 */
function rmq(t, l, r) {
  l += b - 1;
  r += b - 1;
  let z = 0n;
  while (l <= r) {
    if (l & 1) {
      if (t[l] > z) z = t[l];
      l++;
    }
    if (!(r & 1)) {
      if (t[r] > z) z = t[r];
      r--;
    }
    l >>= 1;
    r >>= 1;
  }
  return z;
}
const out = [];
while (q--) {
  const l = +x[p++],
    r = +x[p++],
    f = +x[p++],
    e = f && nb[l] <= r ? nb[l] : r,
    z = [`${e - l + 1}`, `${nb[l] <= e ? bad[nb[l]] : 0}`];
  for (let j = 0; j < 2; j++) {
    z.push(u[j][e] > u[j][l - 1] ? "null" : `${s[j][e] - s[j][l - 1]}`);
  }
  for (let j = 2; j < 4; j++) {
    z.push(u[j][e] > u[j][l - 1] ? "null" : `${rmq(j === 2 ? tm : tv, l, e)}`);
  }
  out.push(z.join(" "));
}
std.out.puts(out.join("\n") + "\n");
