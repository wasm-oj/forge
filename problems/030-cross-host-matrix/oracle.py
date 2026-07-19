#!/usr/bin/env python3
import sys

l = sys.stdin.read().splitlines()
at = 0
H = int(l[at])
at += 1
hosts = []
for _ in range(H):
    name, K = l[at].split()
    at += 1
    cs = []
    for _ in range(int(K)):
        cid, t, P = l[at].split()
        at += 1
        fs = {}
        for _ in range(int(P)):
            p, v = l[at].split()
            at += 1
            fs[p] = v
        cs.append((cid, int(t), fs))
    hosts.append((name, cs))
base = hosts[0][1]
allok = True
for name, cs in hosts[1:]:
    if [x[0] for x in cs] != [x[0] for x in base]:
        print("HOST", name, "CASE_ORDER")
        allok = False
        continue
    d = []
    for x, y in zip(base, cs):
        for p in sorted(set(x[2]) | set(y[2])):
            if x[2].get(p) != y[2].get(p):
                d.append(x[0] + "." + p)
    if d:
        print("HOST", name, len(d), *d)
        allok = False
    else:
        print("HOST", name, "OK")
if allok:
    for i, x in enumerate(base):
        z = sorted(h[1][i][1] for h in hosts)
        print("MEDIAN", x[0], z[(H - 1) // 2])
