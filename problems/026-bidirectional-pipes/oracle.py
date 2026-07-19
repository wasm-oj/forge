#!/usr/bin/env python3
import sys

l = sys.stdin.read().splitlines()
C, na, nb = map(int, l[0].split())
acts = [l[1 : 1 + na], l[1 + na :]]
pc = [0, 0]
occ = [[], []]
closed = [na == 0, nb == 0]
steps = 0


def one(who):
    global steps
    if pc[who] == len(acts[who]):
        return "skip"
    p = acts[who][pc[who]].split()
    other = 1 - who
    if p[0] == "W":
        k = int(p[1])
        if len(occ[who]) + k > C:
            return "block"
        occ[who].extend([0] * k)
    elif p[0] == "R":
        k = int(p[1])
        if len(occ[other]) < k:
            return "fail" if closed[other] else "block"
        del occ[other][:k]
    else:
        closed[who] = True
    pc[who] += 1
    steps += 1
    if pc[who] == len(acts[who]):
        closed[who] = True
    return "done"


while True:
    if pc[0] == na and pc[1] == nb:
        print("SUCCESS", steps, len(occ[0]), len(occ[1]))
        break
    progress = False
    for w in (0, 1):
        z = one(w)
        if z == "fail":
            print("FAIL", "A" if w == 0 else "B", steps, len(occ[0]), len(occ[1]))
            raise SystemExit
        progress |= z == "done"
    if not progress:
        print("DEADLOCK", steps, len(occ[0]), len(occ[1]))
        break
