#!/usr/bin/env python3
import sys

l = sys.stdin.read().splitlines()
n, C, A, R = map(int, l[0].split())
a = []
for s in l[1:]:
    z, p, u, x, k = s.split()
    a.append([int(z), int(p), int(u), x, k])
need = max(0, sum(x[0] for x in a) - C, R - A)
if need > sum(x[0] for x in a):
    print("IMPOSSIBLE")
    raise SystemExit
out = []
freed = 0
while freed < need:
    best = min(range(len(a)), key=lambda i: (a[i][1], a[i][2], a[i][3], a[i][4]))
    x = a.pop(best)
    out.append((x[3], x[4]))
    freed += x[0]
print(len(out), freed)
for x in out:
    print(*x)
