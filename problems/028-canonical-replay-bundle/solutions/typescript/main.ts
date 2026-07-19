import * as std from "std";
type B = [string, bigint, bigint];
const t = std.in.readAsString().trim().split(/\s+/);
let p = 0, n = +t[p++], r = +t[p++];
const a: B[] = [];
for (let i = 0; i < n; i++) a.push([t[p++], BigInt(t[p++]), BigInt(t[p++])]);
const q = t.slice(p, p + r);
let ans = "";
for (let i = 1; i < n && !ans; i++) {
  if (a[i][0] <= a[i - 1][0]) ans = `INVALID BLOB_ORDER ${i + 1}`;
}
for (let i = 0; i < n && !ans; i++) {
  if (a[i][1] !== a[i][2]) ans = `INVALID LENGTH ${i + 1}`;
}
for (let i = 1; i < r && !ans; i++) {
  if (q[i] <= q[i - 1]) ans = `INVALID REF_ORDER ${i + 1}`;
}
let j = 0;
for (let i = 0; i < r && !ans; i++) {
  while (j < n && a[j][0] < q[i]) j++;
  if (j === n || a[j][0] !== q[i]) ans = `INVALID MISSING ${i + 1}`;
  else j++;
}
let total = 0n;
if (!ans) {
  j = 0;
  for (let i = 0; i < r; i++) {
    while (a[j][0] < q[i]) j++;
    total += a[j++][2];
  }
}
std.out.puts((ans || `VALID ${total}`) + "\n");
