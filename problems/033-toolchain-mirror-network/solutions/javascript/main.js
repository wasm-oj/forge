import * as std from "std";

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

const n = nextInt(), m = nextInt();
const ENDPOINT_BITS = 18n, ENDPOINT_MASK = (1n << ENDPOINT_BITS) - 1n;
const edges = new Array(m);
for (let i = 0; i < m; i++) {
  const u = nextInt() - 1, v = nextInt() - 1, cost = nextBigInt();
  edges[i] = (cost << (2n * ENDPOINT_BITS)) | (BigInt(u) << ENDPOINT_BITS) |
    BigInt(v);
}
edges.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const parent = new Int32Array(n), size = new Int32Array(n).fill(1);
for (let i = 0; i < n; i++) parent[i] = i;
/** @param {number} start @returns {number} */
function find(start) {
  let root = start;
  while (parent[root] !== root) root = parent[root];
  let node = start;
  while (parent[node] !== node) {
    const nextNode = parent[node];
    parent[node] = root;
    node = nextNode;
  }
  return root;
}
let total = 0n, taken = 0;
for (const packed of edges) {
  const v = Number(packed & ENDPOINT_MASK),
    u = Number((packed >> ENDPOINT_BITS) & ENDPOINT_MASK),
    cost = packed >> (2n * ENDPOINT_BITS);
  let left = find(u), right = find(v);
  if (left === right) continue;
  if (size[left] < size[right]) [left, right] = [right, left];
  parent[right] = left;
  size[left] += size[right];
  total += cost;
  if (++taken === n - 1) break;
}
std.out.puts(taken === n - 1 ? `COST ${total}\n` : "IMPOSSIBLE\n");
