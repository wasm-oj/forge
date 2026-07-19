import * as std from "std";
/** @typedef {[string, bigint]} R */
const a = std.in.readAsString().trim().split(/\s+/);
let p = 0,
  n = Number(a[p++]),
  m = Number(a[p++]);
/** @type {R[]} */
const lock = [];
/** @type {R[]} */
const pay = [];
let total = 0n;
for (let i = 0; i < n; i++) {
  p++;
  const d = a[p++], z = BigInt(a[p++]);
  lock.push([d, z]);
  total += z;
}
for (let i = 0; i < m; i++) pay.push([a[p++], BigInt(a[p++])]);
lock.sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0);
pay.sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0);
/** @type {R[]} */
const req = [];
/** @type {string | null} */
let out = null;
for (let i = 0; i < n;) {
  let j = i + 1;
  while (j < n && lock[j][0] === lock[i][0]) {
    if (lock[j][1] !== lock[i][1]) out = `LOCK_CONFLICT ${lock[i][0]}`;
    j++;
  }
  req.push(lock[i]);
  if (out) break;
  i = j;
}
if (!out) {
  for (let i = 1; i < m; i++) {
    if (pay[i][0] === pay[i - 1][0]) {
      out = `DUPLICATE_PAYLOAD ${pay[i][0]}`;
      break;
    }
  }
}
let unique = 0n;
if (!out) {
  let i = 0, j = 0;
  /** @type {string | null} */
  let missing = null;
  /** @type {string | null} */
  let extra = null;
  /** @type {string | null} */
  let sizeError = null;
  while (i < req.length || j < pay.length) {
    if (j === pay.length || i < req.length && req[i][0] < pay[j][0]) {
      if (missing === null) missing = req[i][0];
      i++;
    } else if (i === req.length || pay[j][0] < req[i][0]) {
      if (extra === null) extra = pay[j][0];
      j++;
    } else {
      if (req[i][1] !== pay[j][1] && sizeError === null) sizeError = req[i][0];
      i++;
      j++;
    }
  }
  if (missing !== null) out = `MISSING ${missing}`;
  else if (extra !== null) out = `EXTRA ${extra}`;
  else if (sizeError !== null) out = `SIZE ${sizeError}`;
  else for (const [, z] of req) unique += z;
}
if (!out) out = `VALID ${req.length} ${unique} ${total - unique}`;
std.out.puts(out + "\n");
