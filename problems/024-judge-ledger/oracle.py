#!/usr/bin/env python3
import sys

it = iter(sys.stdin.read().splitlines())
n, q = map(int, next(it).split())
a = [list(map(int, next(it).split())) for _ in range(n)]
for _ in range(q):
    l, r, f = map(int, next(it).split())
    rows = []
    for row in a[l - 1 : r]:
        rows.append(row)
        if f and row[0]:
            break
    verdict = next((x[0] for x in rows if x[0]), 0)
    vals = []
    for j in range(1, 5):
        z = [x[j] for x in rows]
        vals.append("null" if -1 in z else str(sum(z) if j < 3 else max(z)))
    print(len(rows), verdict, *vals)
