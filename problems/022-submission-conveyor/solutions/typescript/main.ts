import * as std from "std";
const a = std.in.readAsString().trim().split(/\s+/);
let p = 0, n = +a[p++], active = 0, waiting = 0, head = 0;
const state = new Map<number, number>(), q: number[] = [], out: string[] = [];
while (n--) {
  const t = a[p++];
  if (t === "A") {
    const x = +a[p++];
    if (!active) {
      active = x;
      state.set(x, 2);
    } else {
      state.set(x, 1);
      q.push(x);
      waiting++;
    }
  } else if (t === "C") {
    const x = +a[p++];
    if (state.get(x) === 1) {
      state.set(x, 3);
      waiting--;
    } else if (state.get(x) === 2) {
      state.set(x, 3);
      active = 0;
    }
  } else if (active) {
    state.set(active, 3);
    active = 0;
  }
  while (!active && head < q.length) {
    const x = q[head++];
    if (state.get(x) === 1) {
      state.set(x, 2);
      active = x;
      waiting--;
      break;
    }
  }
  out.push(`${active} ${waiting}`);
}
std.out.puts(out.join("\n") + "\n");
