import * as std from "std";
const a = std.in.readAsString().trim().split(/\s+/);
let p = 0,
  n = Number(a[p++]),
  d = Number(a[p++]),
  q = Number(a[p++]),
  cap = BigInt(a[p++]);
/** @type {bigint[]} */
const sz = Array.from({ length: d }, () => BigInt(a[p++]));
const lp = new Int32Array(d),
  ln = new Int32Array(d),
  rh = new Int32Array(d),
  node = new Int32Array(n),
  rp = new Int32Array(n),
  rn = new Int32Array(n),
  cached = new Uint8Array(d);
for (const x of [lp, ln, rh, node, rp, rn]) x.fill(-1);
let head = -1, tail = -1, used = 0n;
/** @type {string[]} */
const out = [];
/** @param {number} x @returns {void} */
const remove = (x) => {
    if (lp[x] >= 0) ln[lp[x]] = ln[x];
    else head = ln[x];
    if (ln[x] >= 0) lp[ln[x]] = lp[x];
    else tail = lp[x];
    lp[x] = ln[x] = -1;
  };
/** @param {number} x @returns {void} */
const touch = (x) => {
    if (cached[x]) remove(x);
    cached[x] = 1;
    lp[x] = tail;
    if (tail >= 0) ln[tail] = x;
    else head = x;
    tail = x;
  };
/** @param {number} u @returns {void} */
const detach = (u) => {
    const x = node[u];
    if (x < 0) return;
    if (rp[u] >= 0) rn[rp[u]] = rn[u];
    else rh[x] = rn[u];
    if (rn[u] >= 0) rp[rn[u]] = rp[u];
    node[u] = rp[u] = rn[u] = -1;
  };
/** @param {number} u @param {number} x @returns {void} */
const attach = (u, x) => {
    node[u] = x;
    rn[u] = rh[x];
    if (rh[x] >= 0) rp[rh[x]] = u;
    rh[x] = u;
    rp[u] = -1;
  };
while (q--) {
  const op = a[p++], u = Number(a[p++]) - 1;
  if (op === "G") {
    if (node[u] < 0) out.push("MISS");
    else {
      const x = node[u];
      touch(x);
      out.push(`HIT ${x + 1}`);
    }
    continue;
  }
  const x = Number(a[p++]) - 1;
  detach(u);
  if (sz[x] > cap) continue;
  if (!cached[x]) used += sz[x];
  touch(x);
  attach(u, x);
  while (used > cap) {
    const dead = head;
    remove(dead);
    cached[dead] = 0;
    used -= sz[dead];
    let v = rh[dead];
    while (v >= 0) {
      const z = rn[v];
      node[v] = rp[v] = rn[v] = -1;
      v = z;
    }
    rh[dead] = -1;
  }
}
std.out.puts(out.join("\n") + "\n");
