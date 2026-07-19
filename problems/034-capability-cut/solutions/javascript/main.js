import * as std from "std";
/** @typedef {{ to: number, rev: number, cap: bigint }} Edge */
const input = std.in.readAsString();
let scan = 0;
function nextInt() {
  while (scan < input.length && input.charCodeAt(scan) <= 32) scan++;
  let value = 0;
  while (scan < input.length) {
    const digit = input.charCodeAt(scan) - 48;
    if (digit < 0 || digit > 9) break;
    value = value * 10 + digit;
    scan++;
  }
  return value;
}
function nextBigInt() {
  while (scan < input.length && input.charCodeAt(scan) <= 32) scan++;
  const start = scan;
  while (scan < input.length) {
    const code = input.charCodeAt(scan);
    if (code < 48 || code > 57) break;
    scan++;
  }
  return BigInt(input.slice(start, scan));
}
let n = nextInt(),
  m = nextInt(),
  sn = nextInt(),
  tn = nextInt();
/** @type {bigint[]} */
const c = Array.from({ length: n }, () => nextBigInt());
/** @type {number[]} */
const en = Array.from({ length: sn }, () => nextInt() - 1);
/** @type {number[]} */
const dn = Array.from({ length: tn }, () => nextInt() - 1);
const V = 2 * n + 2,
  S = 2 * n,
  T = S + 1;
/** @type {Edge[][]} */
const g = Array.from({ length: V }, () => []);
/**
 * @param {number} u
 * @param {number} v
 * @param {bigint} z
 */
const add = (u, v, z) => {
  g[u].push({ to: v, rev: g[v].length, cap: z });
  g[v].push({ to: u, rev: g[u].length - 1, cap: 0n });
};
const inf = c.reduce((x, y) => x + y, 1n);
for (let i = 0; i < n; i++) add(2 * i, 2 * i + 1, c[i]);
while (m--) {
  const u = nextInt() - 1, v = nextInt() - 1;
  add(2 * u + 1, 2 * v, inf);
}
for (const u of en) add(S, 2 * u, inf);
for (const u of dn) add(2 * u + 1, T, inf);
let flow = 0n;
for (;;) {
  const level = new Int32Array(V).fill(-1), q = [S];
  level[S] = 0;
  for (let h = 0; h < q.length; h++) {
    const u = q[h];
    for (const e of g[u]) {
      if (e.cap > 0n && level[e.to] < 0) {
        level[e.to] = level[u] + 1;
        q.push(e.to);
      }
    }
  }
  if (level[T] < 0) break;
  const it = new Int32Array(V);
  /**
   * @param {number} u
   * @param {bigint} f
   * @returns {bigint}
   */
  const dfs = (u, f) => {
    if (u === T) return f;
    while (it[u] < g[u].length) {
      const e = g[u][it[u]];
      if (e.cap > 0n && level[e.to] === level[u] + 1) {
        const z = dfs(e.to, f < e.cap ? f : e.cap);
        if (z > 0n) {
          e.cap -= z;
          g[e.to][e.rev].cap += z;
          return z;
        }
      }
      it[u]++;
    }
    return 0n;
  };
  for (;;) {
    const z = dfs(S, inf);
    if (z === 0n) break;
    flow += z;
  }
}
std.out.puts(`COST ${flow}\n`);
