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

const nodeCount = nextInt(),
  capacity = nextInt();
/** @type {number[][]} */
const children = Array.from({ length: nodeCount + 1 }, () => []),
  size = new Int32Array(nodeCount + 1),
  value = new BigUint64Array(nodeCount + 1);
for (let node = 1; node <= nodeCount; node++) {
  const parent = nextInt();
  size[node] = nextInt();
  value[node] = nextBigInt();
  children[parent].push(node);
}
/** @type {number[]} */
const order = [];
/** @type {number[]} */
const after = [];
/** @param {number} node */
function dfs(node) {
  const position = order.length;
  order.push(node);
  after.push(0);
  for (const child of children[node]) dfs(child);
  after[position] = order.length;
}
for (const root of children[0]) dfs(root);
const width = capacity + 1, dp = new BigUint64Array((nodeCount + 1) * width);
for (let position = nodeCount - 1; position >= 0; position--) {
  const node = order[position],
    row = position * width,
    selectedTail = (position + 1) * width,
    skippedTail = after[position] * width;
  for (let current = 0; current <= capacity; current++) {
    let best = dp[skippedTail + current];
    if (current >= size[node]) {
      const candidate = value[node] + dp[selectedTail + current - size[node]];
      if (candidate > best) best = candidate;
    }
    dp[row + current] = best;
  }
}
std.out.puts(`${dp[capacity]}\n`);
