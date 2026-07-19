#!/usr/bin/env python3
import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed * 97 + index)
n = 12 + index % 15
q = 15 + index % 20
print(n, q)
for _ in range(n):
    v = 0 if r.randrange(4) else r.randint(1, 3)
    x = [-1 if r.randrange(8) == 0 else r.randrange(100) for _ in range(4)]
    print(v, *x)
for _ in range(q):
    a = r.randint(1, n)
    b = r.randint(a, n)
    print(a, b, r.randrange(2))
