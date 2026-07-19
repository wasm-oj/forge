#!/usr/bin/env python3
import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed * 1000003 + index)
n = 25 + index % 25
next_id = 1
known = []
out = [str(n)]
for _ in range(n):
    t = r.randrange(10)
    if t < 5:
        x = next_id
        next_id += 1
        known.append(x)
        out.append(f"A {x}")
    elif t < 8:
        out.append(
            f"C {r.choice(known) if known and r.randrange(4) else next_id+r.randrange(5)}"
        )
    else:
        out.append("E")
print("\n".join(out))
