#!/usr/bin/env python3
import random, sys

seed, index = map(int, sys.argv[1:])
r = random.Random(seed ^ (index << 16))
q = 15 + index % 20
k = [r.randint(1, 96) for _ in range(q)]
total = sum(k)
mode = index % 6
if mode == 0:
    S = 0
elif mode == 1:
    S = total + 17
elif mode == 2:
    S = 1
elif mode == 3:
    S = total
elif mode == 4:
    mid = q // 2
    S = sum(k[:mid]) + k[mid] // 2
else:
    S = r.randrange(total + 1)
startup_seed = 2**64 - 1 if index % 8 == 0 else r.randrange(2**64)
user_seed = 0 if index % 8 == 0 else r.randrange(2**64)
print(startup_seed, user_seed, S, q)
print(*k)
