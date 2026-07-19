import * as std from "std";
const z = std.in.readAsString().trim().split(/\s+/);
let p = 0, n = Number(z[p++]);
/** @type {[string, string, string][]} */
const a = [];
for (let i = 0; i < n; i++) a.push([z[p++], z[p++], z[p++]]);
a.sort((x, y) => x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0);
/** @param {number} x @param {number} w @returns {string} */
const num = (x, w) => x.toString(16).padStart(w, "0");
/** @param {string} s @returns {string} */
const ascii = (s) => Array.from(s, (c) => num(c.charCodeAt(0), 2)).join("");
const out = ["574f424a", num(n, 8)];
for (const [t, path, v] of a) {
  const len = v === "-" ? 0 : t === "T" ? v.length : v.length / 2;
  out.push(
    t === "T" ? "01" : "02",
    num(path.length, 8),
    ascii(path),
    num(len, 16),
    len === 0 ? "" : t === "T" ? ascii(v) : v,
  );
}
std.out.puts(out.join("") + "\n");
