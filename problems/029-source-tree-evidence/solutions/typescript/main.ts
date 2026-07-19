import * as std from "std";
const l = std.in.readAsString().trimEnd().split(/\r?\n/),
  h = l[0].split(" "),
  n = +h[0],
  e = h[1],
  a: [string, string][] = [];
for (let i = 1; i <= n; i++) {
  const p = l[i].split(" ")[1];
  if (p !== e && !p.startsWith(e + "/")) a.push([p, l[i]]);
}
a.sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0);
std.out.puts([`${a.length}`, ...a.map((x) => x[1])].join("\n") + "\n");
