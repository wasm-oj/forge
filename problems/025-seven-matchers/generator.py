#!/usr/bin/env python3
import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed + index * 17)
kinds = ["EXACT", "LINES", "TOKENS", "FLOAT", "SET", "MULTISET", "FILESET"]
q = 7
print(q)
for qi, k in enumerate(kinds):
    n = r.randrange(8)
    m = n if r.randrange(3) else r.randrange(8)
    eps = r.randrange(5)
    print(k, n, m, eps) if k == "FLOAT" else print(k, n, m)
    if k == "FLOAT":
        e = [str(r.randrange(-20, 21)) for _ in range(n)]
        a = [str(int(e[i]) + r.randrange(-6, 7)) for i in range(min(n, m))] + [
            str(r.randrange(20)) for _ in range(max(0, m - n))
        ]
    elif k == "FILESET":
        e = [f"p{i}@{r.randrange(16**8):08x}" for i in range(n)]
        if m == n and r.randrange(2):
            a = e.copy()
            r.shuffle(a)
        else:
            a = [f"q{i}@{r.randrange(16**8):08x}" for i in range(m)]
    else:
        pool = ["a", "b", "c", "#", "xy"]
        e = [r.choice(pool) for _ in range(n)]
        a = e[:m] + [r.choice(pool) for _ in range(max(0, m - n))]
        r.shuffle(a) if k in ("SET", "MULTISET") else None
    print(*e)
    print(*a)
