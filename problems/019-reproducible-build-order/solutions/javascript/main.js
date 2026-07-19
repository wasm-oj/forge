import * as std from "std";
const a = std.in.readAsString().trim().split(/\s+/);
let p = 0,
  n = Number(a[p++]),
  m = Number(a[p++]);
/** @type {string[]} */
const names = Array.from({ length: n }, () => a[p++]);
/** @type {number[]} */
const nameOrder = Array.from({ length: n }, (_, i) => i).sort((x, y) =>
  names[x] < names[y] ? -1 : names[x] > names[y] ? 1 : 0
);
/** @type {number[][]} */
const g = Array.from({ length: n }, () => []);
const deg = new Int32Array(n);
let bad = 0;
/** @param {string} name @returns {number} */
const findId = (name) => {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (names[nameOrder[mid]] < name) lo = mid + 1;
    else hi = mid;
  }
  return lo < n && names[nameOrder[lo]] === name ? nameOrder[lo] : -1;
};
for (let i = 1; i <= m; i++) {
  const x = findId(a[p++]), y = findId(a[p++]);
  if (x < 0 || y < 0) { if (!bad) bad = i; }
  else {
    g[y].push(x);
    deg[x]++;
  }
}
if (bad) std.out.puts(`INVALID DANGLING ${bad}\n`);
else {
  /** @type {number[]} */
  const h = [];
  /** @param {number} x @param {number} y @returns {boolean} */
  const less = (x, y) => names[x] < names[y];
  /** @param {number} x @returns {void} */
  const push = (x) => {
    let i = h.length;
    h.push(x);
    while (i) {
      let q = (i - 1) >> 1;
      if (!less(h[i], h[q])) break;
      [h[i], h[q]] = [h[q], h[i]];
      i = q;
    }
  };
  /** @returns {number} */
  const pop = () => {
    const r = h[0], x = /** @type {number} */ (h.pop());
    if (h.length) {
      h[0] = x;
      for (let i = 0;;) {
        let l = i * 2 + 1, b = i;
        if (l < h.length && less(h[l], h[b])) b = l;
        if (l + 1 < h.length && less(h[l + 1], h[b])) b = l + 1;
        if (b === i) break;
        [h[i], h[b]] = [h[b], h[i]];
        i = b;
      }
    }
    return r;
  };
  for (let i = 0; i < n; i++) if (!deg[i]) push(i);
  /** @type {string[]} */
  const out = [];
  while (h.length) {
    const u = pop();
    out.push(names[u]);
    for (const v of g[u]) if (--deg[v] === 0) push(v);
  }
  std.out.puts(out.length < n ? "INVALID CYCLE\n" : `ORDER ${out.join(" ")}\n`);
}
