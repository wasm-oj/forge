import * as std from "std";
const t = std.in.readAsString().trim().split(/\s+/);
let p = 0, H = +t[p++];
const h = [];
for (let z = 0; z < H; z++) {
  const name = t[p++], K = +t[p++], cs = [];
  for (let i = 0; i < K; i++) {
    const id = t[p++], tm = BigInt(t[p++]), P = +t[p++], f = [];
    for (let j = 0; j < P; j++) f.push([t[p++], t[p++]]);
    cs.push({ id, tm, f });
  }
  h.push({ name, cs });
}
const base = h[0].cs, out = [];
let all = true;
for (let z = 1; z < H; z++) {
  const cs = h[z].cs,
    order = cs.length !== base.length || cs.some((x, i) => x.id !== base[i].id);
  if (order) {
    out.push(`HOST ${h[z].name} CASE_ORDER`);
    all = false;
    continue;
  }
  const d = [];
  for (let i = 0; i < base.length; i++) {
    const a = base[i], b = cs[i];
    let x = 0, y = 0;
    while (x < a.f.length || y < b.f.length) {
      if (y === b.f.length || (x < a.f.length && a.f[x][0] < b.f[y][0])) {
        d.push(`${a.id}.${a.f[x++][0]}`);
      } else if (x === a.f.length || a.f[x][0] > b.f[y][0]) {
        d.push(`${a.id}.${b.f[y++][0]}`);
      } else {
        if (a.f[x][1] !== b.f[y][1]) d.push(`${a.id}.${a.f[x][0]}`);
        x++;
        y++;
      }
    }
  }
  if (d.length) {
    out.push(`HOST ${h[z].name} ${d.length} ${d.join(" ")}`);
    all = false;
  } else out.push(`HOST ${h[z].name} OK`);
}
if (all) {
  for (let i = 0; i < base.length; i++) {
    const v = h.map((x) => x.cs[i].tm).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    out.push(`MEDIAN ${base[i].id} ${v[(H - 1) >> 1]}`);
  }
}
std.out.puts(out.join("\n") + "\n");
