#!/usr/bin/env python3
import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed * 101 + index)
H = 3 + index % 3
C = 4 + index % 5
base = []
for c in range(C):
    base.append(
        [f"c{c}", r.randrange(100), [(f"p{j}", f"v{r.randrange(6)}") for j in range(4)]]
    )
print(H)
for h in range(H):
    cur = [[x, r.randrange(100), list(fs)] for x, _, fs in base]
    mode = index % 5
    if h and mode == 1 and h == H - 1:
        cur.reverse()
    elif h and mode == 2 and h == H - 1:
        cur[0][2][0] = (cur[0][2][0][0], "changed")
    elif h and mode == 3 and h == H - 1:
        cur[0][2].pop(0)
    elif h and mode == 4 and h == H - 1:
        cur[0][2].append(("z", "added"))
    print(f"h{h}", len(cur))
    for cid, tm, fs in cur:
        print(cid, tm, len(fs))
        [print(*x) for x in fs]
