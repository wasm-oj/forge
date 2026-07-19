import * as std from "std";
const t = std.in.readAsString().trim().split(/\s+/);
let z = 0,
  a = BigInt(t[z++]),
  b = BigInt(t[z++]),
  S = BigInt(t[z++]),
  q = +t[z++],
  p = 0n;
const M = (1n << 64n) - 1n;
function byte(s: bigint, x: bigint) {
  let v = (s + 0x9e3779b97f4a7c15n * (x / 8n + 1n)) & M;
  v = ((v ^ (v >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
  v = ((v ^ (v >> 27n)) * 0x94d049bb133111ebn) & M;
  v ^= v >> 31n;
  return (v >> (8n * (x % 8n))) & 255n;
}
const at = (x: bigint) => x < S ? byte(a, x) : byte(b, x - S),
  out: string[] = [];
while (q--) {
  const k = BigInt(t[z++]);
  out.push(`${at(p)} ${at(p + k - 1n)}`);
  p += k;
}
std.out.puts(out.join("\n") + "\n");
