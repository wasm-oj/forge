import * as std from "std";
/** @param {string[]} a */
function dedupSorted(a) {
  let size = 0;
  for (const value of a) {
    if (size === 0 || a[size - 1] !== value) a[size++] = value;
  }
  a.length = size;
}
/** @param {string[]} values */
function radixSort(values) {
  /** @type {string[]} */
  const scratch = new Array(values.length);
  for (let position = 29; position >= 0; position--) {
    /** @type {number[]} */
    const next = new Array(257).fill(0);
    for (const value of values) {
      const key = position < value.length ? value.charCodeAt(position) + 1 : 0;
      next[key]++;
    }
    let offset = 0;
    for (let key = 0; key < 257; key++) {
      const count = next[key];
      next[key] = offset;
      offset += count;
    }
    for (const value of values) {
      const key = position < value.length ? value.charCodeAt(position) + 1 : 0;
      scratch[next[key]++] = value;
    }
    for (let i = 0; i < values.length; i++) values[i] = scratch[i];
  }
}
const t = std.in.readAsString().trim().split(/\s+/);
let p = 0, q = +t[p++];
const out = [];
while (q--) {
  const k = t[p++],
    n = +t[p++],
    m = +t[p++],
    eps = k === "FLOAT" ? BigInt(t[p++]) : 0n;
  /** @type {string[]} */
  const a = t.slice(p, p += n);
  /** @type {string[]} */
  const b = t.slice(p, p += m);
  let ok = false;
  if (k === "EXACT") ok = a.join("") === b.join("");
  else if (k === "LINES") {
    while (a[a.length - 1] === "#") a.pop();
    while (b[b.length - 1] === "#") b.pop();
    ok = JSON.stringify(a) === JSON.stringify(b);
  } else if (k === "TOKENS") ok = JSON.stringify(a) === JSON.stringify(b);
  else if (k === "FLOAT") {
    ok = n === m && a.every((x, i) => {
      const d = BigInt(x) - BigInt(b[i]);
      return (d < 0n ? -d : d) <= eps;
    });
  } else {
    radixSort(a);
    radixSort(b);
    if (k === "SET") {
      dedupSorted(a);
      dedupSorted(b);
    }
    ok = JSON.stringify(a) === JSON.stringify(b);
  }
  out.push(ok ? "ACCEPT" : "WRONG");
}
std.out.puts(out.join("\n") + "\n");
