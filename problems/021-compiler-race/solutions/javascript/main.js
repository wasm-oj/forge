import * as std from "std";
/** @typedef {{ key: string, epoch: number, kind: string, alive: boolean }} Job */
const x = std.in.readAsString().trim().split(/\s+/);
let p = 0, n = Number(x[p++]), epoch = 0, bg = 0;
/** @type {Map<string, number>} */
const by = new Map();
/** @type {(Job | null)[]} */
const jobs = [null];
/** @type {string[]} */
const out = [];
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
      live = j && j.alive && (j.kind === "F" || j.epoch === epoch);
    if (!live) out.push("STALE");
    else {
      const activeJob = /** @type {Job} */ (j);
      activeJob.alive = false;
      if (activeJob.kind === "B") bg--;
      if (by.get(activeJob.key) === i) by.delete(activeJob.key);
      out.push("DONE");
    }
  }
}
std.out.puts(out.join("\n") + "\n");
