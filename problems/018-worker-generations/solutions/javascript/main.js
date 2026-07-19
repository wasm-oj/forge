import * as std from "std";
const a = std.in.readAsString().trim().split(/\s+/);
let p = 0,
  n = Number(a[p++]),
  b = BigInt(a[p++]),
  used = 0n,
  gen = 0,
  reject = 0,
  cur = null,
  out = [];
while (n--) {
  const f = a[p++], s = BigInt(a[p++]);
  if (s === 0n) {
    out.push("CACHE");
    continue;
  }
  if (s > 8n || s > b) {
    out.push("REJECT");
    reject++;
    continue;
  }
  if (cur !== f || used + s > b) {
    cur = f;
    used = 0n;
    gen++;
  }
  used += s;
  out.push(`WORKER ${gen}`);
}
out.push(`SUMMARY ${gen} ${reject}`);
std.out.puts(out.join("\n") + "\n");
