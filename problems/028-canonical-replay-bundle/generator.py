#!/usr/bin/env python3
import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed + index * 911)
b = 10 + index % 10
vals = sorted(r.sample(range(16**8), b))
blobs = [[f"{x:08x}", r.randrange(100), 0] for x in vals]
for x in blobs:
    x[2] = x[1]
refs = sorted(f"{x:08x}" for x in r.sample(vals, r.randrange(b + 1)))
mode = index % 5
if mode == 1 and b > 1:
    blobs[1][0] = blobs[0][0]
if mode == 2:
    blobs[0][2] += 1
if mode == 3 and len(refs) > 1:
    refs[1] = refs[0]
if mode == 4:
    refs.append(f"{r.randrange(16**8):08x}")
    refs.sort()
print(b, len(refs))
[print(*x) for x in blobs]
if refs:
    print(*refs, sep="\n")
