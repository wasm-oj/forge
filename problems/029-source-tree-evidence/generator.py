#!/usr/bin/env python3
import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed - index * 37)
n = 15 + index % 20
E = "evidence"
rows = []
for i in range(n):
    path = (E + "/" if r.randrange(5) == 0 else "src/") + f"p{i}"
    t = r.randrange(3)
    if t == 0:
        rows.append(
            f"F {path} {r.randrange(2)} {r.randrange(1000)} {r.randrange(16**8):08x}"
        )
    elif t == 1:
        rows.append(f"L {path} target/{i}")
    else:
        rows.append(f"D {path}")
r.shuffle(rows)
print(n, E)
print(*rows, sep="\n")
