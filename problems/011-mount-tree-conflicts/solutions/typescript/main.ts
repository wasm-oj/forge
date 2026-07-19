import * as std from "std";

function main(): void {
  const input: string = std.in.readAsString();
  const tokens: string[] = input.trim().split(/\s+/);
  const n: number = Number(tokens[0]);
  const infinity: number = n + 1;
  const capacity: number = input.length + 1;
  const firstChild = new Int32Array(capacity);
  const nextSibling = new Int32Array(capacity);
  const exactMin = new Int32Array(capacity);
  const fileMin = new Int32Array(capacity);
  const descMin = new Int32Array(capacity);
  const nodeChar = new Uint8Array(capacity);
  let nodeCount = 1;

  const findOrCreateChild = (parent: number, ch: number): number => {
    for (let child = firstChild[parent]; child !== 0; child = nextSibling[child]) {
      if (nodeChar[child] === ch) return child;
    }
    const child = nodeCount++;
    firstChild[child] = 0;
    nextSibling[child] = firstChild[parent];
    exactMin[child] = infinity;
    fileMin[child] = infinity;
    descMin[child] = infinity;
    nodeChar[child] = ch;
    firstChild[parent] = child;
    return child;
  };

  let tokenAt = 1;
  for (let j = 1; j <= n; j++) {
    const kind = tokens[tokenAt++];
    const path = tokens[tokenAt++];
    let current = 0;
    let best = infinity;

    for (let position = 0; position < path.length; position++) {
      current = findOrCreateChild(current, path.charCodeAt(position));
      if (
        position + 1 < path.length &&
        (position === 0 || path[position + 1] === "/")
      ) {
        best = Math.min(best, fileMin[current]);
      }
    }
    best = Math.min(best, exactMin[current]);
    if (kind === "F") best = Math.min(best, descMin[current]);

    if (best !== infinity) {
      std.out.puts(`CONFLICT ${best} ${j}\n`);
      return;
    }

    current = 0;
    for (let position = 0; position < path.length; position++) {
      current = findOrCreateChild(current, path.charCodeAt(position));
      if (
        position + 1 < path.length &&
        (position === 0 || path[position + 1] === "/")
      ) {
        descMin[current] = Math.min(descMin[current], j);
      }
    }
    exactMin[current] = Math.min(exactMin[current], j);
    if (kind === "F") fileMin[current] = Math.min(fileMin[current], j);
  }

  std.out.puts("VALID\n");
}

main();
