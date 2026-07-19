#!/usr/bin/env python3
import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed ^ index * 0x9E3779B1)
n = 8 + index % 13
items = []
for i in range(n):
    items.append(
        (r.randint(1, 30), r.randrange(4), r.randrange(100), f"p{i%5}", f"k{i}")
    )
t = sum(x[0] for x in items)
C = r.randrange(t + 20)
A = r.randrange(80)
R = r.randrange(100)
print(n, C, A, R)
for x in items:
    print(*x)
