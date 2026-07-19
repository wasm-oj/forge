import * as std from "std";

const input: string = std.in.readAsString();
let scan = 0;
function nextInt(): number {
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

const n = nextInt(), m = nextInt();
const edgeFrom = new Int32Array(m),
  edgeTo = new Int32Array(m),
  head = new Int32Array(n).fill(-1),
  reverseHead = new Int32Array(n).fill(-1),
  to = new Int32Array(m),
  reverseTo = new Int32Array(m),
  next = new Int32Array(m),
  reverseNext = new Int32Array(m),
  selfLoop = new Uint8Array(n);
for (let edge = 0; edge < m; edge++) {
  const u = nextInt() - 1, v = nextInt() - 1;
  edgeFrom[edge] = u;
  edgeTo[edge] = v;
  to[edge] = v;
  next[edge] = head[u]!;
  head[u] = edge;
  reverseTo[edge] = u;
  reverseNext[edge] = reverseHead[v]!;
  reverseHead[v] = edge;
  if (u === v) selfLoop[u] = 1;
}

const seen = new Uint8Array(n),
  iterator = new Int32Array(head),
  stack = new Int32Array(n),
  order = new Int32Array(n);
let orderSize = 0;
for (let root = 0; root < n; root++) {
  if (seen[root]) continue;
  let top = 1;
  stack[0] = root;
  seen[root] = 1;
  while (top > 0) {
    const u = stack[top - 1]!, edge = iterator[u]!;
    if (edge !== -1) {
      iterator[u] = next[edge]!;
      const v = to[edge]!;
      if (!seen[v]) {
        seen[v] = 1;
        stack[top++] = v;
      }
    } else {
      order[orderSize++] = u;
      top--;
    }
  }
}

const component = new Int32Array(n).fill(-1);
let componentCount = 0;
for (let index = n - 1; index >= 0; index--) {
  const root = order[index]!;
  if (component[root] !== -1) continue;
  let top = 1;
  stack[0] = root;
  component[root] = componentCount;
  while (top > 0) {
    const u = stack[--top]!;
    for (let edge = reverseHead[u]!; edge !== -1; edge = reverseNext[edge]!) {
      const v = reverseTo[edge]!;
      if (component[v] === -1) {
        component[v] = componentCount;
        stack[top++] = v;
      }
    }
  }
  componentCount++;
}

const componentHead = new Int32Array(componentCount).fill(-1),
  memberNext = new Int32Array(n).fill(-1),
  componentSize = new Int32Array(componentCount),
  indegree = new Uint8Array(componentCount);
for (let node = n - 1; node >= 0; node--) {
  const id = component[node]!;
  memberNext[node] = componentHead[id]!;
  componentHead[id] = node;
  componentSize[id]!++;
}
for (let edge = 0; edge < m; edge++) {
  const from = component[edgeFrom[edge]!]!, target = component[edgeTo[edge]!]!;
  if (from !== target) indegree[target] = 1;
}
let groups = 0, wakes = 0;
for (let id = 0; id < componentCount; id++) {
  if (!indegree[id]) wakes++;
  if (componentSize[id]! > 1 || selfLoop[componentHead[id]!]) groups++;
}
let output = `${groups} ${wakes}\n`;
for (let node = 0; node < n; node++) {
  const id = component[node]!;
  if (
    componentHead[id] !== node || !(componentSize[id]! > 1 || selfLoop[node])
  ) continue;
  output += `${componentSize[id]}`;
  for (
    let member = componentHead[id]!;
    member !== -1;
    member = memberNext[member]!
  ) {
    output += ` ${member + 1}`;
  }
  output += "\n";
  if (output.length >= 1 << 20) {
    std.out.puts(output);
    output = "";
  }
}
if (output.length) std.out.puts(output);
