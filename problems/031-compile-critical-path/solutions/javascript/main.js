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
const duration = new BigUint64Array(n);
for (let i = 0; i < n; i++) duration[i] = nextBigInt();
const head = new Int32Array(n).fill(-1),
  to = new Int32Array(m),
  next = new Int32Array(m),
  indegree = new Int32Array(n),
  outdegree = new Int32Array(n);
for (let edge = 0; edge < m; edge++) {
  const u = nextInt() - 1, v = nextInt() - 1;
  to[edge] = v;
  next[edge] = head[u];
  head[u] = edge;
  indegree[v]++;
  outdegree[u]++;
}
const MOD = 1_000_000_007;
const best = new BigUint64Array(n),
  ways = new Uint32Array(n),
  queue = new Int32Array(n);
let front = 0, back = 0;
for (let node = 0; node < n; node++) {
  if (indegree[node] === 0) {
    best[node] = duration[node];
    ways[node] = 1;
    queue[back++] = node;
  }
}
while (front < back) {
  const node = queue[front++];
  for (let edge = head[node]; edge !== -1; edge = next[edge]) {
    const target = to[edge], candidate = best[node] + duration[target];
    if (candidate > best[target]) {
      best[target] = candidate;
      ways[target] = ways[node];
    } else if (candidate === best[target]) {
      ways[target] = (ways[target] + ways[node]) % MOD;
    }
    indegree[target]--;
    if (indegree[target] === 0) queue[back++] = target;
  }
}
let answer = -1n, count = 0;
for (let node = 0; node < n; node++) {
  if (outdegree[node] !== 0) continue;
  if (best[node] > answer) {
    answer = best[node];
    count = ways[node];
  } else if (best[node] === answer) {
    count = (count + ways[node]) % MOD;
  }
}
std.out.puts(`${answer} ${count}\n`);
