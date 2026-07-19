#!/usr/bin/env python3
import sys

l = sys.stdin.read().splitlines()
b, r = map(int, l[0].split())
blobs = []
for s in l[1 : 1 + b]:
    d, x, y = s.split()
    blobs.append((d, int(x), int(y)))
refs = l[1 + b :]
for i in range(1, b):
    if blobs[i][0] <= blobs[i - 1][0]:
        print("INVALID BLOB_ORDER", i + 1)
        raise SystemExit
for i, x in enumerate(blobs):
    if x[1] != x[2]:
        print("INVALID LENGTH", i + 1)
        raise SystemExit
for i in range(1, r):
    if refs[i] <= refs[i - 1]:
        print("INVALID REF_ORDER", i + 1)
        raise SystemExit
total = 0
for i, d in enumerate(refs):
    hit = next((x for x in blobs if x[0] == d), None)
    if hit is None:
        print("INVALID MISSING", i + 1)
        raise SystemExit
    total += hit[2]
print("VALID", total)
