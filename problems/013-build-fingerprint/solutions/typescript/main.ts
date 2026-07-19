import * as std from "std";
const a: string[] = std.in.readAsString().trim().split(/\s+/);
let p = 0, n = Number(a[p++]), q = Number(a[p++]);
const f: [string, string][] = [];
for (let i = 0; i < n; i++) f.push([a[p++], a[p++]]);
let output = "";
const emit = (text: string): void => {
  if (output.length + text.length > 65536) {
    std.out.puts(output);
    output = "";
  }
  output += text;
};
while (q--) {
  const m: string[] = [a[p++], a[p++], a[p++], a[p++]],
    k = Number(a[p++]),
    v: number[] = [];
  for (let i = 0; i < k; i++) v.push(Number(a[p++]) - 1);
  v.sort((x, y) => f[x][0] < f[y][0] ? -1 : f[x][0] > f[y][0] ? 1 : 0);
  emit(`${m[0]} ${m[1]} ${m[2]} ${m[3]} ${k}`);
  for (const x of v) emit(` ${f[x][0]} ${f[x][1]}`);
  emit("\n");
}
if (output.length) std.out.puts(output);
