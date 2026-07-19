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

const left = nextInt(), right = nextInt(), edgeCount = nextInt();
const head = new Int32Array(left).fill(-1),
  to = new Int32Array(edgeCount),
  next = new Int32Array(edgeCount);
for (let edge = 0; edge < edgeCount; edge++) {
  const u = nextInt() - 1, v = nextInt() - 1;
  to[edge] = v;
  next[edge] = head[u]!;
  head[u] = edge;
}
const pairLeft = new Int32Array(left).fill(-1),
  pairRight = new Int32Array(right).fill(-1),
  distance = new Int32Array(left),
  queue = new Int32Array(left),
  edgeCursor = new Int32Array(left),
  stackLeft = new Int32Array(left),
  stackRight = new Int32Array(left);
let matching = 0;
for (;;) {
  let front = 0, back = 0, terminal = -1;
  for (let u = 0; u < left; u++) {
    distance[u] = pairLeft[u]! < 0 ? 0 : -1;
    if (pairLeft[u]! < 0) queue[back++] = u;
  }
  while (front < back) {
    const u = queue[front++]!;
    if (terminal >= 0 && distance[u]! >= terminal) continue;
    for (let edge = head[u]!; edge !== -1; edge = next[edge]!) {
      const mate = pairRight[to[edge]!]!;
      if (mate < 0) terminal = distance[u]!;
      else if (distance[mate]! < 0) {
        distance[mate] = distance[u]! + 1;
        queue[back++] = mate;
      }
    }
  }
  if (terminal < 0) break;
  edgeCursor.set(head);
  for (let root = 0; root < left; root++) {
    if (pairLeft[root]! >= 0) continue;
    let leftTop = 1, rightTop = 0, augmented = false;
    stackLeft[0] = root;
    while (leftTop > 0 && !augmented) {
      const u = stackLeft[leftTop - 1]!;
      let descended = false;
      while (edgeCursor[u] !== -1) {
        const edge = edgeCursor[u]!;
        edgeCursor[u] = next[edge]!;
        const v = to[edge]!, mate = pairRight[v]!;
        if (mate < 0 && distance[u] === terminal) {
          pairLeft[u] = v;
          pairRight[v] = u;
          for (let i = rightTop - 1; i >= 0; i--) {
            pairLeft[stackLeft[i]!] = stackRight[i]!;
            pairRight[stackRight[i]!] = stackLeft[i]!;
          }
          augmented = true;
          break;
        }
        if (
          mate >= 0 && distance[u]! < terminal &&
          distance[mate] === distance[u]! + 1
        ) {
          stackRight[rightTop++] = v;
          stackLeft[leftTop++] = mate;
          descended = true;
          break;
        }
      }
      if (!augmented && !descended) {
        distance[u] = -1;
        leftTop--;
        if (rightTop > 0) rightTop--;
      }
    }
    if (augmented) matching++;
  }
}
std.out.puts(`${matching}\n`);
