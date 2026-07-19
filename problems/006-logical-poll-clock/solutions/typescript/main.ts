import * as std from "std";
type Item = [bigint, number];
const input: string = std.in.readAsString();
let cursor = 0;
function nextToken(): string {
  while (cursor < input.length && input.charCodeAt(cursor) <= 32) cursor++;
  const start = cursor;
  while (cursor < input.length && input.charCodeAt(cursor) > 32) cursor++;
  return input.slice(start, cursor);
}
const N = Number(nextToken()),
  h: Item[] = [],
  active: boolean[] = Array(N + 1).fill(false),
  less = (a: Item, b: Item): boolean =>
    a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
function push(x: Item) {
  let i = h.length;
  h.push(x);
  while (i) {
    const q = (i - 1) >> 1;
    if (!less(x, h[q])) break;
    h[i] = h[q];
    i = q;
  }
  h[i] = x;
}
function pop(): Item {
  const r = h[0], x = h.pop() as Item;
  if (h.length) {
    let i = 0;
    while (i * 2 + 1 < h.length) {
      let c = i * 2 + 1;
      if (c + 1 < h.length && less(h[c + 1], h[c])) c++;
      if (!less(h[c], x)) break;
      h[i] = h[c];
      i = c;
    }
    h[i] = x;
  }
  return r;
}
let clock = 0n;
let output = "";
function emit(text: string): void {
  if (text.length >= 65536) {
    if (output.length) std.out.puts(output);
    std.out.puts(text);
    output = "";
    return;
  }
  if (output.length + text.length > 65536) {
    std.out.puts(output);
    output = "";
  }
  output += text;
}
for (let z = 0; z < N; z++) {
  const op = nextToken();
  if (op === "T") {
    const id = Number(nextToken()), d = BigInt(nextToken());
    active[id] = true;
    push([d, id]);
  } else if (op === "C") active[Number(nextToken())] = false;
  else {
    const ready = Number(nextToken());
    while (h.length && !active[h[0][1]]) pop();
    if (ready === 0 && h.length && h[0][0] > clock) clock = h[0][0];
    const f: number[] = [];
    while (h.length && h[0][0] <= clock) {
      const x = pop();
      if (active[x[1]]) {
        active[x[1]] = false;
        f.push(x[1]);
      }
    }
    emit(`${clock} ${ready} ${f.length}`);
    for (const id of f) emit(` ${id}`);
    emit("\n");
  }
}
if (output.length) std.out.puts(output);
