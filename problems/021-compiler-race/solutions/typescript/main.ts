import * as std from "std";
type Job = { key: string; epoch: number; kind: string; alive: boolean };
const x = std.in.readAsString().trim().split(/\s+/);
let p = 0, n = Number(x[p++]), epoch = 0, bg = 0;
const by = new Map<string, number>(),
  jobs: (Job | null)[] = [null],
  out: string[] = [];
while (n--) {
  const t = x[p++];
  if (t === "B" || t === "F") {
    const k = x[p++],
      i = by.get(k) || 0,
      j = jobs[i],
      live = !!j && j.alive && (j.kind === "F" || j.epoch === epoch);
    if (live) out.push(`JOIN ${i}`);
    else {
      const id = jobs.length;
      jobs.push({ key: k, epoch, kind: t, alive: true });
      by.set(k, id);
      if (t === "B") bg++;
      out.push(`NEW ${id}`);
    }
  } else if (t === "S") {
    out.push(`CANCEL ${bg}`);
    bg = 0;
    epoch++;
  } else {
    const i = Number(x[p++]),
      j = jobs[i],
      live = !!j && j.alive && (j.kind === "F" || j.epoch === epoch);
    if (!live) out.push("STALE");
    else {
      j!.alive = false;
      if (j!.kind === "B") bg--;
      if (by.get(j!.key) === i) by.delete(j!.key);
      out.push("DONE");
    }
  }
}
std.out.puts(out.join("\n") + "\n");
