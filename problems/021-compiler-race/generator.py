#!/usr/bin/env python3
import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random((seed << 32) ^ index)
n = 20 + index % 31
out = [str(n)]
made = 0
for _ in range(n):
    t = r.randrange(10)
    if t < 6:
        out.append(f"{'B' if t < 4 else 'F'} {chr(97 + r.randrange(8))}")
        made += 1
    elif t < 8:
        out.append("S")
    else:
        out.append(f"D {r.randint(1, max(1, made + 2))}")
print("\n".join(out))
