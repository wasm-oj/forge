#!/usr/bin/env python3
import sys

it = iter(sys.stdin.read().splitlines())
n = int(next(it))
jobs = []
out = []
for line in it:
    p = line.split()
    t = p[0]
    if t in ("B", "F"):
        found = None
        for i, j in enumerate(jobs):
            if j[0] == p[1] and j[2]:
                found = i + 1
        if found is None:
            jobs.append([p[1], t, True])
            out.append(f"NEW {len(jobs)}")
        else:
            out.append(f"JOIN {found}")
    elif t == "S":
        k = 0
        for j in jobs:
            if j[1] == "B" and j[2]:
                j[2] = False
                k += 1
        out.append(f"CANCEL {k}")
    else:
        x = int(p[1]) - 1
        if 0 <= x < len(jobs) and jobs[x][2]:
            jobs[x][2] = False
            out.append("DONE")
        else:
            out.append("STALE")
print("\n".join(out))
