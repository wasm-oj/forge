import random
import sys


if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")

seed = int(sys.argv[1])
index = int(sys.argv[2])
if index == 999_999:
    n, k = 200_000, 50_000
    fingerprints = [format(position % k + 1, "x") for position in range(n)]
    print(n, k)
    print(*fingerprints)
    raise SystemExit(0)

rng = random.Random((seed << 32) ^ index)
n = rng.randint(1, min(40, 9 + index % 32))
k = 0 if index % 7 == 0 else rng.randint(0, n)
pool_size = rng.randint(1, min(n, 3 + index % 13))
pool = []
used = set()
while len(pool) < pool_size:
    width = rng.randint(1, 8)
    token = "".join(rng.choice("0123456789abcdef") for _ in range(width))
    if token not in used:
        used.add(token)
        pool.append(token)

fingerprints = []
for position in range(n):
    if position < pool_size:
        fingerprints.append(pool[position])
    elif rng.random() < 0.75:
        fingerprints.append(rng.choice(pool))
    else:
        value = ((seed + 1) * 1_000_003 + index * 101 + position) & ((1 << 64) - 1)
        token = format(value, "x")
        fingerprints.append(token)

print(n, k)
print(*fingerprints)
