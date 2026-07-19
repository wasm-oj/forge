import * as std from "std";
const a: number[] = std.in.readAsString().trim().split(/\s+/).map(Number);
let p = 0, n = a[p++], m = a[p++], c = a[p++];
const g: number[][] = Array.from({ length: n }, () => []);
while (m--) {
  const u = a[p++] - 1, v = a[p++] - 1;
  g[u].push(v);
}
const d: Uint8Array = new Uint8Array(n), q: number[] = [];
while (c--) {
  const x = a[p++] - 1;
  if (!d[x]) {
    d[x] = 1;
    q.push(x);
  }
}
for (let h = 0; h < q.length; h++) {
  for (const v of g[q[h]]) {
    if (!d[v]) {
      d[v] = 1;
      q.push(v);
    }
  }
}
const ids: number[] = [];
for (let i = 0; i < n; i++) if (d[i]) ids.push(i + 1);
std.out.puts(`${ids.length}\n${ids.join(" ")}\n`);
